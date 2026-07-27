import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
  let signOut

  beforeEach(() => {
    signOut = vi.fn()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('redirects an unauthenticated user to /login', () => {
    useAuth.mockReturnValue({ session: null, staffMember: null, aal: { currentLevel: null }, loading: false, signOut })
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
      signOut,
    })
    renderProtectedRoute()

    expect(screen.getByRole('heading', { name: 'Protected content' })).toBeInTheDocument()
    expect(signOut).not.toHaveBeenCalled()
  })

  it('ends a password-only session and returns it to sign-in rather than offering the code entry', () => {
    useAuth.mockReturnValue({
      session: { user: { id: 'user-1' } },
      staffMember: { role: 'staff' },
      aal: { currentLevel: 'aal1', nextLevel: 'aal2' },
      loading: false,
      signOut,
    })
    renderProtectedRoute()

    expect(signOut).toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Protected content' })).not.toBeInTheDocument()
  })

  it('does the same for a session that has never enrolled a factor', () => {
    useAuth.mockReturnValue({
      session: { user: { id: 'user-1' } },
      staffMember: { role: 'staff' },
      aal: { currentLevel: 'aal1', nextLevel: 'aal1' },
      loading: false,
      signOut,
    })
    renderProtectedRoute()

    expect(signOut).toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
  })

  it('does not sign anyone out while the assurance level is still being resolved', () => {
    // AuthContext sets the session before refreshAal() resolves. Acting on that
    // window would log every user out on every page load.
    useAuth.mockReturnValue({
      session: { user: { id: 'user-1' } },
      staffMember: null,
      aal: { currentLevel: null, nextLevel: null },
      loading: true,
      signOut,
    })
    renderProtectedRoute()

    expect(signOut).not.toHaveBeenCalled()
    expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument()
  })
})
