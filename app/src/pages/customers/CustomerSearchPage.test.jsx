import { Route, Routes, MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CustomerSearchPage from './CustomerSearchPage.jsx'
import { wizardStorageKeys } from '../../components/wizardStorage.js'

function renderCustomersPage() {
  return render(
    <MemoryRouter initialEntries={['/customers']}>
      <Routes>
        <Route path="/customers" element={<CustomerSearchPage />} />
        <Route path="/transaction-details" element={<h1>Transaction Details</h1>} />
        <Route path="/customers/create" element={<h1>Create Customer</h1>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('CustomerSearchPage', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    window.sessionStorage.clear()
  })

  it('displays the required copy and controls on first render', () => {
    renderCustomersPage()

    expect(screen.getByRole('heading', { name: 'Add Customers / Parties' })).toBeInTheDocument()
    expect(
      screen.getByText(
        'Search for existing records first, then add all parties involved in this transaction.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByText('Step 1 of 3')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Individual' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Company / Business' })).toBeInTheDocument()
    expect(screen.getByLabelText('First name')).toBeInTheDocument()
    expect(screen.getByLabelText('Last name')).toBeInTheDocument()
    expect(screen.getByLabelText('Date of birth')).toBeInTheDocument()
    expect(
      screen.getByText('Search using First Name + Last Name, or Last Name + DOB.'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Enter customer or party details to search existing records.'),
    ).toBeInTheDocument()
    expect(screen.getByText('Selected for this transaction')).toBeInTheDocument()
    expect(
      screen.getByText('No parties selected yet. Search and add parties to continue.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument()
  })

  it('shows individual validation message when searching without valid fields', async () => {
    const user = userEvent.setup()
    renderCustomersPage()

    await user.click(screen.getByRole('button', { name: 'Search' }))

    expect(
      screen.getByText('Enter First Name + Last Name, or Last Name + DOB to search.'),
    ).toBeInTheDocument()
  })

  it('switches to Company / Business mode and shows correct fields and hint', async () => {
    const user = userEvent.setup()
    renderCustomersPage()

    await user.click(screen.getByRole('button', { name: 'Company / Business' }))

    expect(screen.getByLabelText('Registered entity name')).toBeInTheDocument()
    expect(screen.getByLabelText('ABN / ACN')).toBeInTheDocument()
    expect(screen.getByLabelText('Registered suburb / postcode')).toBeInTheDocument()
    expect(
      screen.getByText('Search using Registered Entity Name or ABN / ACN.'),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Search' }))

    expect(
      screen.getByText('Enter Registered Entity Name or ABN / ACN to search.'),
    ).toBeInTheDocument()
  })

  it('shows Sarah Johnson in search results when searching by first and last name', async () => {
    const user = userEvent.setup()
    renderCustomersPage()

    await user.type(screen.getByLabelText('First name'), 'Sarah')
    await user.type(screen.getByLabelText('Last name'), 'Johnson')
    await user.click(screen.getByRole('button', { name: 'Search' }))

    expect(screen.getByText('Sarah Johnson')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add to transaction' })).toBeInTheDocument()
  })

  it('adds a party to selected, disables the result button, and writes to storage', async () => {
    const user = userEvent.setup()
    renderCustomersPage()

    await user.type(screen.getByLabelText('First name'), 'Sarah')
    await user.type(screen.getByLabelText('Last name'), 'Johnson')
    await user.click(screen.getByRole('button', { name: 'Search' }))
    await user.click(screen.getByRole('button', { name: 'Add to transaction' }))

    expect(screen.getByRole('button', { name: 'Added' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Added' })).toBeDisabled()
    expect(screen.getAllByText('Sarah Johnson').length).toBeGreaterThan(0)

    const stored = JSON.parse(window.sessionStorage.getItem(wizardStorageKeys.customers))
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ displayName: 'Sarah Johnson' })
  })

  it('removes a selected party from the list', async () => {
    const user = userEvent.setup()
    renderCustomersPage()

    await user.type(screen.getByLabelText('First name'), 'Sarah')
    await user.type(screen.getByLabelText('Last name'), 'Johnson')
    await user.click(screen.getByRole('button', { name: 'Search' }))
    await user.click(screen.getByRole('button', { name: 'Add to transaction' }))
    await user.click(screen.getByRole('button', { name: 'Remove' }))

    expect(
      screen.getByText('No parties selected yet. Search and add parties to continue.'),
    ).toBeInTheDocument()
  })

  it('shows inline error when continuing without selected parties', async () => {
    const user = userEvent.setup()
    renderCustomersPage()

    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(
      screen.getByText('Add at least one customer or party to continue.'),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Transaction Details' }),
    ).not.toBeInTheDocument()
  })

  it('navigates to /transaction-details when continuing with a selected party', async () => {
    const user = userEvent.setup()
    renderCustomersPage()

    await user.type(screen.getByLabelText('First name'), 'Sarah')
    await user.type(screen.getByLabelText('Last name'), 'Johnson')
    await user.click(screen.getByRole('button', { name: 'Search' }))
    await user.click(screen.getByRole('button', { name: 'Add to transaction' }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(screen.getByRole('heading', { name: 'Transaction Details' })).toBeInTheDocument()
  })
})
