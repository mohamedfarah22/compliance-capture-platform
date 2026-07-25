import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import MfaGatePage from './MfaGatePage.jsx'
import { supabase } from '../../lib/supabase.js'
import { useAuth } from '../../context/AuthContext.jsx'

vi.mock('../../lib/supabase.js', () => ({
  supabase: {
    auth: {
      mfa: {
        listFactors: vi.fn(),
        enroll: vi.fn(),
        challenge: vi.fn(),
        verify: vi.fn(),
        challengeAndVerify: vi.fn(),
      },
    },
  },
}))

vi.mock('../../context/AuthContext.jsx', () => ({
  useAuth: vi.fn(),
}))

const refreshAal = vi.fn()

function renderMfaPage(initialEntry = '/mfa') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/mfa" element={<MfaGatePage />} />
        <Route path="/login" element={<h1>Sign in</h1>} />
        <Route path="/start" element={<h1>Start Transaction</h1>} />
        <Route path="/reports" element={<h1>Reports</h1>} />
      </Routes>
    </MemoryRouter>
  )
}

describe('MfaGatePage', () => {
  beforeEach(() => {
    useAuth.mockReturnValue({ session: { user: { id: 'user-1' } }, loading: false, refreshAal })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('redirects to /login when there is no session', () => {
    useAuth.mockReturnValue({ session: null, loading: false, refreshAal })
    supabase.auth.mfa.listFactors.mockResolvedValue({ data: { totp: [] }, error: null })

    renderMfaPage()

    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
  })

  it('shows the enrollment QR code when no verified factor exists', async () => {
    supabase.auth.mfa.listFactors.mockResolvedValue({ data: { totp: [] }, error: null })
    supabase.auth.mfa.enroll.mockResolvedValue({
      data: { id: 'factor-1', totp: { qr_code: 'data:image/svg+xml;base64,abc', secret: 'SECRET123' } },
      error: null,
    })

    renderMfaPage()

    expect(await screen.findByRole('img', { name: /scan this qr code/i })).toBeInTheDocument()
    expect(screen.getByText(/SECRET123/)).toBeInTheDocument()
    expect(supabase.auth.mfa.enroll).toHaveBeenCalledWith({
      factorType: 'totp',
      issuer: 'Compliance Capture Platform',
    })
  })

  it('skips enrollment and challenges directly when a verified factor exists', async () => {
    supabase.auth.mfa.listFactors.mockResolvedValue({
      data: { totp: [{ id: 'factor-1', status: 'verified' }] },
      error: null,
    })

    renderMfaPage()

    expect(await screen.findByLabelText(/6-digit code/i)).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: /scan this qr code/i })).not.toBeInTheDocument()
    expect(supabase.auth.mfa.enroll).not.toHaveBeenCalled()
  })

  it('verifies an enrollment code and navigates to the redirect target', async () => {
    const user = userEvent.setup()
    supabase.auth.mfa.listFactors.mockResolvedValue({ data: { totp: [] }, error: null })
    supabase.auth.mfa.enroll.mockResolvedValue({
      data: { id: 'factor-1', totp: { qr_code: 'data:image/svg+xml;base64,abc', secret: 'SECRET123' } },
      error: null,
    })
    supabase.auth.mfa.challenge.mockResolvedValue({ data: { id: 'challenge-1' }, error: null })
    supabase.auth.mfa.verify.mockResolvedValue({ error: null })

    renderMfaPage('/mfa?redirect=%2Freports')

    await user.type(await screen.findByLabelText(/6-digit code/i), '123456')
    await user.click(screen.getByRole('button', { name: /verify/i }))

    await waitFor(() => {
      expect(supabase.auth.mfa.verify).toHaveBeenCalledWith({
        factorId: 'factor-1',
        challengeId: 'challenge-1',
        code: '123456',
      })
    })
    expect(refreshAal).toHaveBeenCalled()
    expect(await screen.findByRole('heading', { name: 'Reports' })).toBeInTheDocument()
  })

  it('verifies a challenge code for an already-enrolled factor', async () => {
    const user = userEvent.setup()
    supabase.auth.mfa.listFactors.mockResolvedValue({
      data: { totp: [{ id: 'factor-1', status: 'verified' }] },
      error: null,
    })
    supabase.auth.mfa.challengeAndVerify.mockResolvedValue({ error: null })

    renderMfaPage()

    await user.type(await screen.findByLabelText(/6-digit code/i), '654321')
    await user.click(screen.getByRole('button', { name: /verify/i }))

    await waitFor(() => {
      expect(supabase.auth.mfa.challengeAndVerify).toHaveBeenCalledWith({ factorId: 'factor-1', code: '654321' })
    })
    expect(await screen.findByRole('heading', { name: 'Start Transaction' })).toBeInTheDocument()
  })

  it('shows an error and stays on the page when the code is invalid', async () => {
    const user = userEvent.setup()
    supabase.auth.mfa.listFactors.mockResolvedValue({
      data: { totp: [{ id: 'factor-1', status: 'verified' }] },
      error: null,
    })
    supabase.auth.mfa.challengeAndVerify.mockResolvedValue({ error: { message: 'Invalid TOTP code entered' } })

    renderMfaPage()

    await user.type(await screen.findByLabelText(/6-digit code/i), '000000')
    await user.click(screen.getByRole('button', { name: /verify/i }))

    expect(await screen.findByText(/invalid code/i)).toBeInTheDocument()
    expect(refreshAal).not.toHaveBeenCalled()
    expect(screen.queryByRole('heading', { name: 'Start Transaction' })).not.toBeInTheDocument()
  })
})
