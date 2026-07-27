import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import StartTransactionPage from './StartTransactionPage.jsx'
import { wizardStorageKeys } from '../../components/wizardStorage.js'
import { deleteTransaction, findTransactionByRef, loadCustomers } from '../../lib/wizardApi.js'
import { useAuth } from '../../context/AuthContext.jsx'

vi.mock('../../lib/wizardApi.js', () => ({
  deleteTransaction: vi.fn(),
  findTransactionByRef: vi.fn(),
  loadCustomers: vi.fn(),
}))

vi.mock('../../context/AuthContext.jsx', () => ({
  useAuth: vi.fn(),
}))

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<StartTransactionPage />} />
        <Route path="/customers" element={<h1>Add Customers</h1>} />
      </Routes>
    </MemoryRouter>,
  )
}

function clearDateTime() {
  const input = screen.getByLabelText(/transaction date and time/i)
  // datetime-local inputs aren't reliably clearable via userEvent.clear in jsdom — bypass
  // React's value tracker by writing through the native setter, then fire a real 'input' event.
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  nativeSetter.call(input, '')
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('StartTransactionPage', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
    useAuth.mockReturnValue({ staffMember: { full_name: 'Jane Staff' }, canApproveReports: false, signOut: vi.fn() })
    findTransactionByRef.mockResolvedValue(null)
    deleteTransaction.mockResolvedValue(undefined)
    loadCustomers.mockResolvedValue([])
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('shows a validation error when no scenario is selected on continue', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.type(screen.getByLabelText(/transaction reference/i), 'INV-001')
    await user.click(screen.getByRole('button', { name: /start transaction/i }))

    expect(await screen.findByText('Select a transaction scenario.')).toBeInTheDocument()
  })

  it('shows a validation error when transaction reference is empty on continue', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('radio', { name: /sell bullion to customer/i }))
    await user.click(screen.getByRole('button', { name: /start transaction/i }))

    expect(await screen.findByText('Enter a transaction reference.')).toBeInTheDocument()
  })

  it('shows a validation error when dateTime is cleared on continue', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('radio', { name: /sell bullion to customer/i }))
    await user.type(screen.getByLabelText(/transaction reference/i), 'INV-001')
    clearDateTime()
    await user.click(screen.getByRole('button', { name: /start transaction/i }))

    expect(await screen.findByText('Enter the transaction date and time.')).toBeInTheDocument()
  })

  it('writes scenario, transactionRef, and dateTime to sessionStorage on continue', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('radio', { name: /sell bullion to customer/i }))
    await user.type(screen.getByLabelText(/transaction reference/i), 'INV-001')
    await user.click(screen.getByRole('button', { name: /start transaction/i }))

    await waitFor(() => {
      const stored = JSON.parse(window.sessionStorage.getItem(wizardStorageKeys.transaction))
      expect(stored).toMatchObject({
        scenario: 'sell',
        serviceType: 'bullion',
        transactionRef: 'INV-001',
        status: 'Draft',
      })
      expect(stored.dateTime).toBeTruthy()
    })
  })

  it('navigates to /customers on successful continue', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('radio', { name: /sell bullion to customer/i }))
    await user.type(screen.getByLabelText(/transaction reference/i), 'INV-001')
    await user.click(screen.getByRole('button', { name: /start transaction/i }))

    expect(await screen.findByRole('heading', { name: 'Add Customers' })).toBeInTheDocument()
  })

  it('renders both scenario radio cards — Sell and Buy', () => {
    renderPage()

    expect(screen.getByRole('radio', { name: /sell bullion to customer/i })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /buy bullion from customer/i })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /sell precious metal to customer/i })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /buy precious metal from customer/i })).toBeInTheDocument()
  })

  it('trims leading and trailing whitespace from transaction reference before saving', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('radio', { name: /sell bullion to customer/i }))
    await user.type(screen.getByLabelText(/transaction reference/i), '  INV-001  ')
    await user.click(screen.getByRole('button', { name: /start transaction/i }))

    await waitFor(() => {
      const stored = JSON.parse(window.sessionStorage.getItem(wizardStorageKeys.transaction))
      expect(stored.transactionRef).toBe('INV-001')
    })
  })

  // Regression: resuming a draft used to write its already-persisted parties into sessionStorage
  // unflagged, so continuing through Transaction Details re-inserted every one of them as a
  // duplicate ttr.parties row — and the duplicate set doubled again each time the draft reopened.
  it('flags a resumed draft\'s existing parties as _migrated so they are not re-inserted', async () => {
    const user = userEvent.setup()
    findTransactionByRef.mockResolvedValue({ scenario: 'sell', serviceType: 'bullion', transactionRef: 'INV-001', dateTime: '2026-07-04T10:00', status: 'draft' })
    loadCustomers.mockResolvedValue([{ id: 'party-1', type: 'individual', displayName: 'Jane Doe' }])
    renderPage()

    await user.click(screen.getByRole('radio', { name: /sell bullion to customer/i }))
    await user.type(screen.getByLabelText(/transaction reference/i), 'INV-001')
    await user.click(screen.getByRole('button', { name: /start transaction/i }))

    await waitFor(() => {
      const stored = JSON.parse(window.sessionStorage.getItem(wizardStorageKeys.customers))
      expect(stored).toEqual([expect.objectContaining({ id: 'party-1', _migrated: true })])
    })
  })

  // A completed ref used to look identical to an unused one (the lookup filtered on
  // status = 'draft'), so the wizard opened and only failed at Transaction Details with a raw
  // uq_tx_ref_per_entity violation — after the whole party set had been re-keyed.
  describe('completed transaction reference', () => {
    const completedTx = { scenario: 'sell', serviceType: 'bullion', transactionRef: 'INV-001', dateTime: '2026-07-04T10:00', status: 'complete' }
    const blockedMessage = /belongs to a completed transaction/i

    it('blocks on blur with an error and no draft notice', async () => {
      const user = userEvent.setup()
      findTransactionByRef.mockResolvedValue(completedTx)
      renderPage()

      await user.type(screen.getByLabelText(/transaction reference/i), 'INV-001')
      await user.tab()

      expect(await screen.findByText(blockedMessage)).toBeInTheDocument()
      expect(screen.queryByText(/existing draft found/i)).not.toBeInTheDocument()
    })

    it('does not start the wizard on submit', async () => {
      const user = userEvent.setup()
      findTransactionByRef.mockResolvedValue(completedTx)
      renderPage()

      await user.click(screen.getByRole('radio', { name: /sell bullion to customer/i }))
      await user.type(screen.getByLabelText(/transaction reference/i), 'INV-001')
      await user.click(screen.getByRole('button', { name: /start transaction/i }))

      expect(await screen.findByText(blockedMessage)).toBeInTheDocument()
      expect(screen.queryByRole('heading', { name: 'Add Customers' })).not.toBeInTheDocument()
      expect(deleteTransaction).not.toHaveBeenCalled()
      expect(window.sessionStorage.getItem(wizardStorageKeys.transaction)).toBeNull()
    })

    it('clears the error once the reference is edited', async () => {
      const user = userEvent.setup()
      findTransactionByRef.mockResolvedValue(completedTx)
      renderPage()

      await user.type(screen.getByLabelText(/transaction reference/i), 'INV-001')
      await user.tab()
      expect(await screen.findByText(blockedMessage)).toBeInTheDocument()

      await user.type(screen.getByLabelText(/transaction reference/i), '2')

      await waitFor(() => expect(screen.queryByText(blockedMessage)).not.toBeInTheDocument())
    })
  })

  it('shows cancel confirmation modal when the exit button is clicked', async () => {
    const user = userEvent.setup()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(confirmSpy).toHaveBeenCalledWith('Cancel transaction creation? Any entered data will be lost.')
    expect(deleteTransaction).not.toHaveBeenCalled()
  })

  it('calls deleteTransaction and clears sessionStorage when cancel is confirmed', async () => {
    const user = userEvent.setup()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    // deleteTransaction is wizardApi's job to clear sessionStorage (see wizardApi.test.js) —
    // here just confirm the page wires the confirmed-cancel action to it.
    window.sessionStorage.setItem(wizardStorageKeys.transaction, JSON.stringify({ transactionRef: 'INV-1' }))
    deleteTransaction.mockImplementation(async () => {
      Object.values(wizardStorageKeys).forEach((k) => window.sessionStorage.removeItem(k))
    })
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => {
      expect(deleteTransaction).toHaveBeenCalled()
      expect(window.sessionStorage.getItem(wizardStorageKeys.transaction)).toBeNull()
    })
  })
})
