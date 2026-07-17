import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import ReviewSubmitPage from './ReviewSubmitPage.jsx'
import { wizardStorageKeys } from '../../components/wizardStorage.js'
import {
  completeTransaction,
  loadBullionItems,
  loadConductingPerson,
  loadCustomers,
  loadIdVerifications,
  loadPreciousMetalItems,
  loadRecipientDelivery,
  loadTransaction,
} from '../../lib/wizardApi.js'
import { useAuth } from '../../context/AuthContext.jsx'

vi.mock('../../lib/wizardApi.js', () => ({
  completeTransaction: vi.fn(),
  loadBullionItems: vi.fn(),
  loadConductingPerson: vi.fn(),
  loadCustomers: vi.fn(),
  loadIdVerifications: vi.fn(),
  loadPreciousMetalItems: vi.fn(),
  loadRecipientDelivery: vi.fn(),
  loadTransaction: vi.fn(),
}))

vi.mock('../../context/AuthContext.jsx', () => ({
  useAuth: vi.fn(),
}))

const PARTY = { id: 'party-1', type: 'individual', displayName: 'Jane Doe' }
const BULLION_ITEM = { metalType: 'Gold', productType: 'Bar', purity: '999.9', quantity: '1', weight: '10', weightUnit: 'grams', unitPrice: '100', lineTotal: 1000 }

function TransactionCompletePlaceholder() {
  const location = useLocation()
  return (
    <div>
      <h1>Transaction Complete</h1>
      <p>Ref: {location.state?.transactionRef ?? 'none'}</p>
      <p>Completed at: {location.state?.completedAt ?? 'none'}</p>
    </div>
  )
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/review']}>
      <Routes>
        <Route path="/review" element={<ReviewSubmitPage />} />
        <Route path="/bullion-details" element={<h1>Bullion Details</h1>} />
        <Route path="/precious-metal-details" element={<h1>Precious Metal Details</h1>} />
        <Route path="/transaction-complete" element={<TransactionCompletePlaceholder />} />
        <Route path="/start" element={<h1>Start TTR Transaction</h1>} />
        <Route path="/recipient-delivery" element={<h1>Recipient / Delivery</h1>} />
        <Route path="/transaction-details" element={<h1>Transaction & Cash Details</h1>} />
        <Route path="/party-details" element={<h1>Party Details</h1>} />
        <Route path="/" element={<h1>Root</h1>} />
      </Routes>
    </MemoryRouter>,
  )
}

function seedCompleteMocks(overrides = {}) {
  loadTransaction.mockResolvedValue({
    scenario: 'sell',
    serviceType: 'bullion',
    transactionRef: 'INV-1',
    cashAmount: '15000',
    cashCurrency: 'AUD',
    ...overrides.transaction,
  })
  loadCustomers.mockResolvedValue(overrides.customers ?? [PARTY])
  loadConductingPerson.mockResolvedValue(overrides.conductingPerson ?? { hasConductingPerson: 'no' })
  loadRecipientDelivery.mockResolvedValue(
    overrides.recipientDelivery ?? {
      recipientIsParty: 'yes',
      selectedPartyId: 'party-1',
      purposeOfTransfer: 'Collecting bullion',
      deliveryMethod: 'Collected',
      deliveryAddressDifferent: 'no',
    },
  )
  loadBullionItems.mockResolvedValue(overrides.bullionItems ?? [BULLION_ITEM])
  loadPreciousMetalItems.mockResolvedValue(overrides.preciousMetalItems ?? [])
  loadIdVerifications.mockResolvedValue(overrides.idVerifications ?? {})
}

