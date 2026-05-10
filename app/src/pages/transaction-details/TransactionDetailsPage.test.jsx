import { Route, Routes, MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import TransactionDetailsPage from './TransactionDetailsPage.jsx'
import { wizardStorageKeys } from '../../components/wizardStorage.js'

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/transaction-details']}>
      <Routes>
        <Route path="/" element={<h1>Start TTR Transaction</h1>} />
        <Route path="/customers" element={<h1>Add Customers / Parties</h1>} />
        <Route path="/transaction-details" element={<TransactionDetailsPage />} />
        <Route path="/party-details" element={<h1>Party Details</h1>} />
      </Routes>
    </MemoryRouter>,
  )
}

function seedTransaction(overrides = {}) {
  window.sessionStorage.setItem(
    wizardStorageKeys.transaction,
    JSON.stringify({
      scenario: 'sell',
      dateTime: '2026-05-10T10:00',
      transactionRef: 'INV-001',
      staffMember: 'John Smith',
      ...overrides,
    }),
  )
}

describe('TransactionDetailsPage', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    window.sessionStorage.clear()
  })

  it('displays the heading, subtitle, and step indicator', () => {
    renderPage()

    expect(
      screen.getByRole('heading', { name: 'Transaction & Cash Details' }),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'Enter the transaction and physical cash details for this reportable transaction.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByText('Step 2 of 3')).toBeInTheDocument()
  })

  it('pre-fills transaction summary from session storage', () => {
    seedTransaction()
    renderPage()

    expect(screen.getByText('INV-001')).toBeInTheDocument()
    expect(screen.getByText('John Smith')).toBeInTheDocument()
    expect(screen.getAllByText('Sell bullion to customer').length).toBeGreaterThan(0)
  })

  it('shows correct party count for multiple parties', () => {
    window.sessionStorage.setItem(
      wizardStorageKeys.customers,
      JSON.stringify([{ id: 'a' }, { id: 'b' }]),
    )
    renderPage()

    expect(screen.getByText('2 parties')).toBeInTheDocument()
  })

  it('shows singular party label for one party', () => {
    window.sessionStorage.setItem(
      wizardStorageKeys.customers,
      JSON.stringify([{ id: 'a' }]),
    )
    renderPage()

    expect(screen.getByText('1 party')).toBeInTheDocument()
  })

  it('changes designated service when scenario toggle is clicked', async () => {
    const user = userEvent.setup()
    seedTransaction()
    renderPage()

    expect(screen.getByText('Sale of bullion for physical cash')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Buy bullion from customer' }))

    expect(screen.getByText('Purchase of bullion for physical cash')).toBeInTheDocument()
  })

  it('auto-fills AUD value when cash amount is typed', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.type(screen.getByLabelText('Cash amount'), '15000')

    expect(screen.getByLabelText('Australian dollar value')).toHaveValue(15000)
  })

  it('hides foreign currency section by default', () => {
    renderPage()

    expect(screen.queryByLabelText('Foreign currency type')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Foreign currency amount')).not.toBeInTheDocument()
  })

  it('shows foreign currency section when Other is selected', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Other' }))

    expect(screen.getByLabelText('Foreign currency type')).toBeInTheDocument()
    expect(screen.getByLabelText('Foreign currency amount')).toBeInTheDocument()
    expect(screen.getByLabelText('FX rate used')).toBeInTheDocument()
    expect(screen.getByLabelText('Rate source')).toBeInTheDocument()
  })

  it('hides foreign currency section when switching back to AUD', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Other' }))
    await user.click(screen.getByRole('button', { name: 'AUD' }))

    expect(screen.queryByLabelText('Foreign currency type')).not.toBeInTheDocument()
  })

  it('shows validation error when transaction reference is missing', async () => {
    const user = userEvent.setup()
    seedTransaction({ transactionRef: '' })
    renderPage()

    await user.type(screen.getByLabelText('Cash amount'), '15000')
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(screen.getByText('Enter the transaction reference.')).toBeInTheDocument()
  })

  it('Continue button is disabled when no cash amount is entered', () => {
    renderPage()

    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
  })

  it('shows validation error for missing rate source when Other currency is selected', async () => {
    const user = userEvent.setup()
    seedTransaction()
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Other' }))
    await user.type(screen.getByLabelText('Foreign currency amount'), '10000')
    await user.type(screen.getByLabelText('FX rate used'), '1')
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(screen.getByText('Select the rate source.')).toBeInTheDocument()
  })

  it('saves transaction data to storage on valid continue', async () => {
    const user = userEvent.setup()
    seedTransaction()
    renderPage()

    await user.type(screen.getByLabelText('Cash amount'), '15000')
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    const stored = JSON.parse(window.sessionStorage.getItem(wizardStorageKeys.transaction))
    expect(stored).toMatchObject({
      cashAmount: 15000,
      audValue: 15000,
      designatedService: 'Sale of bullion for physical cash',
    })
  })

  it('navigates to /party-details on valid continue', async () => {
    const user = userEvent.setup()
    seedTransaction()
    renderPage()

    await user.type(screen.getByLabelText('Cash amount'), '15000')
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(screen.getByRole('heading', { name: 'Party Details' })).toBeInTheDocument()
  })

  it('save draft writes to storage without navigating', async () => {
    const user = userEvent.setup()
    seedTransaction()
    renderPage()

    await user.type(screen.getByLabelText('Cash amount'), '5000')
    await user.click(screen.getByRole('button', { name: 'Save draft' }))

    const stored = JSON.parse(window.sessionStorage.getItem(wizardStorageKeys.transaction))
    expect(stored).toBeDefined()
    expect(
      screen.getByRole('heading', { name: 'Transaction & Cash Details' }),
    ).toBeInTheDocument()
  })

  it('clicking Back navigates to /customers', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Back' }))

    expect(
      screen.getByRole('heading', { name: 'Add Customers / Parties' }),
    ).toBeInTheDocument()
  })

  it('threshold warning is not shown when no cash amount is entered', () => {
    renderPage()

    expect(
      screen.queryByText(/does not meet the \$10,000 TTR threshold/),
    ).not.toBeInTheDocument()
  })

  it('threshold warning is shown when cash amount is below $10,000', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.type(screen.getByLabelText('Cash amount'), '5000')

    expect(
      screen.getByText(/Ensure the cash transaction amount is greater than \$10,000/),
    ).toBeInTheDocument()
    expect(screen.getAllByText('No').length).toBeGreaterThan(0)
  })

  it('threshold warning is hidden and Yes shown when cash amount is $10,000 or more', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.type(screen.getByLabelText('Cash amount'), '10000')

    expect(
      screen.queryByText(/Ensure the cash transaction amount is greater than \$10,000/),
    ).not.toBeInTheDocument()
    expect(screen.getAllByText('Yes').length).toBeGreaterThan(0)
  })

  it('Exit button saves draft and navigates to /', async () => {
    const user = userEvent.setup()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    seedTransaction()
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Exit' }))

    expect(screen.getByRole('heading', { name: 'Start TTR Transaction' })).toBeInTheDocument()
    const stored = JSON.parse(window.sessionStorage.getItem(wizardStorageKeys.transaction))
    expect(stored).toBeDefined()
  })
})
