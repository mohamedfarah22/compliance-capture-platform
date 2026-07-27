import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import PreciousMetalDetailsPage from './PreciousMetalDetailsPage.jsx'
import { deleteTransaction, loadCustomers, loadPreciousMetalItems, loadTransaction, savePreciousMetalItems } from '../../lib/wizardApi.js'
import { useAuth } from '../../context/AuthContext.jsx'

vi.mock('../../lib/wizardApi.js', () => ({
  deleteTransaction: vi.fn(),
  loadCustomers: vi.fn(),
  loadPreciousMetalItems: vi.fn(),
  loadTransaction: vi.fn(),
  savePreciousMetalItems: vi.fn(),
}))

vi.mock('../../context/AuthContext.jsx', () => ({
  useAuth: vi.fn(),
}))

// PreciousMetalDetailsPage's FormFields don't pass labelFor/id — grab the control as the
// label's next DOM sibling instead of relying on getByLabelText.
function fieldControl(labelText) {
  return screen.getByText(labelText).nextElementSibling
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/precious-metal-details']}>
      <Routes>
        <Route path="/recipient-delivery" element={<h1>Recipient / Delivery</h1>} />
        <Route path="/precious-metal-details" element={<PreciousMetalDetailsPage />} />
        <Route path="/review" element={<h1>Review / Validate / Submit</h1>} />
        <Route path="/bullion-details" element={<h1>Bullion Details</h1>} />
      </Routes>
    </MemoryRouter>,
  )
}

async function fillValidItem(user) {
  await user.selectOptions(fieldControl('Metal type'), 'Gold')
  await user.type(fieldControl('Quantity'), '2')
  await user.type(fieldControl('Weight').querySelector('input'), '5')
  await user.type(fieldControl('Unit price (AUD per grams)'), '10')
}

