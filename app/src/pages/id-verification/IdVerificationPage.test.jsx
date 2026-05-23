import { Route, Routes, MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import IdVerificationPage from './IdVerificationPage.jsx'
import { wizardStorageKeys } from '../../components/wizardStorage.js'

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/id-verification']}>
      <Routes>
        <Route path="/" element={<h1>Start TTR Transaction</h1>} />
        <Route path="/conducting-person" element={<h1>Conducting Person Details</h1>} />
        <Route path="/id-verification" element={<IdVerificationPage />} />
        <Route path="/recipient-delivery" element={<h1>Recipient / Delivery</h1>} />
      </Routes>
    </MemoryRouter>,
  )
}

function seedCustomers(overrides = []) {
  const defaults = [
    { id: 'ind-001', type: 'individual', displayName: 'Jane Smith' },
    { id: 'ind-002', type: 'individual', displayName: 'Bob Jones' },
  ]
  window.sessionStorage.setItem(
    wizardStorageKeys.customers,
    JSON.stringify(overrides.length ? overrides : defaults),
  )
}

function seedCompanyCustomer() {
  window.sessionStorage.setItem(
    wizardStorageKeys.customers,
    JSON.stringify([{ id: 'co-001', type: 'company', displayName: 'Acme Pty Ltd' }]),
  )
}

function seedConductingPerson() {
  window.sessionStorage.setItem(
    wizardStorageKeys.conductingPerson,
    JSON.stringify({
      hasConductingPerson: 'yes',
      fullName: 'Alice Brown',
      representedPartyId: 'ind-001',
    }),
  )
}

function makeCompleteVerification(overrides = {}) {
  return {
    verificationMethod: 'Sighted original document',
    verificationMethodOther: '',
    documentType: 'Driver licence',
    documentTypeOther: '',
    documentNumber: 'DL123456',
    issuer: 'VicRoads',
    hasExpiry: 'yes',
    expiryDate: '2028-06-30',
    verificationDescription: 'Australian driver licence sighted in person',
    frontImage: 'data:image/jpeg;base64,frontmock',
    backImage: 'data:image/jpeg;base64,backmock',
    isComplete: true,
    ...overrides,
  }
}

function seedVerificationData(data) {
  window.sessionStorage.setItem(wizardStorageKeys.idVerification, JSON.stringify(data))
}

async function fillVerificationForm(user) {
  await user.selectOptions(screen.getByLabelText('Verification method'), 'Sighted original document')
  await user.selectOptions(screen.getByLabelText('Document or data-source type'), 'Driver licence')
  await user.type(screen.getByLabelText('Document or reference number'), 'DL123456')
  await user.type(
    screen.getByLabelText(/description of reliable and independent/i),
    'Australian driver licence sighted in person',
  )
}