describe('ReviewSubmitPage', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
    useAuth.mockReturnValue({
      reportingEntity: { legal_name: 'Test Bullion', abn: '12345678901', austrac_account_number: '123456789' },
      staffMember: { full_name: 'Jane Staff', job_title: 'Compliance Officer', email: 'jane@example.com' },
      canApproveReports: false,
      signOut: vi.fn(),
    })
    completeTransaction.mockResolvedValue({ ok: true, completedAt: '2026-07-04T00:00:00Z' })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('shows the green "ready to complete" banner when there are no blocking issues', async () => {
    seedCompleteMocks()
    renderPage()

    expect(await screen.findByText('This transaction is ready to be completed.')).toBeInTheDocument()
  })

  it('falls back to firstName/middleName/lastName for the party name when displayName/fullName are both blank — middle name must not be silently dropped', async () => {
    seedCompleteMocks({
      customers: [{ id: 'party-1', type: 'individual', firstName: 'Jane', middleName: 'Alice', lastName: 'Citizen' }],
    })
    renderPage()

    expect(await screen.findAllByText('Jane Alice Citizen')).not.toHaveLength(0)
  })

  it('shows the red "cannot complete" banner and lists each blocking issue when they exist', async () => {
    seedCompleteMocks({ customers: [], transaction: { cashAmount: '' } })
    renderPage()

    expect(await screen.findByText('Cannot complete — required fields missing')).toBeInTheDocument()
    expect(screen.getByText('Cash amount missing or invalid.')).toBeInTheDocument()
    expect(screen.getByText('At least one party is required.')).toBeInTheDocument()
  })

  it('does not flag a foreign-currency transaction as missing its cash amount', async () => {
    seedCompleteMocks({ transaction: { cashAmount: '8000', cashCurrency: 'Other' } })
    renderPage()

    expect(await screen.findByText('This transaction is ready to be completed.')).toBeInTheDocument()
    expect(screen.queryByText('Cash amount missing or invalid.')).not.toBeInTheDocument()
  })

  it('Complete button is disabled when any blocking issue exists', async () => {
    seedCompleteMocks({ customers: [] })
    renderPage()

    await screen.findByText('Cannot complete — required fields missing')
    expect(screen.getByRole('button', { name: /complete \/ reportable/i })).toBeDisabled()
  })

  it('the missing-items blocking issue links to /precious-metal-details when service type is precious_metal, and to /bullion-details otherwise', async () => {
    const user = userEvent.setup()
    seedCompleteMocks({ transaction: { serviceType: 'bullion' }, bullionItems: [] })
    renderPage()

    await user.click(await screen.findByText('At least one bullion item is required.'))

    expect(await screen.findByRole('heading', { name: 'Bullion Details' })).toBeInTheDocument()
  })

  it('the missing-items blocking issue links to /precious-metal-details for precious metal transactions', async () => {
    const user = userEvent.setup()
    seedCompleteMocks({ transaction: { serviceType: 'precious_metal' }, preciousMetalItems: [] })
    renderPage()

    await user.click(await screen.findByText('At least one precious metal item is required.'))

    expect(await screen.findByRole('heading', { name: 'Precious Metal Details' })).toBeInTheDocument()
  })

  it('calls completeTransaction() when the Complete button is clicked', async () => {
    const user = userEvent.setup()
    seedCompleteMocks()
    renderPage()

    await screen.findByText('This transaction is ready to be completed.')
    await user.click(screen.getByRole('button', { name: /complete \/ reportable/i }))

    await waitFor(() => expect(completeTransaction).toHaveBeenCalled())
  })

  it('clears all sessionStorage wizard keys after a successful completeTransaction() call', async () => {
    const user = userEvent.setup()
    window.sessionStorage.setItem(wizardStorageKeys.transaction, JSON.stringify({ transactionRef: 'INV-1' }))
    window.sessionStorage.setItem(wizardStorageKeys.customers, JSON.stringify([PARTY]))
    // Mirror the real wizardApi.completeTransaction()'s session-clearing side effect.
    completeTransaction.mockImplementation(async () => {
      Object.values(wizardStorageKeys).forEach((k) => window.sessionStorage.removeItem(k))
      return { ok: true, completedAt: '2026-07-04T00:00:00Z' }
    })
    seedCompleteMocks()
    renderPage()

    await screen.findByText('This transaction is ready to be completed.')
    await user.click(screen.getByRole('button', { name: /complete \/ reportable/i }))

    await waitFor(() => {
      expect(window.sessionStorage.getItem(wizardStorageKeys.transaction)).toBeNull()
      expect(window.sessionStorage.getItem(wizardStorageKeys.customers)).toBeNull()
    })
  })

  it('navigates to /transaction-complete (with completion state) after a successful completeTransaction() call — does not redirect to /', async () => {
    const user = userEvent.setup()
    seedCompleteMocks()
    renderPage()

    await screen.findByText('This transaction is ready to be completed.')
    await user.click(screen.getByRole('button', { name: /complete \/ reportable/i }))

    expect(await screen.findByRole('heading', { name: 'Transaction Complete' })).toBeInTheDocument()
    expect(screen.getByText('Ref: INV-1')).toBeInTheDocument()
    expect(screen.getByText('Completed at: 2026-07-04T00:00:00Z')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Root' })).not.toBeInTheDocument()
  })

  it('shows the yellow warning banner listing non-blocking issues when present', async () => {
    seedCompleteMocks({ recipientDelivery: { recipientIsParty: 'yes', selectedPartyId: 'party-1', purposeOfTransfer: 'Collecting bullion', deliveryMethod: 'Collected', deliveryAddressDifferent: null } })
    renderPage()

    expect(await screen.findByText(/Ready to complete — 1 warning to review/)).toBeInTheDocument()
  })

  it('each blocking issue card links to the correct wizard page for remediation', async () => {
    const user = userEvent.setup()
    seedCompleteMocks({ recipientDelivery: { recipientIsParty: null, purposeOfTransfer: '', deliveryMethod: '' } })
    renderPage()

    await user.click(await screen.findByText('Recipient information incomplete.'))

    expect(await screen.findByRole('heading', { name: 'Recipient / Delivery' })).toBeInTheDocument()
  })

  it('transaction summary shows transactionRef, dateTime, scenario, and cash amount', async () => {
    seedCompleteMocks({ transaction: { transactionRef: 'INV-999', dateTime: '2026-07-04T10:00', scenario: 'sell', cashAmount: '15000', cashCurrency: 'AUD' } })
    renderPage()

    expect(await screen.findByText('INV-999')).toBeInTheDocument()
    expect(screen.getByText('2026-07-04T10:00')).toBeInTheDocument()
    expect(screen.getByText('Sell bullion to customer')).toBeInTheDocument()
    expect(screen.getByText('AUD 15000.00')).toBeInTheDocument()
  })

  it('parties summary section renders a card for each party in the transaction', async () => {
    seedCompleteMocks({ customers: [PARTY, { id: 'party-2', type: 'company', entityName: 'Acme Pty Ltd' }] })
    renderPage()

    expect(await screen.findByText('Parties (2)')).toBeInTheDocument()
    // "Jane Doe" also appears in the Recipient/Delivery section (she's the selected recipient).
    expect(screen.getAllByText('Jane Doe').length).toBeGreaterThan(0)
    expect(screen.getByText('Acme Pty Ltd')).toBeInTheDocument()
  })

  it('renders a "Precious metal" summary section — sourced from loadPreciousMetalItems() — instead of "Bullion" when the service type recorded on the transaction is precious_metal', async () => {
    const pmItem = { metalType: 'Gold', quantity: '1', weight: '10', weightUnit: 'grams', unitPrice: '100', lineTotal: 1000 }
    seedCompleteMocks({ transaction: { serviceType: 'precious_metal' }, bullionItems: [], preciousMetalItems: [pmItem] })
    renderPage()

    expect(await screen.findByText('Precious metal (1 item)')).toBeInTheDocument()
    expect(screen.queryByText(/^Bullion \(/)).not.toBeInTheDocument()
  })

  it('back button routes to /precious-metal-details vs /bullion-details based on the service type recorded on the transaction', async () => {
    const user = userEvent.setup()
    seedCompleteMocks({ transaction: { serviceType: 'precious_metal' } })
    renderPage()

    await screen.findByText('This transaction is ready to be completed.')
    await user.click(screen.getByRole('button', { name: 'Back' }))

    expect(await screen.findByRole('heading', { name: 'Precious Metal Details' })).toBeInTheDocument()
  })

  it('shows a non-blocking warning — Complete stays enabled — when "different delivery address" has not yet been answered', async () => {
    seedCompleteMocks({ recipientDelivery: { recipientIsParty: 'yes', selectedPartyId: 'party-1', purposeOfTransfer: 'Collecting bullion', deliveryMethod: 'Shipped', deliveryAddressDifferent: null } })
    renderPage()

    expect(await screen.findByText('Delivery address preference not specified.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /complete \/ reportable/i })).not.toBeDisabled()
  })
})
