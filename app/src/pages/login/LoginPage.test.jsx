import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, Navigate, useSearchParams } from 'react-router-dom'
import LoginPage from './LoginPage.jsx'
import { supabase } from '../../lib/supabase.js'
import { useAuth } from '../../context/AuthContext.jsx'

vi.mock('../../lib/supabase.js', () => ({
  supabase: {
    auth: {
      signInWithPassword: vi.fn(),
    },
  },
}))

vi.mock('../../context/AuthContext.jsx', () => ({
  useAuth: vi.fn(),
}))

// Surfaces the redirect the MFA step was handed, so it can be asserted on.
function MfaProbe() {
  const [params] = useSearchParams()
  return (
    <>
      <h1>Two-factor</h1>
      <p data-testid="mfa-redirect">{params.get('redirect') ?? ''}</p>
    </>
  )
}

function renderLoginPage(entry = '/login') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/mfa" element={<MfaProbe />} />
        <Route path="/reports" element={<h1>Reports</h1>} />
        <Route path="/start" element={<Navigate to="/" replace />} />
        <Route path="/" element={<h1>Start Transaction</h1>} />
      </Routes>
    </MemoryRouter>
  )
}

describe('LoginPage', () => {
  beforeEach(() => {
    useAuth.mockReturnValue({ session: null, loading: false, aal: { currentLevel: null } })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders login form with email and password fields', () => {
    renderLoginPage()

    expect(screen.getByLabelText(/email address/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument()
  })

  it('displays an error message when invalid credentials are submitted', async () => {
    const user = userEvent.setup()
    supabase.auth.signInWithPassword.mockResolvedValue({ error: { message: 'Invalid login credentials' } })
    renderLoginPage()

    await user.type(screen.getByLabelText(/email address/i), 'wrong@example.com')
    await user.type(screen.getByLabelText(/password/i), 'wrongpassword')
    await user.click(screen.getByRole('button', { name: /sign in/i }))

    expect(await screen.findByText('Invalid email or password.')).toBeInTheDocument()
  })

  it('calls supabase.auth.signInWithPassword with the entered email and password', async () => {
    const user = userEvent.setup()
    supabase.auth.signInWithPassword.mockResolvedValue({ error: null })
    renderLoginPage()

    await user.type(screen.getByLabelText(/email address/i), 'staff@example.com')
    await user.type(screen.getByLabelText(/password/i), 'correct-password')
    await user.click(screen.getByRole('button', { name: /sign in/i }))

    await waitFor(() => {
      expect(supabase.auth.signInWithPassword).toHaveBeenCalledWith({
        email: 'staff@example.com',
        password: 'correct-password',
      })
    })
  })

  it('sends the user to the second factor after a correct password — a password alone only reaches aal1', async () => {
    const user = userEvent.setup()
    supabase.auth.signInWithPassword.mockResolvedValue({ error: null })
    renderLoginPage()

    await user.type(screen.getByLabelText(/email address/i), 'staff@example.com')
    await user.type(screen.getByLabelText(/password/i), 'correct-password')
    await user.click(screen.getByRole('button', { name: /sign in/i }))

    // Going straight to a protected route here would trip ProtectedRoute's
    // partial-session check and sign the user back out.
    expect(await screen.findByRole('heading', { name: 'Two-factor' })).toBeInTheDocument()
  })

  it('carries the originally requested page through the second factor', async () => {
    const user = userEvent.setup()
    supabase.auth.signInWithPassword.mockResolvedValue({ error: null })
    renderLoginPage('/login?redirect=%2Freports')

    await user.type(screen.getByLabelText(/email address/i), 'staff@example.com')
    await user.type(screen.getByLabelText(/password/i), 'correct-password')
    await user.click(screen.getByRole('button', { name: /sign in/i }))

    await screen.findByRole('heading', { name: 'Two-factor' })
    // Without this the user would land on /start after MFA, not the page they asked for.
    expect(screen.getByTestId('mfa-redirect')).toHaveTextContent('/reports')
  })

  it('sends an already fully-authenticated visitor straight through, not back to the second factor', () => {
    useAuth.mockReturnValue({
      session: { user: { id: 'user-1' } },
      loading: false,
      aal: { currentLevel: 'aal2' },
    })
    renderLoginPage()

    expect(screen.getByRole('heading', { name: 'Start Transaction' })).toBeInTheDocument()
  })

  it('sends a visitor who still owes a second factor to the code entry', () => {
    useAuth.mockReturnValue({
      session: { user: { id: 'user-1' } },
      loading: false,
      aal: { currentLevel: 'aal1' },
    })
    renderLoginPage()

    expect(screen.getByRole('heading', { name: 'Two-factor' })).toBeInTheDocument()
  })
})