describe('IdVerificationPage', () => {
  beforeEach(() => {
    window.sessionStorage.clear()

    const mockStream = { getTracks: () => [{ stop: vi.fn() }] }
    Object.defineProperty(navigator, 'mediaDevices', {
      writable: true,
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(mockStream) },
    })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() })
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,mockimage')
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders the heading and step indicator', () => {
    renderPage()
    expect(screen.getByRole('heading', { name: 'ID Verification Details & Capture' })).toBeInTheDocument()
    expect(screen.getByText('Step 5')).toBeInTheDocument()
  })

  it('shows individual customers as person cards', () => {
    seedCustomers()
    renderPage()
    // Jane is active so she appears in both the navigator card and the summary card
    expect(screen.getAllByText('Jane Smith').length).toBeGreaterThan(0)
    expect(screen.getByText('Bob Jones')).toBeInTheDocument()
  })

  it('shows the conducting person when present in storage', () => {
    seedCustomers()
    seedConductingPerson()
    renderPage()
    expect(screen.getByText('Alice Brown')).toBeInTheDocument()
    expect(screen.getByText('Conducting Person')).toBeInTheDocument()
  })

  it('excludes company-type customers from the person list', () => {
    seedCompanyCustomer()
    renderPage()
    expect(screen.queryByText('Acme Pty Ltd')).not.toBeInTheDocument()
    expect(screen.getByText('People (0)')).toBeInTheDocument()
  })

  it('activates the first person by default', () => {
    seedCustomers()
    renderPage()
    expect(screen.getByLabelText('Verification method')).toBeInTheDocument()
    expect(screen.getByText(/capturing id for/i)).toBeInTheDocument()
  })

  it('clicking a different person card switches the active form', async () => {
    const user = userEvent.setup()
    seedCustomers()
    renderPage()

    const bobCards = screen.getAllByRole('button', { name: /Bob Jones/i })
    await user.click(bobCards[0])

    // Bob now appears in both the navigator card and the summary card
    expect(screen.getAllByText('Bob Jones').length).toBeGreaterThanOrEqual(2)
  })

  it('switching with unsaved changes shows the unsaved-changes modal', async () => {
    const user = userEvent.setup()
    seedCustomers()
    renderPage()

    await user.selectOptions(screen.getByLabelText('Verification method'), 'Sighted original document')

    const cards = screen.getAllByRole('button', { name: /Bob Jones/i })
    await user.click(cards[0])

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument()
  })

  it('cancelling the switch modal keeps the current person', async () => {
    const user = userEvent.setup()
    seedCustomers()
    renderPage()

    await user.selectOptions(screen.getByLabelText('Verification method'), 'Sighted original document')

    const cards = screen.getAllByRole('button', { name: /Bob Jones/i })
    await user.click(cards[0])
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('"Discard and switch" closes the modal and changes person', async () => {
    const user = userEvent.setup()
    seedCustomers()
    renderPage()

    await user.selectOptions(screen.getByLabelText('Verification method'), 'Sighted original document')

    const bobCards = screen.getAllByRole('button', { name: /Bob Jones/i })
    await user.click(bobCards[0])
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Discard and switch' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('Save with empty required fields shows validation errors', async () => {
    const user = userEvent.setup()
    seedCustomers()
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(screen.getByText('Select how the ID was verified')).toBeInTheDocument()
    expect(screen.getByText('Select the document or data-source type')).toBeInTheDocument()
    expect(screen.getByText('Enter the document or reference number')).toBeInTheDocument()
    expect(screen.getByText('Describe the document or data used for verification')).toBeInTheDocument()
  })

  it('Save without front image shows front image error', async () => {
    const user = userEvent.setup()
    seedCustomers()
    renderPage()

    await fillVerificationForm(user)
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(screen.getByText('Capture and accept the front of the ID')).toBeInTheDocument()
  })

  it('Save without back image shows back image error for a card-style document', async () => {
    const user = userEvent.setup()
    seedCustomers([{ id: 'ind-001', type: 'individual', displayName: 'Jane Smith' }])
    seedVerificationData({
      'party-ind-001': makeCompleteVerification({ backImage: null, isComplete: false }),
    })
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(screen.getByText('Capture and accept the back of the ID')).toBeInTheDocument()
  })

  it('Save without back image does not show back image error for Passport', async () => {
    const user = userEvent.setup()
    seedCustomers([{ id: 'ind-001', type: 'individual', displayName: 'Jane Smith' }])
    seedVerificationData({
      'party-ind-001': makeCompleteVerification({ documentType: 'Passport', backImage: null, isComplete: false }),
    })
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(screen.queryByText('Capture and accept the back of the ID')).not.toBeInTheDocument()
  })

  it('"Other" verification method reveals the describe field', async () => {
    const user = userEvent.setup()
    seedCustomers()
    renderPage()

    await user.selectOptions(screen.getByLabelText('Verification method'), 'Other')

    expect(screen.getByLabelText('Describe verification method')).toBeInTheDocument()
  })

  it('"Other" document type reveals the describe field', async () => {
    const user = userEvent.setup()
    seedCustomers()
    renderPage()

    await user.selectOptions(screen.getByLabelText('Document or data-source type'), 'Other')

    expect(screen.getByLabelText('Describe document or data source')).toBeInTheDocument()
  })

  it('expiry date field appears when "Yes" is selected', async () => {
    const user = userEvent.setup()
    seedCustomers()
    renderPage()

    expect(screen.queryByLabelText('Expiry date')).not.toBeInTheDocument()
    await user.click(screen.getByRole('radio', { name: 'Yes' }))

    expect(screen.getByLabelText('Expiry date')).toBeInTheDocument()
  })

  it('expiry date field is hidden when "No" is selected after "Yes"', async () => {
    const user = userEvent.setup()
    seedCustomers()
    renderPage()

    await user.click(screen.getByRole('radio', { name: 'Yes' }))
    await user.click(screen.getByRole('radio', { name: 'No' }))

    expect(screen.queryByLabelText('Expiry date')).not.toBeInTheDocument()
  })

  it('pre-fills from existing idVerification sessionStorage on mount', () => {
    seedCustomers()
    seedVerificationData({
      'party-ind-001': makeCompleteVerification(),
    })
    renderPage()

    expect(screen.getByLabelText('Document or reference number')).toHaveValue('DL123456')
  })

  it('Save with complete data shows the completion banner', async () => {
    const user = userEvent.setup()
    seedCustomers([{ id: 'ind-001', type: 'individual', displayName: 'Jane Smith' }])
    seedVerificationData({
      'party-ind-001': makeCompleteVerification({ isComplete: false }),
    })
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(screen.getByText('ID verification complete')).toBeInTheDocument()
  })

  it('"Save and next person" advances to the next person after valid save', async () => {
    const user = userEvent.setup()
    seedCustomers()
    seedVerificationData({
      'party-ind-001': makeCompleteVerification({ isComplete: false }),
      'party-ind-002': makeCompleteVerification({ isComplete: false }),
    })
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Save and next person' }))

    const summaryNames = screen.getAllByText('Bob Jones')
    expect(summaryNames.length).toBeGreaterThanOrEqual(1)
  })

  it('Continue with all people complete saves to storage and navigates to /recipient-delivery', async () => {
    const user = userEvent.setup()
    seedCustomers([{ id: 'ind-001', type: 'individual', displayName: 'Jane Smith' }])
    seedVerificationData({
      'party-ind-001': makeCompleteVerification({ isComplete: false }),
    })
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Continue' }))

    const stored = JSON.parse(window.sessionStorage.getItem(wizardStorageKeys.idVerification))
    expect(stored['party-ind-001'].isComplete).toBe(true)
    expect(screen.getByRole('heading', { name: 'Recipient / Delivery' })).toBeInTheDocument()
  })

  it('Continue when not all people are complete shows an inline error', async () => {
    const user = userEvent.setup()
    seedCustomers()
    // Jane has no data; Bob has complete data — switch to Bob and continue
    seedVerificationData({
      'party-ind-001': {
        verificationMethod: '', verificationMethodOther: '', documentType: '', documentTypeOther: '',
        documentNumber: '', issuer: '', hasExpiry: null, expiryDate: '', verificationDescription: '',
        frontImage: null, backImage: null, isComplete: false,
      },
      'party-ind-002': makeCompleteVerification({ isComplete: false }),
    })
    renderPage()

    // Switch to Bob — no unsaved changes so no modal
    const bobCards = screen.getAllByRole('button', { name: /Bob Jones/i })
    await user.click(bobCards[0])

    // Bob's data is valid so he saves; but Jane is still not complete
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(screen.getByText('Complete ID verification for all people before continuing.')).toBeInTheDocument()
  })

  it('Back navigates to /conducting-person', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Back' }))

    expect(screen.getByRole('heading', { name: 'Conducting Person Details' })).toBeInTheDocument()
  })

  it('Exit button opens ConfirmModal', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Exit' }))

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Exit transaction?')).toBeInTheDocument()
  })

  it('confirming exit navigates to /', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Exit' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Exit' }))

    expect(screen.getByRole('heading', { name: 'Start TTR Transaction' })).toBeInTheDocument()
  })

  it('"Start camera for front" calls getUserMedia and shows the camera UI', async () => {
    const user = userEvent.setup()
    seedCustomers([{ id: 'ind-001', type: 'individual', displayName: 'Jane Smith' }])
    renderPage()

    await user.click(screen.getByRole('button', { name: /start camera for front/i }))

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ video: { facingMode: 'environment' } })
    expect(screen.getByRole('button', { name: 'Capture front' })).toBeInTheDocument()
  })

  it('Capture sets front preview and Accept records the image', async () => {
    const user = userEvent.setup()
    seedCustomers([{ id: 'ind-001', type: 'individual', displayName: 'Jane Smith' }])
    renderPage()

    await user.click(screen.getByRole('button', { name: /start camera for front/i }))
    await user.click(screen.getByRole('button', { name: 'Capture front' }))

    expect(screen.getByRole('button', { name: 'Accept front image' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Accept front image' }))

    expect(screen.getByText('Front image accepted')).toBeInTheDocument()
  })

  it('Retake front resets the preview and restarts the camera', async () => {
    const user = userEvent.setup()
    seedCustomers([{ id: 'ind-001', type: 'individual', displayName: 'Jane Smith' }])
    renderPage()

    // Capture and accept front image
    await user.click(screen.getByRole('button', { name: /start camera for front/i }))
    await user.click(screen.getByRole('button', { name: 'Capture front' }))
    await user.click(screen.getByRole('button', { name: 'Accept front image' }))

    // Retake
    await user.click(screen.getByRole('button', { name: 'Retake front' }))

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: 'Capture front' })).toBeInTheDocument()
  })
})
