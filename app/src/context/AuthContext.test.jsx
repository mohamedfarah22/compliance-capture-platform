import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AuthProvider, useAuth } from './AuthContext.jsx'
import { supabase } from '../lib/supabase.js'
import { wizardStorageKeys } from '../components/wizardStorage.js'

vi.mock('../lib/supabase.js', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(),
      onAuthStateChange: vi.fn(),
      signOut: vi.fn(),
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn(),
      },
    },
    from: vi.fn(),
  },
}))

function makeBuilder(response) {
  const builder = {}
  ;['select', 'eq'].forEach((m) => { builder[m] = vi.fn(() => builder) })
  builder.single = vi.fn(() => Promise.resolve(response))
  return builder
}

function Consumer() {
  const { reportingEntity } = useAuth()
  return <div>AAN: {reportingEntity?.austrac_account_number ?? 'none'}</div>
}

describe('AuthContext', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it("fetchStaffMember selects the renamed austrac_account_number column when loading the reporting entity profile — the austrac_re_number column no longer exists", async () => {
    const builder = makeBuilder({
      data: {
        id: 'staff-1',
        full_name: 'Jane Staff',
        role: 'staff',
        job_title: 'Compliance Officer',
        reporting_entities: { legal_name: 'Test Bullion', austrac_account_number: '123456789' },
      },
    })
    supabase.from.mockReturnValue(builder)
    supabase.auth.getSession.mockResolvedValue({ data: { session: { user: { id: 'user-1' } } } })
    supabase.auth.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } })
    supabase.auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: 'aal2', nextLevel: 'aal2' },
    })

    render(
      <AuthProvider>
        <Consumer />
      </AuthProvider>,
    )

    await waitFor(() => expect(screen.getByText('AAN: 123456789')).toBeInTheDocument())

    expect(supabase.from).toHaveBeenCalledWith('staff_members')
    expect(builder.select.mock.calls[0][0]).toContain('austrac_account_number')
    expect(builder.select.mock.calls[0][0]).not.toContain('austrac_re_number')
  })

  it('signing out clears the unfinished transaction from the browser, so the next person at a shared PC cannot see that customer', async () => {
    const user = userEvent.setup()
    supabase.from.mockReturnValue(makeBuilder({ data: null }))
    supabase.auth.getSession.mockResolvedValue({ data: { session: null } })
    supabase.auth.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } })
    supabase.auth.signOut.mockResolvedValue({ error: null })
    sessionStorage.setItem(wizardStorageKeys.customers, JSON.stringify([{ firstName: 'Jane' }]))
    sessionStorage.setItem(wizardStorageKeys.idVerification, JSON.stringify({ frontImageBlob: 'data:image/jpeg;base64,AAAA' }))

    function SignOutButton() {
      const { signOut } = useAuth()
      return <button onClick={signOut}>Sign out</button>
    }
    render(
      <AuthProvider>
        <SignOutButton />
      </AuthProvider>,
    )
    await user.click(screen.getByRole('button', { name: 'Sign out' }))

    expect(sessionStorage.getItem(wizardStorageKeys.customers)).toBeNull()
    expect(sessionStorage.getItem(wizardStorageKeys.idVerification)).toBeNull()
    expect(supabase.auth.signOut).toHaveBeenCalled()
  })
})
