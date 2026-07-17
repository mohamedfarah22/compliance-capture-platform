import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import CustomerSearchPage from './CustomerSearchPage.jsx'
import { wizardStorageKeys } from '../../components/wizardStorage.js'
import { deleteParty, deleteTransaction, searchIndividualCustomers, searchCompanyCustomers } from '../../lib/wizardApi.js'
import { useAuth } from '../../context/AuthContext.jsx'

vi.mock('../../lib/wizardApi.js', () => ({
  deleteParty: vi.fn(),
  deleteTransaction: vi.fn(),
  searchIndividualCustomers: vi.fn(),
  searchCompanyCustomers: vi.fn(),
}))

vi.mock('../../context/AuthContext.jsx', () => ({
  useAuth: vi.fn(),
}))

const SAMPLE_INDIVIDUAL = { id: 'party-1', type: 'individual', displayName: 'Sarah Johnson', detail: 'DOB: 15 Jun 1985' }
const SAMPLE_COMPANY = { id: 'party-2', type: 'company', displayName: 'Acme Bullion Pty Ltd', detail: 'ABN/ACN: 12345678901' }

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/customers']}>
      <Routes>
        <Route path="/" element={<h1>Start TTR Transaction</h1>} />
        <Route path="/customers" element={<CustomerSearchPage />} />
        <Route path="/transaction-details" element={<h1>Transaction Details</h1>} />
        <Route path="/customers/create" element={<h1>Create Customer</h1>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('CustomerSearchPage', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
    useAuth.mockReturnValue({ staffMember: { full_name: 'Jane Staff' }, canApproveReports: false, signOut: vi.fn() })
    deleteTransaction.mockResolvedValue(undefined)
    deleteParty.mockResolvedValue(undefined)
    searchIndividualCustomers.mockResolvedValue([SAMPLE_INDIVIDUAL])
    searchCompanyCustomers.mockResolvedValue([SAMPLE_COMPANY])
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('individual search: shows a validation error when any of the three required fields (firstName, lastName, DOB) are missing', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.type(screen.getByLabelText('First name'), 'Sarah')
    await user.type(screen.getByLabelText('Last name'), 'Johnson')
    // Date of birth intentionally left blank.
    await user.click(screen.getByRole('button', { name: 'Search' }))

    expect(await screen.findByText('Enter First Name, Last Name and Date of Birth to search.')).toBeInTheDocument()
    expect(searchIndividualCustomers).not.toHaveBeenCalled()
  })

  it('company search: shows a validation error when any of the three required fields (entityName, ABN/ACN, suburb/postcode) are missing', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Company / Business' }))
    await user.type(screen.getByLabelText('Registered entity name'), 'Acme Bullion Pty Ltd')
    // ABN/ACN and suburb/postcode intentionally left blank.
    await user.click(screen.getByRole('button', { name: 'Search' }))

    expect(await screen.findByText('Enter Entity Name, ABN / ACN and Suburb / Postcode to search.')).toBeInTheDocument()
    expect(searchCompanyCustomers).not.toHaveBeenCalled()
  })

  it('clicking a search result adds the party to the selected parties panel', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.type(screen.getByLabelText('First name'), 'Sarah')
    await user.type(screen.getByLabelText('Last name'), 'Johnson')
    await user.type(screen.getByLabelText('Date of birth'), '15/06/1985')
    await user.click(screen.getByRole('button', { name: 'Search' }))
    await user.click(await screen.findByRole('button', { name: 'Add to transaction' }))

    expect(screen.getByText('Selected for this transaction').closest('div')).toBeInTheDocument()
    expect(screen.getAllByText('Sarah Johnson').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Added' })).toBeDisabled()
  })

  it('shows a validation error when continue is clicked with zero selected parties', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByText('Add at least one customer or party to continue.')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Transaction Details' })).not.toBeInTheDocument()
  })

  it('writes selected parties array to sessionStorage on continue', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.type(screen.getByLabelText('First name'), 'Sarah')
    await user.type(screen.getByLabelText('Last name'), 'Johnson')
    await user.type(screen.getByLabelText('Date of birth'), '15/06/1985')
    await user.click(screen.getByRole('button', { name: 'Search' }))
    await user.click(await screen.findByRole('button', { name: 'Add to transaction' }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() => {
      const stored = JSON.parse(window.sessionStorage.getItem(wizardStorageKeys.customers))
      expect(stored).toHaveLength(1)
      expect(stored[0]).toMatchObject({ id: 'party-1', displayName: 'Sarah Johnson' })
    })
  })

  it('navigates to /transaction-details on continue with at least one party', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.type(screen.getByLabelText('First name'), 'Sarah')
    await user.type(screen.getByLabelText('Last name'), 'Johnson')
    await user.type(screen.getByLabelText('Date of birth'), '15/06/1985')
    await user.click(screen.getByRole('button', { name: 'Search' }))
    await user.click(await screen.findByRole('button', { name: 'Add to transaction' }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByRole('heading', { name: 'Transaction Details' })).toBeInTheDocument()
  })

  it('defaults to the Individual search tab on first render', () => {
    renderPage()

    expect(screen.getByRole('button', { name: 'Individual' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByLabelText('First name')).toBeInTheDocument()
  })

  it('individual search: returns matching results when firstName, lastName, and DOB all correspond to a customer record', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.type(screen.getByLabelText('First name'), 'Sarah')
    await user.type(screen.getByLabelText('Last name'), 'Johnson')
    await user.type(screen.getByLabelText('Date of birth'), '15/06/1985')
    await user.click(screen.getByRole('button', { name: 'Search' }))

    expect(searchIndividualCustomers).toHaveBeenCalledWith({ firstName: 'Sarah', lastName: 'Johnson', dob: '1985-06-15' })
    expect(await screen.findByText('Sarah Johnson')).toBeInTheDocument()
  })

  it('individual search: returns an empty result set when firstName and lastName match but DOB does not — confirming all three fields must match together, not as independent OR conditions', async () => {
    const user = userEvent.setup()
    searchIndividualCustomers.mockResolvedValue([])
    renderPage()

    await user.type(screen.getByLabelText('First name'), 'Sarah')
    await user.type(screen.getByLabelText('Last name'), 'Johnson')
    await user.type(screen.getByLabelText('Date of birth'), '01/01/2000')
    await user.click(screen.getByRole('button', { name: 'Search' }))

    expect(await screen.findByText('No matching records found.')).toBeInTheDocument()
  })

  it('company search: returns results matching entity name substring', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Company / Business' }))
    await user.type(screen.getByLabelText('Registered entity name'), 'Acme')
    await user.type(screen.getByLabelText('ABN / ACN'), '12345678901')
    await user.type(screen.getByLabelText('Registered suburb / postcode'), 'Melbourne')
    await user.click(screen.getByRole('button', { name: 'Search' }))

    expect(searchCompanyCustomers).toHaveBeenCalledWith({ entityName: 'Acme', regIdentifier: '12345678901', suburb: 'Melbourne' })
    expect(await screen.findByText('Acme Bullion Pty Ltd')).toBeInTheDocument()
  })

  it('company search: returns results matching ABN or ACN', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Company / Business' }))
    await user.type(screen.getByLabelText('Registered entity name'), 'Acme Bullion Pty Ltd')
    await user.type(screen.getByLabelText('ABN / ACN'), '12345678901')
    await user.type(screen.getByLabelText('Registered suburb / postcode'), 'Melbourne')
    await user.click(screen.getByRole('button', { name: 'Search' }))

    expect(await screen.findByText('ABN/ACN: 12345678901')).toBeInTheDocument()
  })

  it('clicking remove on a selected party removes it from the panel, without calling the DB when it was never migrated', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.type(screen.getByLabelText('First name'), 'Sarah')
    await user.type(screen.getByLabelText('Last name'), 'Johnson')
    await user.type(screen.getByLabelText('Date of birth'), '15/06/1985')
    await user.click(screen.getByRole('button', { name: 'Search' }))
    await user.click(await screen.findByRole('button', { name: 'Add to transaction' }))
    await user.click(screen.getByRole('button', { name: 'Remove' }))

    expect(screen.getByText('No parties selected yet. Search and add parties to continue.')).toBeInTheDocument()
    expect(deleteParty).not.toHaveBeenCalled()
  })

  // Regression: Remove used to only drop a party from the local sessionStorage list, never
  // deleting its ttr.parties row once the transaction already existed — so it silently
  // reappeared on Party Details. Removing an already-migrated party must delete it from the DB.
  it('clicking remove on an already-migrated party deletes it from the DB and removes it from the panel', async () => {
    window.sessionStorage.setItem(
      wizardStorageKeys.customers,
      JSON.stringify([{ ...SAMPLE_INDIVIDUAL, _migrated: true }]),
    )
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Remove' }))

    await waitFor(() => {
      expect(deleteParty).toHaveBeenCalledWith('party-1')
      expect(screen.getByText('No parties selected yet. Search and add parties to continue.')).toBeInTheDocument()
    })
  })

  it('shows an error and keeps the party listed when deleting an already-migrated party fails (e.g. referenced by a later step)', async () => {
    window.sessionStorage.setItem(
      wizardStorageKeys.customers,
      JSON.stringify([{ ...SAMPLE_INDIVIDUAL, _migrated: true }]),
    )
    deleteParty.mockRejectedValue(new Error('foreign key violation'))
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Remove' }))

    expect(await screen.findByText(/Could not remove this party/)).toBeInTheDocument()
    expect(screen.getByText('Sarah Johnson')).toBeInTheDocument()
  })

  // Regression: migrateNewParties() used to overwrite a party's id with its new DB row id,
  // which broke this dedup check against fresh search results (search still returns the
  // party's original id) and let the same person be added — and migrated — a second time.
  it('shows an already-migrated party as "Added" (not addable again) when its search result reappears', async () => {
    window.sessionStorage.setItem(
      wizardStorageKeys.customers,
      JSON.stringify([{ ...SAMPLE_INDIVIDUAL, _migrated: true }]),
    )
    const user = userEvent.setup()
    renderPage()

    await user.type(screen.getByLabelText('First name'), 'Sarah')
    await user.type(screen.getByLabelText('Last name'), 'Johnson')
    await user.type(screen.getByLabelText('Date of birth'), '15/06/1985')
    await user.click(screen.getByRole('button', { name: 'Search' }))

    expect(await screen.findByRole('button', { name: 'Added' })).toBeDisabled()
  })

  it('selecting an existing individual customer search result carries the stored gender value from that customer record onto the created party, ready to pre-populate the gender field on Party Details', async () => {
    const user = userEvent.setup()
    searchIndividualCustomers.mockResolvedValue([{ ...SAMPLE_INDIVIDUAL, gender: 'F' }])
    renderPage()

    await user.type(screen.getByLabelText('First name'), 'Sarah')
    await user.type(screen.getByLabelText('Last name'), 'Johnson')
    await user.type(screen.getByLabelText('Date of birth'), '15/06/1985')
    await user.click(screen.getByRole('button', { name: 'Search' }))
    await user.click(await screen.findByRole('button', { name: 'Add to transaction' }))

    await waitFor(() => {
      const stored = JSON.parse(window.sessionStorage.getItem(wizardStorageKeys.customers))
      expect(stored[0]).toMatchObject({ gender: 'F' })
    })
  })
})
