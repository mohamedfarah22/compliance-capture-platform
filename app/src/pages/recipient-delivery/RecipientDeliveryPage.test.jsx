import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import RecipientDeliveryPage from './RecipientDeliveryPage.jsx'
import { loadConductingPerson, loadCustomers, loadRecipientDelivery, loadTransaction, saveRecipientDelivery } from '../../lib/wizardApi.js'
import { useAuth } from '../../context/AuthContext.jsx'

vi.mock('../../lib/wizardApi.js', () => ({
  loadConductingPerson: vi.fn(),
  loadCustomers: vi.fn(),
  loadRecipientDelivery: vi.fn(),
  loadTransaction: vi.fn(),
  saveRecipientDelivery: vi.fn(),
}))

vi.mock('../../context/AuthContext.jsx', () => ({
  useAuth: vi.fn(),
}))

const PARTY = { id: 'party-1', type: 'individual', displayName: 'Jane Doe' }

// None of RecipientDeliveryPage's FormFields pass labelFor/id, so the <label> has no
// programmatic association — grab the control as the label's next DOM sibling instead.
// Some label text (e.g. "Recipient") duplicates a section <h2>, so filter to the <label>.
function fieldControl(labelText) {
  const label = screen.getAllByText(labelText).find((el) => el.tagName === 'LABEL')
  return label.nextElementSibling
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/recipient-delivery']}>
      <Routes>
        <Route path="/id-verification" element={<h1>ID Verification</h1>} />
        <Route path="/conducting-person" element={<h1>Conducting Person Details</h1>} />
        <Route path="/recipient-delivery" element={<RecipientDeliveryPage />} />
        <Route path="/bullion-details" element={<h1>Bullion Details</h1>} />
        <Route path="/precious-metal-details" element={<h1>Precious Metal Details</h1>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('RecipientDeliveryPage', () => {
  beforeEach(() => {
    useAuth.mockReturnValue({ staffMember: { full_name: 'Jane Staff' }, canApproveReports: false, signOut: vi.fn() })
    loadTransaction.mockResolvedValue({ serviceType: 'bullion', scenario: 'sell' })
    loadCustomers.mockResolvedValue([PARTY])
    loadConductingPerson.mockResolvedValue({ hasConductingPerson: 'no' })
    loadRecipientDelivery.mockResolvedValue(null)
    saveRecipientDelivery.mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('includes the middle name in the recipient party label when displayName is blank — it must not be silently dropped', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([
      { id: 'party-1', type: 'individual', firstName: 'Jane', middleName: 'Alice', lastName: 'Citizen' },
    ])
    renderPage()

    await screen.findByRole('radio', { name: 'Yes' })
    await user.click(screen.getByRole('radio', { name: 'Yes' }))

    expect(await screen.findByRole('option', { name: 'Jane Alice Citizen (Individual)' })).toBeInTheDocument()
  })

  it('shows a validation error when recipient name is empty in "different recipient" mode', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByRole('radio', { name: 'No' })
    await user.click(screen.getByRole('radio', { name: 'No' }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByText("Enter the recipient's full name.")).toBeInTheDocument()
    expect(saveRecipientDelivery).not.toHaveBeenCalled()
  })

  it('shows validation errors when any recipient address field is empty in "different recipient" mode', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByRole('radio', { name: 'No' })
    await user.click(screen.getByRole('radio', { name: 'No' }))
    await user.type(fieldControl('Recipient full name'), 'John Recipient')
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByText("Enter the recipient's physical address.")).toBeInTheDocument()
  })

  it('shows a validation error when purpose of transfer is empty', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByRole('radio', { name: 'No' })
    await user.click(screen.getByRole('radio', { name: 'No' }))
    await user.type(fieldControl('Recipient full name'), 'John Recipient')
    await user.type(screen.getByPlaceholderText('Street address'), '1 Test St')
    await user.type(screen.getByPlaceholderText('Suburb'), 'Coburg')
    await user.type(screen.getByPlaceholderText('State'), 'VIC')
    await user.type(screen.getByPlaceholderText('Postcode'), '3058')
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByText('Select the purpose of the transfer.')).toBeInTheDocument()
  })

  it('shows a validation error when delivery method is not selected', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByRole('radio', { name: 'Yes' })
    await user.click(screen.getByRole('radio', { name: 'Yes' }))
    await user.selectOptions(fieldControl('Recipient'), 'party-1')
    await user.selectOptions(fieldControl('Purpose of the transfer'), 'Collecting bullion')
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByText('Select the delivery method.')).toBeInTheDocument()
  })

  it('calls saveRecipientDelivery() with correctly structured data on continue', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByRole('radio', { name: 'Yes' })
    await user.click(screen.getByRole('radio', { name: 'Yes' }))
    await user.selectOptions(fieldControl('Recipient'), 'party-1')
    await user.selectOptions(fieldControl('Purpose of the transfer'), 'Collecting bullion')
    await user.selectOptions(fieldControl('Delivery method'), 'Collected')
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() => {
      expect(saveRecipientDelivery).toHaveBeenCalledWith(
        expect.objectContaining({
          recipientIsParty: 'yes',
          selectedPartyId: 'party-1',
          purposeOfTransfer: 'Collecting bullion',
          deliveryMethod: 'Collected',
        }),
      )
    })
  })

  it('navigates to /bullion-details after a successful save when the transaction service type is bullion', async () => {
    const user = userEvent.setup()
    loadTransaction.mockResolvedValue({ serviceType: 'bullion', scenario: 'sell' })
    renderPage()

    await screen.findByRole('radio', { name: 'Yes' })
    await user.click(screen.getByRole('radio', { name: 'Yes' }))
    await user.selectOptions(fieldControl('Recipient'), 'party-1')
    await user.selectOptions(fieldControl('Purpose of the transfer'), 'Collecting bullion')
    await user.selectOptions(fieldControl('Delivery method'), 'Collected')
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByRole('heading', { name: 'Bullion Details' })).toBeInTheDocument()
  })

  it('navigates to /precious-metal-details after a successful save when the transaction service type is precious_metal', async () => {
    const user = userEvent.setup()
    loadTransaction.mockResolvedValue({ serviceType: 'precious_metal', scenario: 'sell' })
    renderPage()

    await screen.findByRole('radio', { name: 'Yes' })
    await user.click(screen.getByRole('radio', { name: 'Yes' }))
    await user.selectOptions(fieldControl('Recipient'), 'party-1')
    await user.selectOptions(fieldControl('Purpose of the transfer'), 'Collecting precious metal')
    await user.selectOptions(fieldControl('Delivery method'), 'Collected')
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByRole('heading', { name: 'Precious Metal Details' })).toBeInTheDocument()
  })

  it('"Same as recorded party" mode shows a dropdown of existing parties', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByRole('radio', { name: 'Yes' })
    await user.click(screen.getByRole('radio', { name: 'Yes' }))

    const select = fieldControl('Recipient')
    expect(select.tagName).toBe('SELECT')
    expect(within(select).getByText('Jane Doe (Individual)')).toBeInTheDocument()
  })

  it('"Different recipient" mode shows manual recipient name and address entry fields', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByRole('radio', { name: 'No' })
    await user.click(screen.getByRole('radio', { name: 'No' }))

    expect(fieldControl('Recipient full name').tagName).toBe('INPUT')
    expect(screen.getByPlaceholderText('Street address')).toBeInTheDocument()
  })

  it('reveals the DOB date picker when "DOB known" is set to yes', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByRole('radio', { name: 'No' })
    await user.click(screen.getByRole('radio', { name: 'No' }))
    expect(screen.queryByText('Recipient date of birth')).not.toBeInTheDocument()

    const dobKnownGroup = fieldControl("Is the recipient's date of birth known?")
    await user.click(within(dobKnownGroup).getByRole('radio', { name: 'Yes' }))

    expect(screen.getByText('Recipient date of birth')).toBeInTheDocument()
  })

  it('purpose of transfer is selected from a fixed four-option dropdown (Collecting bullion / Dropping off bullion / Collecting precious metal / Dropping off precious metal) — not free text', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByRole('radio', { name: 'Yes' })
    await user.click(screen.getByRole('radio', { name: 'Yes' }))

    const select = fieldControl('Purpose of the transfer')
    expect(select.tagName).toBe('SELECT')
    const optionValues = [...select.querySelectorAll('option')].map((o) => o.value)
    expect(optionValues).toEqual(['', 'Collecting bullion', 'Dropping off bullion', 'Collecting precious metal', 'Dropping off precious metal'])
  })

  it('selecting delivery method "Other" reveals and requires a free-text field describing the method', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByRole('radio', { name: 'Yes' })
    await user.click(screen.getByRole('radio', { name: 'Yes' }))
    expect(screen.queryByText('Describe delivery method')).not.toBeInTheDocument()

    await user.selectOptions(fieldControl('Delivery method'), 'Other')
    expect(screen.getByText('Describe delivery method')).toBeInTheDocument()

    await user.selectOptions(fieldControl('Recipient'), 'party-1')
    await user.selectOptions(fieldControl('Purpose of the transfer'), 'Collecting bullion')
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByText('Describe the delivery method.')).toBeInTheDocument()
  })

  it('selecting delivery method "Collected" clears any previously entered "different delivery address" answer and hides that question', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByRole('radio', { name: 'Yes' })
    await user.click(screen.getByRole('radio', { name: 'Yes' }))
    await user.selectOptions(fieldControl('Delivery method'), 'Shipped')
    await user.click(within(fieldControl("Is the delivery address different from the recipient's main address?")).getByRole('radio', { name: 'Yes' }))
    expect(screen.getByPlaceholderText('Street address')).toBeInTheDocument()

    await user.selectOptions(fieldControl('Delivery method'), 'Collected')

    expect(screen.queryByText("Is the delivery address different from the recipient's main address?")).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Street address')).not.toBeInTheDocument()
  })

  it('reveals delivery address fields when the user indicates the delivery address differs', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByRole('radio', { name: 'Yes' })
    await user.click(screen.getByRole('radio', { name: 'Yes' }))
    await user.selectOptions(fieldControl('Delivery method'), 'Shipped')
    expect(screen.queryByPlaceholderText('Street address')).not.toBeInTheDocument()

    const differentAddressGroup = fieldControl("Is the delivery address different from the recipient's main address?")
    await user.click(within(differentAddressGroup).getByRole('radio', { name: 'Yes' }))

    expect(screen.getByPlaceholderText('Street address')).toBeInTheDocument()
  })

  it('Back navigates to /conducting-person — bypassing /id-verification — when there is no individual to verify', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([{ id: 'co-001', type: 'company', displayName: 'Acme Pty Ltd' }])
    loadConductingPerson.mockResolvedValue({ hasConductingPerson: 'no' })
    renderPage()

    await screen.findByRole('radio', { name: 'Yes' })
    await user.click(screen.getByRole('button', { name: 'Back' }))

    expect(await screen.findByRole('heading', { name: 'Conducting Person Details' })).toBeInTheDocument()
  })

  it('Back still navigates to /id-verification when an individual party exists', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByRole('radio', { name: 'Yes' })
    await user.click(screen.getByRole('button', { name: 'Back' }))

    expect(await screen.findByRole('heading', { name: 'ID Verification' })).toBeInTheDocument()
  })
})
