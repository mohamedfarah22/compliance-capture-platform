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
    useAuth.mockReturnValue({ session: null, staffMember: null, loading: false })
    renderProtectedRoute()

    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Protected content' })).not.toBeInTheDocument()
  })

  it('renders children when the user has an active session', () => {
    useAuth.mockReturnValue({
      session: { user: { id: 'user-1' } },
      staffMember: { role: 'staff' },
      loading: false,
    })
    renderProtectedRoute()

    expect(screen.getByRole('heading', { name: 'Protected content' })).toBeInTheDocument()
  })
})
