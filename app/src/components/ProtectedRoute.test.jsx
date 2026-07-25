import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import ProtectedRoute from './ProtectedRoute.jsx'
import { useAuth } from '../context/AuthContext.jsx'

vi.mock('../context/AuthContext.jsx', () => ({
  useAuth: vi.fn(),
}))

function renderProtectedRoute({ requiredRole } = {}) {
  return render(
    <MemoryRouter initialEntries={['/start']}>
      <Routes>
        <Route path="/login" element={<h1>Sign in</h1>} />
        <Route path="/mfa" element={<h1>Two-factor</h1>} />
        <Route
          path="/start"
          element={
            <ProtectedRoute requiredRole={requiredRole}>
              <h1>Protected content</h1>
            </ProtectedRoute>
          }
        />
      </Routes>
    </MemoryRouter>
  )
}

describe('ProtectedRoute', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('redirects an unauthenticated user to /login', () => {
    useAuth.mockReturnValue({ session: null, staffMember: null, aal: { currentLevel: null }, loading: false })
    renderProtectedRoute()

    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Protected content' })).not.toBeInTheDocument()
  })

  it('renders children when the user has an active session at aal2', () => {
    useAuth.mockReturnValue({
      session: { user: { id: 'user-1' } },
      staffMember: { role: 'staff' },
      aal: { currentLevel: 'aal2', nextLevel: 'aal2' },
      loading: false,
    })
    renderProtectedRoute()

    expect(screen.getByRole('heading', { name: 'Protected content' })).toBeInTheDocument()
  })

  it('redirects a session that has not satisfied MFA to /mfa', () => {
    useAuth.mockReturnValue({
      session: { user: { id: 'user-1' } },
      staffMember: { role: 'staff' },
      aal: { currentLevel: 'aal1', nextLevel: 'aal2' },
      loading: false,
    })
    renderProtectedRoute()

    expect(screen.getByRole('heading', { name: 'Two-factor' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Protected content' })).not.toBeInTheDocument()
  })

  it('redirects a session with no enrolled factor to /mfa', () => {
    useAuth.mockReturnValue({
      session: { user: { id: 'user-1' } },
      staffMember: { role: 'staff' },
      aal: { currentLevel: 'aal1', nextLevel: 'aal1' },
      loading: false,
    })
    renderProtectedRoute()

    expect(screen.getByRole('heading', { name: 'Two-factor' })).toBeInTheDocument()
  })
})
