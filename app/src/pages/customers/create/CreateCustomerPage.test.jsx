import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import CreateCustomerPage from './CreateCustomerPage.jsx'
import { wizardStorageKeys } from '../../../components/wizardStorage.js'
import { deleteTransaction } from '../../../lib/wizardApi.js'
import { useAuth } from '../../../context/AuthContext.jsx'

vi.mock('../../../lib/wizardApi.js', () => ({
  deleteTransaction: vi.fn(),
}))

vi.mock('../../../context/AuthContext.jsx', () => ({
  useAuth: vi.fn(),
}))

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/customers/create']}>
      <Routes>
        <Route path="/" element={<h1>Start TTR Transaction</h1>} />
        <Route path="/customers/create" element={<CreateCustomerPage />} />
        <Route path="/customers" element={<h1>Customer / Party Search</h1>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('CreateCustomerPage', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
    useAuth.mockReturnValue({ staffMember: { full_name: 'Jane Staff' }, canApproveReports: false, signOut: vi.fn() })
    deleteTransaction.mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('individual: shows validation errors when first name or last name is empty', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.type(screen.getByLabelText('Date of birth'), '15/06/1990')
    await user.click(screen.getByRole('button', { name: 'Save customer' }))

    expect(await screen.findByText('Enter a first name.')).toBeInTheDocument()
    expect(screen.getByText('Enter a last name.')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Customer / Party Search' })).not.toBeInTheDocument()
  })

  it('individual: shows a validation error when date of birth is not provided', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.type(screen.getByLabelText('First name'), 'Jane')
    await user.type(screen.getByLabelText('Last name'), 'Doe')
    await user.click(screen.getByRole('button', { name: 'Save customer' }))

    expect(await screen.findByText('Enter a date of birth.')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Customer / Party Search' })).not.toBeInTheDocument()
  })

  it('company: shows a validation error when registered entity name is empty', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Company / Business' }))
    await user.type(screen.getByLabelText('ABN / ACN'), '12345678901')
    await user.click(screen.getByRole('button', { name: 'Save customer' }))

    expect(await screen.findByText('Enter a registered entity name.')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Customer / Party Search' })).not.toBeInTheDocument()
  })

  it('company: shows a validation error when ABN/ACN is empty', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Company / Business' }))
    await user.type(screen.getByLabelText('Registered entity name'), 'Acme Pty Ltd')
    await user.click(screen.getByRole('button', { name: 'Save customer' }))

    expect(await screen.findByText('Enter an ABN or ACN.')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Customer / Party Search' })).not.toBeInTheDocument()
  })

  it('appends the new party to the existing parties array in sessionStorage on save', async () => {
    const existing = [
      { id: 'ind-001', type: 'individual', displayName: 'Sarah Johnson', detail: 'DOB: 14 Mar 1985' },
    ]
    window.sessionStorage.setItem(wizardStorageKeys.customers, JSON.stringify(existing))

    const user = userEvent.setup()
    renderPage()

    await user.type(screen.getByLabelText('First name'), 'New')
    await user.type(screen.getByLabelText('Last name'), 'Person')
    await user.type(screen.getByLabelText('Date of birth'), '01/01/2000')
    await user.click(screen.getByRole('button', { name: 'Save customer' }))

    expect(await screen.findByRole('heading', { name: 'Customer / Party Search' })).toBeInTheDocument()

    const stored = JSON.parse(window.sessionStorage.getItem(wizardStorageKeys.customers))
    expect(stored).toHaveLength(2)
    expect(stored[0]).toMatchObject({ displayName: 'Sarah Johnson' })
    expect(stored[1]).toMatchObject({ displayName: 'New Person' })
  })

  it('includes the middle name in displayName when one is entered — it must not be silently dropped', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.type(screen.getByLabelText('First name'), 'Jane')
    await user.type(screen.getByLabelText('Middle name'), 'Alice')
    await user.type(screen.getByLabelText('Last name'), 'Citizen')
    await user.type(screen.getByLabelText('Date of birth'), '15/06/1985')
    await user.click(screen.getByRole('button', { name: 'Save customer' }))

    expect(await screen.findByRole('heading', { name: 'Customer / Party Search' })).toBeInTheDocument()

    const stored = JSON.parse(window.sessionStorage.getItem(wizardStorageKeys.customers))
    expect(stored[0]).toMatchObject({ displayName: 'Jane Alice Citizen', middleName: 'Alice' })
  })

  it('renders the Individual form fields by default', () => {
    renderPage()

    expect(screen.getByRole('button', { name: 'Individual' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByLabelText('First name')).toBeInTheDocument()
    expect(screen.getByLabelText('Last name')).toBeInTheDocument()
    expect(screen.queryByLabelText('Registered entity name')).not.toBeInTheDocument()
  })

  it('switches to the Company form when the Company toggle is selected', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Company / Business' }))

    expect(screen.getByLabelText('Registered entity name')).toBeInTheDocument()
    expect(screen.getByLabelText('ABN / ACN')).toBeInTheDocument()
    expect(screen.queryByLabelText('First name')).not.toBeInTheDocument()
  })

  it('individual: allows saving without phone, email, or middle name', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.type(screen.getByLabelText('First name'), 'Jane')
    await user.type(screen.getByLabelText('Last name'), 'Doe')
    await user.type(screen.getByLabelText('Date of birth'), '15/06/1990')
    await user.click(screen.getByRole('button', { name: 'Save customer' }))

    expect(await screen.findByRole('heading', { name: 'Customer / Party Search' })).toBeInTheDocument()
  })

  it('generated party ID is prefixed with "new-" to distinguish from DB records', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.type(screen.getByLabelText('First name'), 'Jane')
    await user.type(screen.getByLabelText('Last name'), 'Doe')
    await user.type(screen.getByLabelText('Date of birth'), '15/06/1990')
    await user.click(screen.getByRole('button', { name: 'Save customer' }))

    await screen.findByRole('heading', { name: 'Customer / Party Search' })
    const stored = JSON.parse(window.sessionStorage.getItem(wizardStorageKeys.customers))
    expect(stored[0].id).toMatch(/^new-/)
  })

  it('shows cancel confirmation modal; navigates to /customers on confirm', async () => {
    const user = userEvent.setup()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(window.confirm).toHaveBeenCalledWith('Discard this new party? Any entered data will be lost.')
    expect(await screen.findByRole('heading', { name: 'Customer / Party Search' })).toBeInTheDocument()
  })
})
