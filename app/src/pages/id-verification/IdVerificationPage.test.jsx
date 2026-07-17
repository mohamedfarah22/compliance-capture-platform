import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import IdVerificationPage from './IdVerificationPage.jsx'
import {
  deleteTransaction,
  fetchPriorVerifications,
  getIdImageSignedUrls,
  getTransactionId,
  loadConductingPerson,
  loadCustomers,
  loadIdVerifications,
  saveIdVerifications,
  uploadIdImage,
} from '../../lib/wizardApi.js'
import { useAuth } from '../../context/AuthContext.jsx'

vi.mock('../../lib/wizardApi.js', () => ({
  deleteTransaction: vi.fn(),
  fetchPriorVerifications: vi.fn(),
  getIdImageSignedUrls: vi.fn(),
  getTransactionId: vi.fn(),
  loadConductingPerson: vi.fn(),
  loadCustomers: vi.fn(),
  loadIdVerifications: vi.fn(),
  saveIdVerifications: vi.fn(),
  uploadIdImage: vi.fn(),
}))

vi.mock('../../context/AuthContext.jsx', () => ({
  useAuth: vi.fn(),
}))

const JANE = { id: 'ind-001', type: 'individual', displayName: 'Jane Smith', firstName: 'Jane', lastName: 'Smith', dateOfBirth: '1990-04-15' }
const BOB = { id: 'ind-002', type: 'individual', displayName: 'Bob Jones', firstName: 'Bob', lastName: 'Jones', dateOfBirth: '1985-01-01' }

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

function completeVerification(overrides = {}) {
  return {
    verificationMethod: 'Sighted original document',
    verificationMethodOther: '',
    documentType: 'Passport',
    documentTypeOther: '',
    documentNumber: 'P123456',
    issuer: 'Australian Passport Office',
    hasExpiry: 'no',
    expiryDate: '',
    verificationDescription: 'Passport sighted in person',
    elecDataSrc: '',
    frontImageId: 'front-img-1',
    backImageId: null,
    isComplete: false,
    priorVerificationId: null,
    priorVerificationSummary: null,
    relianceReason: null,
    imageApproved: false,
    idCountryCode: 'AU',
    ...overrides,
  }
}

