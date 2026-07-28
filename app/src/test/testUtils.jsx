import { render } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { vi } from 'vitest'

// Default mock shape for useAuth() — override per test via makeAuthValue({...}).
// Each page test file must `vi.mock('<relative path to>/context/AuthContext.js
// x', () => ({ useAuth: vi.fn() }))` itself (vi.mock is hoisted per-file, so it
// can't be centralized here), then call `useAuth.mockReturnValue(makeAuthValue())`.
export function makeAuthValue(overrides = {}) {
  return {
    session: { user: { id: 'user-1' } },
    staffMember: {
      id: 'staff-1',
      full_name: 'Jane Staff',
      email: 'jane@example.com',
      reporting_entity_id: 're-1',
      role: 'staff',
      job_title: 'Compliance Officer',
    },
    reportingEntity: {
      legal_name: 'Test Bullion Pty Ltd',
      trading_name: 'Test Bullion',
      abn: '12345678901',
      acn: '',
      austrac_account_number: '123456789',
      idv_max_reliance_days: 730,
      idv_block_on_expired: false,
    },
    aal: { currentLevel: 'aal2', nextLevel: 'aal2' },
    refreshAal: vi.fn(),
    canApproveReports: false,
    loading: false,
    signOut: vi.fn(),
    ...overrides,
  }
}

// Renders `element` at `path` inside a MemoryRouter, with optional sibling
// routes (e.g. placeholder headings) to assert on navigation.
export function renderWithRoute({ path, element, initialEntries, otherRoutes = {} }) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <Routes>
        <Route path={path} element={element} />
        {Object.entries(otherRoutes).map(([p, el]) => (
          <Route key={p} path={p} element={el} />
        ))}
      </Routes>
    </MemoryRouter>
  )
}
