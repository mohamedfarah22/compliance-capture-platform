import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import ReviewBatchPage from './ReviewBatchPage.jsx'
import { supabase } from '../../lib/supabase.js'
import { useAuth } from '../../context/AuthContext.jsx'

vi.mock('../../lib/supabase.js', () => ({
  supabase: { schema: vi.fn() },
}))

vi.mock('../../context/AuthContext.jsx', () => ({
  useAuth: vi.fn(),
}))

const BATCH = {
  id: 'batch-1',
  report_date: '2026-07-17',
  transaction_count: 2,
  status: 'pending_review',
  generated_at: '2026-07-17T13:00:00Z',
  approval_token: 'valid-token',
}

let batchSelectColumns

function wireSupabase() {
  const batchBuilder = {
    select: vi.fn((cols) => {
      batchSelectColumns = cols
      return batchBuilder
    }),
    eq: vi.fn(() => batchBuilder),
    single: vi.fn(() => Promise.resolve({ data: BATCH, error: null })),
  }
  const linksBuilder = {
    select: vi.fn(() => linksBuilder),
    eq: vi.fn(() => Promise.resolve({ data: [], error: null })),
  }
  supabase.schema.mockReturnValue({
    from: vi.fn((table) => (table === 'report_batches' ? batchBuilder : linksBuilder)),
  })
}

// Intercepts only the <a> the download handler creates; every other tag must
// still produce a real node or React cannot render.
function stubDownloadAnchor() {
  const click = vi.fn()
  const realCreateElement = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation((tag, ...rest) =>
    tag === 'a' ? { click, set href(_v) {}, set download(_v) {} } : realCreateElement(tag, ...rest)
  )
  return click
}

function renderPage(token = 'valid-token') {
  return render(
    <MemoryRouter initialEntries={[`/review-batch/batch-1?token=${token}`]}>
      <Routes>
        <Route path="/review-batch/:batchId" element={<ReviewBatchPage />} />
      </Routes>
    </MemoryRouter>
  )
}

describe('ReviewBatchPage', () => {
  beforeEach(() => {
    batchSelectColumns = ''
    wireSupabase()
    useAuth.mockReturnValue({ session: { access_token: 'tok' } })
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:url'), revokeObjectURL: vi.fn() })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('does not load xml_content when rendering the page — the report XML reaches the browser only on an audited export', async () => {
    renderPage()

    await screen.findByRole('button', { name: /download xml/i })
    expect(batchSelectColumns).not.toContain('xml_content')
  })

  it('requests the XML through the audited download action rather than reading it from already-loaded state', async () => {
    const user = userEvent.setup()
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, xmlContent: '<xml/>', fileName: 'ttr-fbs-2026-07-17.xml' }),
    })
    const click = stubDownloadAnchor()

    renderPage()
    await user.click(await screen.findByRole('button', { name: /download xml/i }))

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled())
    const [url, options] = globalThis.fetch.mock.calls[0]
    expect(url).toContain('/approve-batch')
    expect(JSON.parse(options.body)).toMatchObject({ batchId: 'batch-1', action: 'download' })
    expect(click).toHaveBeenCalled()
  })

  it('surfaces an error and downloads nothing when the export cannot be recorded', async () => {
    const user = userEvent.setup()
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'Failed to record export' }),
    })
    const click = stubDownloadAnchor()

    renderPage()
    await user.click(await screen.findByRole('button', { name: /download xml/i }))

    expect(await screen.findByText('Failed to record export')).toBeInTheDocument()
    expect(click).not.toHaveBeenCalled()
  })

  it('still allows download without a valid approval token — logging the export must not tighten who can export', async () => {
    const user = userEvent.setup()
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, xmlContent: '<xml/>', fileName: 'ttr-fbs-2026-07-17.xml' }),
    })
    stubDownloadAnchor()

    renderPage('wrong-token')
    const downloadButton = await screen.findByRole('button', { name: /download xml/i })
    expect(downloadButton).toBeEnabled()

    await user.click(downloadButton)
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled())
  })
})