describe('IdVerificationPage', () => {
  beforeEach(() => {
    useAuth.mockReturnValue({ reportingEntity: null, staffMember: { full_name: 'Jane Staff' }, canApproveReports: false, signOut: vi.fn() })
    deleteTransaction.mockResolvedValue(undefined)
    getTransactionId.mockReturnValue('tx-1')
    loadCustomers.mockResolvedValue([JANE, BOB])
    loadConductingPerson.mockResolvedValue({ hasConductingPerson: 'no' })
    loadIdVerifications.mockResolvedValue({})
    fetchPriorVerifications.mockResolvedValue([])
    getIdImageSignedUrls.mockResolvedValue({})
    saveIdVerifications.mockResolvedValue(undefined)
    uploadIdImage.mockResolvedValue({ imageId: 'uploaded-1', path: 'x', sha256: 'y' })

    const mockStream = { getTracks: () => [{ stop: vi.fn() }] }
    Object.defineProperty(navigator, 'mediaDevices', {
      writable: true,
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(mockStream) },
    })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() })
    // Must be valid, correctly-padded base64 — handleContinue's base64ToBlob() calls atob() on this.
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(`data:image/jpeg;base64,${btoa('mock-image-data')}`)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders all individual parties plus the conducting person in the person navigator', async () => {
    loadConductingPerson.mockResolvedValue({ hasConductingPerson: 'yes', fullName: 'Alice Brown', representedPartyId: 'ind-001', id: 'cp-1' })
    renderPage()

    expect(await screen.findByText('People (3)')).toBeInTheDocument()
    expect(screen.getAllByText('Jane Smith').length).toBeGreaterThan(0)
    expect(screen.getByText('Bob Jones')).toBeInTheDocument()
    expect(screen.getByText('Alice Brown')).toBeInTheDocument()
  })

  it('shows a "no verification required" message and a working Continue button when there are no individuals to verify (company-only customer, impersonal channel)', async () => {
    const user = userEvent.setup()
    const COMPANY = { id: 'co-001', type: 'company', displayName: 'Southern Cross Metals Trust' }
    loadCustomers.mockResolvedValue([COMPANY])
    loadConductingPerson.mockResolvedValue({ hasConductingPerson: 'no' })
    renderPage()

    expect(await screen.findByText('People (0)')).toBeInTheDocument()
    expect(screen.getByText('No individual identification is required for this transaction.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByRole('heading', { name: 'Recipient / Delivery' })).toBeInTheDocument()
    expect(saveIdVerifications).not.toHaveBeenCalled()
  })

  it('shows a validation error when verification method is not selected on save', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByLabelText('Verification method')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Select how the ID was verified')).toBeInTheDocument()
    expect(saveIdVerifications).not.toHaveBeenCalled()
  })

  it('shows validation errors when document type or reference number are empty', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByLabelText('Verification method')
    await user.selectOptions(screen.getByLabelText('Verification method'), 'Sighted original document')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Select the document or data-source type')).toBeInTheDocument()
    expect(screen.getByText('Enter the document or reference number')).toBeInTheDocument()
  })

  it('requires a front image upload when verification method is not reliance-based', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByLabelText('Verification method')
    await user.selectOptions(screen.getByLabelText('Verification method'), 'Sighted original document')
    await user.selectOptions(screen.getByLabelText('Document or data-source type'), 'Passport')
    await user.type(screen.getByLabelText('Document or reference number'), 'P123456')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Capture and accept the front of the ID')).toBeInTheDocument()
  })

  it('shows a validation error when reason for reliance is not selected in reliance mode', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([JANE])
    fetchPriorVerifications.mockResolvedValue([{
      id: 'prior-1',
      document_type: 'Driver licence',
      document_number: 'DL999',
      issuer: 'VicRoads',
      created_at: new Date('2026-01-01').toISOString(),
      has_expiry: false,
      expiry_date: null,
      verified_by_name: 'Prior Staff',
      transaction_ref: 'INV-OLD',
      front_image_id: null,
      back_image_id: null,
    }])
    loadIdVerifications.mockResolvedValue({
      'party-ind-001': completeVerification({
        verificationMethod: 'Relied on prior identification',
        priorVerificationId: 'prior-1',
        priorVerificationSummary: { documentType: 'Driver licence', documentNumber: 'DL999', verifiedDate: '1 Jan 2026', verifiedBy: 'Prior Staff' },
        relianceReason: null,
        documentNumber: 'DL999',
      }),
    })
    renderPage()

    await screen.findByLabelText('Verification method')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Select a reason for reliance')).toBeInTheDocument()
    expect(saveIdVerifications).not.toHaveBeenCalled()
  })

  it('prevents navigation to the next page until every listed person has a complete verification record', async () => {
    const user = userEvent.setup()
    loadIdVerifications.mockResolvedValue({
      'party-ind-002': completeVerification({ isComplete: true }),
    })
    renderPage()

    await screen.findAllByText('Jane Smith')
    const bobCards = screen.getAllByRole('button', { name: /Bob Jones/i })
    await user.click(bobCards[0])

    await screen.findByLabelText('Document or reference number')
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByText('Complete ID verification for all people before continuing.')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Recipient / Delivery' })).not.toBeInTheDocument()
  })

  it('calls saveIdVerifications() with all person verification records on continue', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([JANE])
    loadIdVerifications.mockResolvedValue({
      'party-ind-001': completeVerification(),
    })
    renderPage()

    await screen.findByLabelText('Verification method')
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() => {
      expect(saveIdVerifications).toHaveBeenCalledWith(
        expect.objectContaining({
          'party-ind-001': expect.objectContaining({ isComplete: true, documentNumber: 'P123456' }),
        }),
      )
    })
    expect(await screen.findByRole('heading', { name: 'Recipient / Delivery' })).toBeInTheDocument()
  })

  it('requires a back image only when the document type is Driver licence', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([JANE])
    renderPage()

    await screen.findByLabelText('Verification method')
    await user.selectOptions(screen.getByLabelText('Verification method'), 'Sighted original document')
    await user.selectOptions(screen.getByLabelText('Document or data-source type'), 'Driver licence')
    await user.type(screen.getByLabelText('Document or reference number'), 'DL123456')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Capture and accept the back of the ID')).toBeInTheDocument()
  })

  it('does not require a back image when the document type is Passport', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([JANE])
    renderPage()

    await screen.findByLabelText('Verification method')
    await user.selectOptions(screen.getByLabelText('Verification method'), 'Sighted original document')
    await user.selectOptions(screen.getByLabelText('Document or data-source type'), 'Passport')
    await user.type(screen.getByLabelText('Document or reference number'), 'P123456')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(screen.queryByText('Capture and accept the back of the ID')).not.toBeInTheDocument()
  })

  it('hides the image capture section when verification method is "Relied on prior identification"', async () => {
    loadCustomers.mockResolvedValue([JANE])
    fetchPriorVerifications.mockResolvedValue([{
      id: 'prior-1',
      document_type: 'Driver licence',
      document_number: 'DL999',
      issuer: 'VicRoads',
      created_at: new Date('2026-01-01').toISOString(),
      has_expiry: false,
      expiry_date: null,
      verified_by_name: 'Prior Staff',
      transaction_ref: 'INV-OLD',
      front_image_id: null,
      back_image_id: null,
    }])
    renderPage()

    await screen.findByLabelText('Verification method')

    expect(screen.queryByText('Start camera for front')).not.toBeInTheDocument()
  })

  it('shows the prior verification search picker in reliance mode', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([JANE])
    // Verified far outside the default 730-day reliance window, so it's listed but not
    // auto-selected — this exercises the manual search/pick UI rather than the auto-fill path.
    fetchPriorVerifications.mockResolvedValue([{
      id: 'prior-1',
      document_type: 'Driver licence',
      document_number: 'DL999',
      issuer: 'VicRoads',
      created_at: new Date('2020-01-01').toISOString(),
      has_expiry: false,
      expiry_date: null,
      verified_by_name: 'Prior Staff',
      transaction_ref: 'INV-OLD',
      front_image_id: null,
      back_image_id: null,
    }])
    renderPage()

    await screen.findByLabelText('Verification method')
    await user.selectOptions(screen.getByLabelText('Verification method'), 'Relied on prior identification')

    expect(screen.getByLabelText('Search prior verifications')).toBeInTheDocument()
    expect(screen.getByText(/DL999/)).toBeInTheDocument()
  })

  it('shows an unsaved changes confirmation modal when switching to another person with pending edits', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByLabelText('Verification method')
    await user.selectOptions(screen.getByLabelText('Verification method'), 'Sighted original document')

    const bobCards = screen.getAllByRole('button', { name: /Bob Jones/i })
    await user.click(bobCards[0])

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument()
  })

  it('the selected document type is stored as its human-readable label (e.g. "Driver licence") in the ID verification record — AUSTRAC IdType code translation happens later, at report-generation time, not at capture time', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([JANE])
    renderPage()

    await screen.findByLabelText('Verification method')
    await user.selectOptions(screen.getByLabelText('Verification method'), 'Sighted original document')
    await user.selectOptions(screen.getByLabelText('Document or data-source type'), 'Passport')
    await user.type(screen.getByLabelText('Document or reference number'), 'P123456')
    await user.click(screen.getByRole('button', { name: /start camera for front/i }))
    await user.click(screen.getByRole('button', { name: 'Capture front' }))
    await user.click(screen.getByRole('button', { name: 'Accept front image' }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() => {
      expect(saveIdVerifications).toHaveBeenCalledWith(
        expect.objectContaining({
          'party-ind-001': expect.objectContaining({ documentType: 'Passport' }),
        }),
      )
    })
  })

  it('calls uploadIdImage() for each captured image with the correct personType, personId, and side', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([JANE])
    renderPage()

    await screen.findByLabelText('Verification method')
    await user.selectOptions(screen.getByLabelText('Verification method'), 'Sighted original document')
    await user.selectOptions(screen.getByLabelText('Document or data-source type'), 'Passport')
    await user.type(screen.getByLabelText('Document or reference number'), 'P123456')

    await user.click(screen.getByRole('button', { name: /start camera for front/i }))
    await user.click(screen.getByRole('button', { name: 'Capture front' }))
    await user.click(screen.getByRole('button', { name: 'Accept front image' }))

    await user.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() => {
      expect(uploadIdImage).toHaveBeenCalledWith(
        expect.objectContaining({ transactionId: 'tx-1', personType: 'party', personId: 'ind-001', side: 'front' }),
      )
    })
  })
})
