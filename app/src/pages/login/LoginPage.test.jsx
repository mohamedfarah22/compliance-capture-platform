import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, Navigate } from 'react-router-dom'
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

function renderLoginPage() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/start" element={<Navigate to="/" replace />} />
        <Route path="/" element={<h1>Start Transaction</h1>} />
      </Routes>
    </MemoryRouter>
  )
}

describe('LoginPage', () => {
  beforeEach(() => {
    useAuth.mockReturnValue({ session: null, loading: false })
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

  it('redirects authenticated user to / after successful login', async () => {
    const user = userEvent.setup()
    supabase.auth.signInWithPassword.mockResolvedValue({ error: null })
    renderLoginPage()

    await user.type(screen.getByLabelText(/email address/i), 'staff@example.com')
    await user.type(screen.getByLabelText(/password/i), 'correct-password')
    await user.click(screen.getByRole('button', { name: /sign in/i }))

    expect(await screen.findByRole('heading', { name: 'Start Transaction' })).toBeInTheDocument()
  })
})
