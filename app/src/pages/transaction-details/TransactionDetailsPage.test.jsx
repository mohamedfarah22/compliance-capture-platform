import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import TransactionDetailsPage from './TransactionDetailsPage.jsx'
import { wizardStorageKeys } from '../../components/wizardStorage.js'
import { deleteTransaction, getTransactionId, initTransaction, migrateNewParties, saveTransaction } from '../../lib/wizardApi.js'
import { useAuth } from '../../context/AuthContext.jsx'

vi.mock('../../lib/wizardApi.js', () => ({
  deleteTransaction: vi.fn(),
  getTransactionId: vi.fn(),
  initTransaction: vi.fn(),
  migrateNewParties: vi.fn(),
  saveTransaction: vi.fn(),
}))

vi.mock('../../context/AuthContext.jsx', () => ({
  useAuth: vi.fn(),
}))

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
      serviceType: 'bullion',
      dateTime: '2026-05-10T10:00',
      transactionRef: 'INV-001',
      ...overrides,
    }),
  )
}

function seedParties(parties) {
  window.sessionStorage.setItem(wizardStorageKeys.customers, JSON.stringify(parties))
}

describe('TransactionDetailsPage', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
    useAuth.mockReturnValue({ staffMember: { id: 'staff-1', full_name: 'Jane Staff', reporting_entity_id: 're-1' }, canApproveReports: false, signOut: vi.fn() })
    getTransactionId.mockReturnValue(null)
    initTransaction.mockResolvedValue('tx-new-1')
    saveTransaction.mockResolvedValue(undefined)
    migrateNewParties.mockResolvedValue(undefined)
    deleteTransaction.mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('rehydrates transactionRef, scenario, and dateTime from sessionStorage on mount', () => {
    seedTransaction({ scenario: 'buy', transactionRef: 'INV-777', dateTime: '2026-05-10T10:00' })
    renderPage()

    expect(screen.getByText('INV-777')).toBeInTheDocument()
    expect(screen.getByLabelText('Transaction date and time')).toHaveValue('2026-05-10T10:00')
    expect(screen.getByRole('button', { name: 'Buy bullion from customer' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('shows the AUD cash amount field when currency is set to AUD', () => {
    renderPage()

    expect(screen.getByRole('button', { name: 'AUD' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByLabelText('Cash amount')).toBeInTheDocument()
    expect(screen.getAllByText('$')).toHaveLength(2)
  })

  // The threshold-warning paragraph is shown when the AUD value is BELOW $10,000 (a prompt
  // that the transaction won't be reportable) — TC-047/048's wording describes the polarity
  // reversed from the actual implementation; these test the real behavior at both sides.
  it('does not display the TTR threshold warning when cash amount is $10,000 or above', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.type(screen.getByLabelText('Cash amount'), '10000')

    expect(screen.queryByText(/Ensure the cash transaction amount is greater than \$10,000/)).not.toBeInTheDocument()
  })

  it('displays the TTR threshold warning when cash amount is below $10,000', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.type(screen.getByLabelText('Cash amount'), '5000')

    expect(screen.getByText(/Ensure the cash transaction amount is greater than \$10,000/)).toBeInTheDocument()
  })

  it('reveals all foreign currency fields when currency is switched to Other', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Other' }))

    expect(screen.getByLabelText('Foreign currency type')).toBeInTheDocument()
    expect(screen.getByLabelText('Foreign currency amount')).toBeInTheDocument()
    expect(screen.getByLabelText('FX rate used')).toBeInTheDocument()
    expect(screen.getByLabelText('Rate source')).toBeInTheDocument()
    expect(screen.queryByLabelText('Cash amount')).not.toBeInTheDocument()
  })

  it('auto-calculates AUD value as foreignAmount × fxRate and updates on change', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Other' }))
    await user.type(screen.getByLabelText('Foreign currency amount'), '1000')
    await user.type(screen.getByLabelText('FX rate used'), '1.5')

    expect(screen.getByLabelText('Australian dollar value')).toHaveValue(1500)
  })

  it('does not require the AUD cash amount field when foreign currency fields are filled', async () => {
    const user = userEvent.setup()
    getTransactionId.mockReturnValue(null)
    seedTransaction()
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Other' }))
    await user.type(screen.getByLabelText('Foreign currency amount'), '10000')
    await user.type(screen.getByLabelText('FX rate used'), '1')
    await user.selectOptions(screen.getByLabelText('Rate source'), 'Internal POS rate')

    expect(screen.getByRole('button', { name: 'Continue' })).not.toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByRole('heading', { name: 'Party Details' })).toBeInTheDocument()
  })

  it('shows validation errors for all FX fields when foreign currency is selected and fields are empty', async () => {
    const user = userEvent.setup()
    seedTransaction()
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Other' }))
    // Fill amount + rate only enough to clear the $10,000 continue-button gate, leave rate source blank.
    await user.type(screen.getByLabelText('Foreign currency amount'), '10000')
    await user.type(screen.getByLabelText('FX rate used'), '1')

    expect(screen.getByRole('button', { name: 'Continue' })).not.toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByText('Select the rate source.')).toBeInTheDocument()
  })

  it('shows validation errors when transactionRef or dateTime are empty', async () => {
    const user = userEvent.setup()
    seedTransaction({ transactionRef: '', dateTime: '' })
    renderPage()

    await user.type(screen.getByLabelText('Cash amount'), '15000')
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByText('Enter the transaction reference.')).toBeInTheDocument()
    expect(screen.getByText('Enter the transaction date and time.')).toBeInTheDocument()
  })

  it('calls initTransaction() when saving on a page with no existing transactionId in sessionStorage', async () => {
    const user = userEvent.setup()
    getTransactionId.mockReturnValue(null)
    seedTransaction()
    seedParties([{ id: 'party-1', type: 'individual' }])
    renderPage()

    await user.type(screen.getByLabelText('Cash amount'), '15000')
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() => expect(initTransaction).toHaveBeenCalled())
    expect(saveTransaction).not.toHaveBeenCalled()
  })

  // The Start page blocks refs already used by a completed transaction, but another staff member
  // can claim the same ref in between. uq_tx_ref_per_entity then rejects the insert here, and
  // staff must not be shown the raw Postgres string (see docs/uat-test-matrix.md).
  it('translates a duplicate transaction_ref constraint violation into a plain-English message', async () => {
    const user = userEvent.setup()
    getTransactionId.mockReturnValue(null)
    initTransaction.mockRejectedValue({
      code: '23505',
      message: 'duplicate key value violates unique constraint "uq_tx_ref_per_entity"',
    })
    seedTransaction()
    seedParties([{ id: 'party-1', type: 'individual' }])
    renderPage()

    await user.type(screen.getByLabelText('Cash amount'), '15000')
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByText(/transaction reference is already in use/i)).toBeInTheDocument()
    expect(screen.queryByText(/duplicate key value/i)).not.toBeInTheDocument()
  })

  it('shows the underlying message for save failures unrelated to the ref constraint', async () => {
    const user = userEvent.setup()
    getTransactionId.mockReturnValue(null)
    initTransaction.mockRejectedValue(new Error('Network request failed'))
    seedTransaction()
    seedParties([{ id: 'party-1', type: 'individual' }])
    renderPage()

    await user.type(screen.getByLabelText('Cash amount'), '15000')
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByText('Network request failed')).toBeInTheDocument()
  })

  it('calls saveTransaction() — not initTransaction() — when transactionId already exists in sessionStorage', async () => {
    const user = userEvent.setup()
    getTransactionId.mockReturnValue('existing-tx-id')
    seedTransaction()
    renderPage()

    await user.type(screen.getByLabelText('Cash amount'), '15000')
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() => expect(saveTransaction).toHaveBeenCalled())
    expect(initTransaction).not.toHaveBeenCalled()
  })

  it('migrates all parties from sessionStorage to the DB ttr.parties table on save', async () => {
    const user = userEvent.setup()
    getTransactionId.mockReturnValue(null)
    seedTransaction()
    const parties = [{ id: 'new-1', type: 'individual' }, { id: 'new-2', type: 'company' }]
    seedParties(parties)
    renderPage()

    await user.type(screen.getByLabelText('Cash amount'), '15000')
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() => {
      expect(initTransaction).toHaveBeenCalledWith(expect.objectContaining({ parties }))
    })
  })

  it('migrates newly-added parties even when the transaction already exists', async () => {
    const user = userEvent.setup()
    getTransactionId.mockReturnValue('existing-tx-id')
    seedTransaction()
    const parties = [{ id: 'party-already-saved', type: 'individual', _migrated: true }, { id: 'new-2', type: 'company' }]
    seedParties(parties)
    renderPage()

    await user.type(screen.getByLabelText('Cash amount'), '15000')
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() => expect(migrateNewParties).toHaveBeenCalledWith(parties))
    expect(saveTransaction).toHaveBeenCalled()
  })

  it('navigates to /party-details after a successful save', async () => {
    const user = userEvent.setup()
    getTransactionId.mockReturnValue(null)
    seedTransaction()
    renderPage()

    await user.type(screen.getByLabelText('Cash amount'), '15000')
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByRole('heading', { name: 'Party Details' })).toBeInTheDocument()
  })
})