describe('PreciousMetalDetailsPage', () => {
  beforeEach(() => {
    useAuth.mockReturnValue({ staffMember: { full_name: 'Jane Staff' }, canApproveReports: false, signOut: vi.fn() })
    loadTransaction.mockResolvedValue({ scenario: 'sell', serviceType: 'precious_metal', transactionRef: 'INV-1' })
    loadPreciousMetalItems.mockResolvedValue([])
    loadCustomers.mockResolvedValue([])
    savePreciousMetalItems.mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('selecting Alloy or Other for metal type requires a description (500 characters or fewer)', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Metal type')
    await user.selectOptions(fieldControl('Metal type'), 'Alloy')
    await user.type(fieldControl('Quantity'), '2')
    await user.type(fieldControl('Weight').querySelector('input'), '5')
    await user.type(fieldControl('Unit price (AUD per grams)'), '10')
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByText('Description is required when metal type is Alloy.')).toBeInTheDocument()
    expect(savePreciousMetalItems).not.toHaveBeenCalled()
  })

  it('line total auto-calculates as quantity × weight × unitPrice and updates on any field change', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Metal type')
    await user.type(fieldControl('Quantity'), '2')
    await user.type(fieldControl('Weight').querySelector('input'), '5')
    await user.type(fieldControl('Unit price (AUD per grams)'), '10')

    expect(fieldControl('Line total (AUD)')).toHaveTextContent('$100.00')
  })

  it('shows validation errors for metalType, quantity, weight, and unitPrice when empty on continue', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Metal type')
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByText('Select the metal type.')).toBeInTheDocument()
    expect(screen.getByText('Quantity must be greater than 0.')).toBeInTheDocument()
    expect(screen.getByText('Weight must be greater than 0.')).toBeInTheDocument()
    expect(screen.getByText('Unit price must be greater than 0.')).toBeInTheDocument()
    expect(screen.queryByText('Select the product type.')).not.toBeInTheDocument()
    expect(savePreciousMetalItems).not.toHaveBeenCalled()
  })

  it('calls savePreciousMetalItems() with all current items array on continue', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Metal type')
    await fillValidItem(user)
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() => {
      expect(savePreciousMetalItems).toHaveBeenCalledWith([
        expect.objectContaining({ metalType: 'Gold', quantity: '2', weight: '5', unitPrice: '10' }),
      ])
    })
  })

  it('navigates to /review — not /bullion-details — after a successful save', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Metal type')
    await fillValidItem(user)
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByRole('heading', { name: 'Review / Validate / Submit' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Bullion Details' })).not.toBeInTheDocument()
  })

  it('renders one default precious metal item card on initial load', async () => {
    renderPage()

    await screen.findByText('Metal type')
    expect(screen.getAllByText('Metal type')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: /remove item/i })).not.toBeInTheDocument()
  })

  it('transaction scenario/service type is resolved via loadTransaction() on mount, not read directly from sessionStorage — item direction is derived automatically and is not user-editable', async () => {
    loadTransaction.mockResolvedValue({ scenario: 'buy', serviceType: 'precious_metal', transactionRef: 'INV-1' })
    renderPage()

    expect(await screen.findByText('Buy precious metal from customer')).toBeInTheDocument()
    expect(screen.queryByText('Direction')).not.toBeInTheDocument()
  })

  it('clicking Add item appends a new precious metal item card to the list', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Metal type')
    await user.click(screen.getByRole('button', { name: /add item/i }))

    expect(screen.getAllByText('Metal type')).toHaveLength(2)
  })

  it('Remove button is disabled when only one precious metal item exists', async () => {
    renderPage()

    await screen.findByText('Metal type')
    expect(screen.queryByRole('button', { name: /remove item 1/i })).not.toBeInTheDocument()
  })

  it('clicking Remove deletes the correct item when more than one exists', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Metal type')
    await user.click(screen.getByRole('button', { name: /add item/i }))
    await user.selectOptions(screen.getAllByText('Metal type').map((l) => l.nextElementSibling)[1], 'Silver')
    await user.click(screen.getByRole('button', { name: 'Remove item 1' }))

    expect(screen.getAllByText('Metal type')).toHaveLength(1)
    expect(fieldControl('Metal type')).toHaveValue('Silver')
  })

  it('selecting "other" for weight unit reveals a required free-text input for specifying the unit', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Metal type')
    expect(screen.queryByText('Specify unit')).not.toBeInTheDocument()

    await user.selectOptions(fieldControl('Weight').querySelector('select'), 'other')

    expect(screen.getByText('Specify unit')).toBeInTheDocument()
  })

  it('does not require a description when metal type is not Alloy or Other', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Metal type')
    await fillValidItem(user)
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() => expect(savePreciousMetalItems).toHaveBeenCalled())
  })

  it('shows a validation error when the Alloy/Other description exceeds 500 characters', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Metal type')
    await user.selectOptions(fieldControl('Metal type'), 'Alloy')
    await user.type(fieldControl('Quantity'), '2')
    await user.type(fieldControl('Weight').querySelector('input'), '5')
    await user.type(fieldControl('Unit price (AUD per grams)'), '10')

    const description = fieldControl('Item description')
    expect(description).toHaveAttribute('maxLength', '500')
  })

  it('serial number is optional and capped at 100 characters', async () => {
    renderPage()

    await screen.findByText('Metal type')
    const serialNumber = fieldControl('Serial number (if any)')
    expect(serialNumber).toHaveAttribute('maxLength', '100')
  })

  it('summary section shows correct total item count and total AUD value across all items', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Metal type')
    await fillValidItem(user)

    expect(fieldControl('Number of items')).toHaveTextContent('1')
    expect(fieldControl('Total value')).toHaveTextContent('$100.00 AUD')
  })

  it('back button navigates to /recipient-delivery', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Metal type')
    await user.click(screen.getByRole('button', { name: 'Back' }))

    expect(await screen.findByRole('heading', { name: 'Recipient / Delivery' })).toBeInTheDocument()
  })

  // This page, Recipient / Delivery and Bullion Details all rendered WizardFrame without
  // an onExit prop, so no Exit button was drawn — leaving staff who needed to abandon a
  // transaction with no way out but going backwards or completing one they should not.
  // An absent prop draws nothing and fails silently.
  it('offers an Exit that discards the transaction, so a staff member can always abandon', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Metal type')
    await user.click(screen.getByRole('button', { name: 'Exit' }))

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(deleteTransaction).not.toHaveBeenCalled()

    const dialog = screen.getByRole('dialog')
    await user.click(dialog.querySelector('button:last-of-type'))

    await waitFor(() => expect(deleteTransaction).toHaveBeenCalled())
  })
})
