import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import BullionDetailsPage from './BullionDetailsPage.jsx'
import { loadBullionItems, loadCustomers, loadTransaction, saveBullionItems } from '../../lib/wizardApi.js'
import { useAuth } from '../../context/AuthContext.jsx'

vi.mock('../../lib/wizardApi.js', () => ({
  loadBullionItems: vi.fn(),
  loadCustomers: vi.fn(),
  loadTransaction: vi.fn(),
  saveBullionItems: vi.fn(),
}))

vi.mock('../../context/AuthContext.jsx', () => ({
  useAuth: vi.fn(),
}))

// BullionDetailsPage's FormFields don't pass labelFor/id — grab the control as the
// label's next DOM sibling instead of relying on getByLabelText.
function fieldControl(labelText) {
  return screen.getByText(labelText).nextElementSibling
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/bullion-details']}>
      <Routes>
        <Route path="/recipient-delivery" element={<h1>Recipient / Delivery</h1>} />
        <Route path="/bullion-details" element={<BullionDetailsPage />} />
        <Route path="/review" element={<h1>Review / Validate / Submit</h1>} />
      </Routes>
    </MemoryRouter>,
  )
}

async function fillValidItem(user) {
  await user.selectOptions(fieldControl('Metal type'), 'Gold')
  await user.selectOptions(fieldControl('Product type'), 'Bar')
  await user.type(fieldControl('Purity'), '999.9')
  await user.type(fieldControl('Quantity'), '2')
  await user.type(fieldControl('Weight').querySelector('input'), '5')
  await user.type(fieldControl('Unit price (AUD per grams)'), '10')
}

describe('BullionDetailsPage', () => {
  beforeEach(() => {
    useAuth.mockReturnValue({ staffMember: { full_name: 'Jane Staff' }, canApproveReports: false, signOut: vi.fn() })
    loadTransaction.mockResolvedValue({ scenario: 'sell', serviceType: 'bullion', transactionRef: 'INV-1' })
    loadBullionItems.mockResolvedValue([])
    loadCustomers.mockResolvedValue([])
    saveBullionItems.mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
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

  it('shows validation errors for metalType, productType, purity, quantity, weight, and unitPrice when empty on continue', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Metal type')
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByText('Select the metal type.')).toBeInTheDocument()
    expect(screen.getByText('Select the product type.')).toBeInTheDocument()
    expect(screen.getByText('Enter the purity.')).toBeInTheDocument()
    expect(screen.getByText('Quantity must be greater than 0.')).toBeInTheDocument()
    expect(screen.getByText('Weight must be greater than 0.')).toBeInTheDocument()
    expect(screen.getByText('Unit price must be greater than 0.')).toBeInTheDocument()
    expect(saveBullionItems).not.toHaveBeenCalled()
  })

  it('calls saveBullionItems() with all current items array on continue', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Metal type')
    await fillValidItem(user)
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() => {
      expect(saveBullionItems).toHaveBeenCalledWith([
        expect.objectContaining({
          metalType: 'Gold',
          productType: 'Bar',
          purity: '999.9',
          quantity: '2',
          weight: '5',
          unitPrice: '10',
        }),
      ])
    })
    expect(await screen.findByRole('heading', { name: 'Review / Validate / Submit' })).toBeInTheDocument()
  })

  it('the Quantity, Weight, and Unit price number inputs blur on mouse-wheel scroll, so scrolling cannot silently change their value', async () => {
    renderPage()
    await screen.findByText('Metal type')

    const quantityInput = fieldControl('Quantity')
    const weightInput = fieldControl('Weight').querySelector('input')
    const unitPriceInput = fieldControl(/Unit price/)

    for (const input of [quantityInput, weightInput, unitPriceInput]) {
      input.focus()
      expect(document.activeElement).toBe(input)
      fireEvent.wheel(input)
      expect(document.activeElement).not.toBe(input)
    }
  })

  it('renders one default bullion item card on initial load', async () => {
    renderPage()

    await screen.findByText('Metal type')
    expect(screen.getAllByText('Metal type')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: /remove item/i })).not.toBeInTheDocument()
  })

  it('transaction scenario (sell/buy) is loaded via loadTransaction() on mount and displayed as context — individual bullion items have no per-item direction field', async () => {
    loadTransaction.mockResolvedValue({ scenario: 'buy', serviceType: 'bullion', transactionRef: 'INV-1' })
    renderPage()

    expect(await screen.findByText('Buy bullion from customer')).toBeInTheDocument()
    expect(screen.queryByText('Direction')).not.toBeInTheDocument()
  })

  it('clicking Add item appends a new bullion item card to the list', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Metal type')
    await user.click(screen.getByRole('button', { name: /add item/i }))

    expect(screen.getAllByText('Metal type')).toHaveLength(2)
    expect(screen.getByText('Item 2', { exact: false })).toBeInTheDocument()
  })

  it('Remove button is disabled when only one bullion item exists', async () => {
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

  it('selecting Other for metal type reveals a free-text input for specifying the metal', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Metal type')
    expect(screen.queryByText('Specify metal type')).not.toBeInTheDocument()

    await user.selectOptions(fieldControl('Metal type'), 'Other')

    expect(screen.getByText('Specify metal type')).toBeInTheDocument()
  })

  it('selecting Other for product type reveals a free-text input for specifying the product', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Metal type')
    expect(screen.queryByText('Specify product type')).not.toBeInTheDocument()

    await user.selectOptions(fieldControl('Product type'), 'Other')

    expect(screen.getByText('Specify product type')).toBeInTheDocument()
  })

  it('selecting Other for weight unit reveals a free-text input for specifying the unit', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Metal type')
    expect(screen.queryByText('Specify unit')).not.toBeInTheDocument()

    await user.selectOptions(fieldControl('Weight').querySelector('select'), 'other')

    expect(screen.getByText('Specify unit')).toBeInTheDocument()
  })

  it('summary section shows correct total item count and total AUD value across all items', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Metal type')
    await fillValidItem(user)

    expect(fieldControl('Number of items')).toHaveTextContent('1')
    expect(fieldControl('Total value')).toHaveTextContent('$100.00 AUD')
  })

  it('selecting metalType "Other" shows the dedicated AUSTRAC error "Metal type Other cannot be reported to AUSTRAC — select Gold, Silver, Platinum, or Palladium" rather than a generic required-field error', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Metal type')
    await user.selectOptions(fieldControl('Metal type'), 'Other')
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByText('Metal type "Other" cannot be reported to AUSTRAC. Select Gold, Silver, Platinum, or Palladium.')).toBeInTheDocument()
    expect(screen.queryByText('Select the metal type.')).not.toBeInTheDocument()
  })

  it('collapses a completed item into a summary when Add item is clicked, and clicking its header re-expands it', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Metal type')
    await fillValidItem(user)
    await user.click(screen.getByRole('button', { name: /add item/i }))

    expect(screen.getAllByText('Metal type')).toHaveLength(1)
    expect(screen.getByText(/Gold Bar/)).toBeInTheDocument()

    await user.click(screen.getByText('Item 1', { exact: false }))

    expect(screen.getAllByText('Metal type')).toHaveLength(2)
    expect(screen.queryByText(/Gold Bar/)).not.toBeInTheDocument()
  })

  it('does not collapse an incomplete item when Add item is clicked', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Metal type')
    await user.selectOptions(fieldControl('Metal type'), 'Gold')
    await user.click(screen.getByRole('button', { name: /add item/i }))

    expect(screen.getAllByText('Metal type')).toHaveLength(2)
  })
})
