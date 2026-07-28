import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import IdVerificationPage from './IdVerificationPage.jsx'
import {
  deleteTransaction,
  fetchPriorVerifications,
  fetchVerificationForDocument,
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
  fetchVerificationForDocument: vi.fn(),
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
    fetchVerificationForDocument.mockResolvedValue(null)
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

  it('past the re-verification window, offers re-sighting the original alongside manager approval — and says no second copy is taken', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([JANE])
    // Verified well outside the default 730-day window, so eligibility is 'blocked'.
    fetchPriorVerifications.mockResolvedValue([
      { ...ELIGIBLE_PRIOR, created_at: new Date('2020-01-01').toISOString() },
    ])
    renderPage()

    await screen.findByLabelText('Verification method')
    await user.selectOptions(screen.getByLabelText('Verification method'), 'Relied on prior identification')
    await user.click(screen.getByRole('button', { name: /DL999/ }))

    const select = await screen.findByLabelText('Reason for reliance')
    const values = [...select.querySelectorAll('option')].map((o) => o.value).filter(Boolean)
    expect(values).toEqual(['original_document_resighted', 'manager_approved'])

    expect(screen.getByText(/past the 730-day re-verification window/)).toBeInTheDocument()
    expect(screen.getByText(/no second copy is taken/)).toBeInTheDocument()
  })

  // ─── One copy of ID on file (privacy policy §3) ─────────────────────────────

  const ELIGIBLE_PRIOR = {
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
  }

  it('requires a reason when an ID already on file could have been reused but a fresh capture is chosen instead', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([JANE])
    fetchPriorVerifications.mockResolvedValue([ELIGIBLE_PRIOR])
    renderPage()

    await screen.findByLabelText('Verification method')
    // The page auto-selects reliance for an eligible match, so no reason is needed yet.
    expect(screen.queryByLabelText('Reason for taking a new copy')).not.toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText('Verification method'), 'Sighted original document')

    expect(screen.getByLabelText('Reason for taking a new copy')).toBeInTheDocument()
    expect(screen.getByText(/already has ID on file/)).toBeInTheDocument()
  })

  it('blocks continuing past a fresh capture that overrides an ID on file until a reason is given', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([JANE])
    fetchPriorVerifications.mockResolvedValue([ELIGIBLE_PRIOR])
    renderPage()

    await screen.findByLabelText('Verification method')
    await user.selectOptions(screen.getByLabelText('Verification method'), 'Sighted original document')
    await user.click(screen.getByRole('button', { name: /continue/i }))

    expect(
      await screen.findByText(/already has ID on file — give a reason for taking a new copy/),
    ).toBeInTheDocument()
    expect(saveIdVerifications).not.toHaveBeenCalled()
  })

  it('withholds "stored copy is unclear" until a document number is entered that is actually on file — with nothing to link to, that reason could not be saved', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([JANE])
    fetchPriorVerifications.mockResolvedValue([ELIGIBLE_PRIOR])
    fetchVerificationForDocument.mockResolvedValue(null)
    renderPage()

    await screen.findByLabelText('Verification method')
    await user.selectOptions(screen.getByLabelText('Verification method'), 'Sighted original document')

    const select = await screen.findByLabelText('Reason for taking a new copy')
    const values = [...select.querySelectorAll('option')].map((o) => o.value).filter(Boolean)
    // No 'other': privacy policy §3 names exactly two grounds for taking a new copy of
    // an ID already held, so a catch-all cannot be offered. 'different_document' is not
    // a re-copy at all — it is the first copy of a different document.
    expect(values).toEqual(['different_document', 'id_changed'])
  })

  it('offers "presented a different document" when a customer with ID on file hands over a different one — nothing is being re-copied', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([JANE])
    // Licence on file and still reusable, but she presents a passport today.
    fetchPriorVerifications.mockResolvedValue([ELIGIBLE_PRIOR])
    fetchVerificationForDocument.mockResolvedValue(null)
    renderPage()

    await screen.findByLabelText('Verification method')
    // Reliance is auto-selected on the licence, pre-filling its identifiers.
    await user.selectOptions(screen.getByLabelText('Verification method'), 'Sighted original document')
    // Switching away must clear them, or the passport would be filed under DL999.
    expect(screen.getByLabelText(/document or reference number/i)).toHaveValue('')

    await user.selectOptions(screen.getByLabelText('Document or data-source type'), 'Passport')
    await user.type(screen.getByLabelText(/document or reference number/i), 'PA1234567')
    await user.tab()

    await user.selectOptions(await screen.findByLabelText('Reason for taking a new copy'), 'different_document')

    expect(screen.getByText(/additional document for this customer/)).toBeInTheDocument()
    expect(screen.getByLabelText(/document or reference number/i)).toHaveValue('PA1234567')
  })

  it('adopts the stored document\'s identifiers when the stored copy is unclear, so the re-capture replaces that copy rather than adding a second one', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([JANE])
    fetchPriorVerifications.mockResolvedValue([ELIGIBLE_PRIOR])
    fetchVerificationForDocument.mockResolvedValue({ ...ELIGIBLE_PRIOR, document_number: 'DL999' })
    renderPage()

    await screen.findByLabelText('Verification method')
    await user.selectOptions(screen.getByLabelText('Verification method'), 'Sighted original document')
    await user.selectOptions(screen.getByLabelText('Document or data-source type'), 'Driver licence')
    await user.type(screen.getByLabelText(/document or reference number/i), 'DL999')
    await user.tab()

    await user.selectOptions(await screen.findByLabelText('Reason for taking a new copy'), 'stored_copy_unclear')

    expect(screen.getByLabelText(/document or reference number/i)).toHaveValue('DL999')
    expect(screen.getByLabelText('Document or data-source type')).toHaveValue('Driver licence')
    expect(screen.getByText(/replaces it rather than adding a second one/)).toBeInTheDocument()
  })

  it('clears a reason that stops being valid once a collision is discovered', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([JANE])
    fetchPriorVerifications.mockResolvedValue([ELIGIBLE_PRIOR])
    fetchVerificationForDocument.mockResolvedValue(null)
    renderPage()

    await screen.findByLabelText('Verification method')
    await user.selectOptions(screen.getByLabelText('Verification method'), 'Sighted original document')
    // Valid while nothing collides — this document has never been seen. Once a collision
    // appears it becomes unsavable, because 'different_document' never links and an
    // unlinked row for a number already on file is rejected by uq_idv_doc_new_capture.
    await user.selectOptions(await screen.findByLabelText('Reason for taking a new copy'), 'different_document')
    expect(screen.getByLabelText('Reason for taking a new copy')).toHaveValue('different_document')

    // Typing a number that is already on file removes it from the options.
    fetchVerificationForDocument.mockResolvedValue(ON_FILE)
    await user.selectOptions(screen.getByLabelText('Document or data-source type'), 'Driver licence')
    await user.type(screen.getByLabelText(/document or reference number/i), 'DL987654321')
    await user.tab()

    await waitFor(() => {
      expect(screen.getByLabelText('Reason for taking a new copy')).toHaveValue('')
    })
  })

  it('does not ask for a reason when the customer has no ID on file that could have been reused', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([JANE])
    fetchPriorVerifications.mockResolvedValue([])
    renderPage()

    await screen.findByLabelText('Verification method')
    await user.selectOptions(screen.getByLabelText('Verification method'), 'Sighted original document')

    expect(screen.queryByLabelText('Reason for taking a new copy')).not.toBeInTheDocument()
  })

  it('does not ask for a reason when the only prior record is outside the reliance window, since it was not reusable anyway', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([JANE])
    fetchPriorVerifications.mockResolvedValue([
      { ...ELIGIBLE_PRIOR, created_at: new Date('2020-01-01').toISOString() },
    ])
    renderPage()

    await screen.findByLabelText('Verification method')
    await user.selectOptions(screen.getByLabelText('Verification method'), 'Sighted original document')

    expect(screen.queryByLabelText('Reason for taking a new copy')).not.toBeInTheDocument()
  })

  // ─── Document-number collision (covers conducting persons too) ──────────────

  const ON_FILE = {
    id: 'idv-on-file',
    document_type: 'Driver licence',
    document_number: 'DL987654321',
    issuer: 'VicRoads',
    created_at: new Date('2026-02-01').toISOString(),
    has_expiry: false,
    expiry_date: null,
    verified_by_name: 'Prior Staff',
    transaction_ref: 'INV-OLD',
    front_image_id: null,
    back_image_id: null,
  }

  async function enterDocument(user, { type = 'Driver licence', number = 'DL987654321' } = {}) {
    await user.selectOptions(screen.getByLabelText('Verification method'), 'Sighted original document')
    await user.selectOptions(screen.getByLabelText('Document or data-source type'), type)
    await user.type(screen.getByLabelText(/document or reference number/i), number)
    await user.tab()
  }

  it('detects a document already on file for a conducting person, who has no name-based prior lookup at all', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([])
    loadConductingPerson.mockResolvedValue({ hasConductingPerson: 'yes', fullName: 'Tom Employee', id: 'cp-1' })
    // Name lookup returns nothing for a conducting person by design; the collision
    // check is their only route to reuse.
    fetchPriorVerifications.mockResolvedValue([])
    fetchVerificationForDocument.mockResolvedValue(ON_FILE)
    renderPage()

    await screen.findByLabelText('Verification method')
    await enterDocument(user)

    expect(await screen.findByLabelText('Reason for taking a new copy')).toBeInTheDocument()
    expect(screen.getByText(/DL987654321 is already on file/)).toBeInTheDocument()
  })

  it('queries the collision lookup with the entered document type and number', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([JANE])
    renderPage()

    await screen.findByLabelText('Verification method')
    await enterDocument(user, { type: 'Passport', number: 'PA1234567' })

    await waitFor(() => {
      expect(fetchVerificationForDocument).toHaveBeenCalledWith(
        expect.objectContaining({ documentType: 'Passport', documentNumber: 'PA1234567' }),
      )
    })
  })

  it('offers only reasons that can actually be saved against a colliding document number', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([JANE])
    fetchVerificationForDocument.mockResolvedValue(ON_FILE)
    renderPage()

    await screen.findByLabelText('Verification method')
    await enterDocument(user)

    const select = await screen.findByLabelText('Reason for taking a new copy')
    const values = [...select.querySelectorAll('option')].map((o) => o.value).filter(Boolean)
    expect(values).toEqual(['id_changed', 'stored_copy_unclear', 'different_person'])
  })

  it('never offers a catch-all reason, in any collision state — privacy policy §3 names exactly two grounds', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([JANE])
    fetchPriorVerifications.mockResolvedValue([ELIGIBLE_PRIOR])
    renderPage()

    await screen.findByLabelText('Verification method')

    // No collision: the customer has ID on file but this document has never been seen.
    fetchVerificationForDocument.mockResolvedValue(null)
    await user.selectOptions(screen.getByLabelText('Verification method'), 'Sighted original document')
    let select = await screen.findByLabelText('Reason for taking a new copy')
    expect([...select.querySelectorAll('option')].map((o) => o.value)).not.toContain('other')

    // Collision with the same person.
    fetchVerificationForDocument.mockResolvedValue(ON_FILE)
    await enterDocument(user)
    select = await screen.findByLabelText('Reason for taking a new copy')
    expect([...select.querySelectorAll('option')].map((o) => o.value)).not.toContain('other')
  })

  it('links a renewed licence to the record on file — the number is unchanged, so an unlinked row could not save', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([JANE])
    fetchVerificationForDocument.mockResolvedValue(ON_FILE)
    renderPage()

    await screen.findByLabelText('Verification method')
    await enterDocument(user)
    await user.selectOptions(await screen.findByLabelText('Reason for taking a new copy'), 'id_changed')

    expect(screen.getByText(/same number after renewal/)).toBeInTheDocument()
  })

  it('does not link when the reason is that this is a different person sharing the number', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([JANE])
    fetchVerificationForDocument.mockResolvedValue(ON_FILE)
    renderPage()

    await screen.findByLabelText('Verification method')
    await enterDocument(user)
    await user.selectOptions(await screen.findByLabelText('Reason for taking a new copy'), 'different_person')

    expect(screen.getByText(/Recorded as a separate person/)).toBeInTheDocument()
  })

  it('asks for no reason when the document number is not already on file', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([JANE])
    fetchVerificationForDocument.mockResolvedValue(null)
    renderPage()

    await screen.findByLabelText('Verification method')
    await enterDocument(user, { number: 'DL000000001' })

    expect(screen.queryByLabelText('Reason for taking a new copy')).not.toBeInTheDocument()
  })

  // ─── The document on file belongs to someone else (UAT finding #8) ──────────
  //
  // Licence numbers are unique per state, not nationally, so two real people can share
  // one. 'different_person' exists to record exactly that. The other two reasons assert
  // continuity of ONE person's document — "their ID changed", "the stored copy of it is
  // unclear" — which is false across two people, and linking on that basis wired one
  // customer's capture to another's record in the R11–R27 pass.

  const OTHER_PERSON_ON_FILE = {
    ...ON_FILE,
    owner_kind: 'party',
    owner_name: 'Regina Mae Testworth',
    owner_dob: '1983-05-12', // JANE is 1990-04-15
  }

  it('offers only "different person" when the colliding document belongs to someone else', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([JANE])
    fetchVerificationForDocument.mockResolvedValue(OTHER_PERSON_ON_FILE)
    renderPage()

    await screen.findByLabelText('Verification method')
    await enterDocument(user)

    const select = await screen.findByLabelText('Reason for taking a new copy')
    const values = [...select.querySelectorAll('option')].map((o) => o.value).filter(Boolean)
    expect(values).toEqual(['different_person'])
  })

  it('names the person the colliding document is on file for, so "different person" is an informed assertion', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([JANE])
    fetchVerificationForDocument.mockResolvedValue(OTHER_PERSON_ON_FILE)
    renderPage()

    await screen.findByLabelText('Verification method')
    await enterDocument(user)

    await screen.findByLabelText('Reason for taking a new copy')
    expect(screen.getByText(/Regina Mae Testworth/)).toBeInTheDocument()
    expect(screen.getByText(/a different person/)).toBeInTheDocument()
  })

  it('still offers all three reasons when the colliding document belongs to the same person', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([JANE])
    fetchVerificationForDocument.mockResolvedValue({ ...OTHER_PERSON_ON_FILE, owner_dob: JANE.dateOfBirth })
    renderPage()

    await screen.findByLabelText('Verification method')
    await enterDocument(user)

    const select = await screen.findByLabelText('Reason for taking a new copy')
    const values = [...select.querySelectorAll('option')].map((o) => o.value).filter(Boolean)
    expect(values).toEqual(['id_changed', 'stored_copy_unclear', 'different_person'])
  })

  it('does not narrow the reasons when the owner has no recorded date of birth — the test cannot fire, so it must not guess', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([JANE])
    fetchVerificationForDocument.mockResolvedValue({ ...OTHER_PERSON_ON_FILE, owner_dob: null })
    renderPage()

    await screen.findByLabelText('Verification method')
    await enterDocument(user)

    const select = await screen.findByLabelText('Reason for taking a new copy')
    const values = [...select.querySelectorAll('option')].map((o) => o.value).filter(Boolean)
    expect(values).toEqual(['id_changed', 'stored_copy_unclear', 'different_person'])
  })

  // ─── Expiry on a linked re-capture (UAT finding #11) ────────────────────────

  const ON_FILE_WITH_EXPIRY = {
    ...ON_FILE,
    has_expiry: true,
    expiry_date: '2030-05-12',
  }

  it('carries the expiry across when the stored copy is unclear — the same physical card cannot have a different expiry', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([JANE])
    fetchVerificationForDocument.mockResolvedValue(ON_FILE_WITH_EXPIRY)
    renderPage()

    await screen.findByLabelText('Verification method')
    await enterDocument(user)
    await user.selectOptions(await screen.findByLabelText('Reason for taking a new copy'), 'stored_copy_unclear')

    // Converted to the radios' 'yes'/'no' vocabulary, not passed through as a boolean —
    // a raw boolean reads as unselected and silently resets (the fix #4/#5 bug class).
    const yesRadio = screen.getByRole('radio', { name: 'Yes' })
    expect(yesRadio).toBeChecked()
    expect(await screen.findByLabelText('Expiry date')).toHaveValue('12/05/2030')
  })

  it('leaves the expiry blank on a renewed licence — the number survives renewal but the expiry does not', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([JANE])
    fetchVerificationForDocument.mockResolvedValue(ON_FILE_WITH_EXPIRY)
    renderPage()

    await screen.findByLabelText('Verification method')
    await enterDocument(user)
    await user.selectOptions(await screen.findByLabelText('Reason for taking a new copy'), 'id_changed')

    // Pre-filling the superseded date is the value most likely to be accepted unchanged
    // by a busy operator, so it is deliberately cleared instead.
    expect(screen.getByRole('radio', { name: 'Yes' })).not.toBeChecked()
    expect(screen.getByRole('radio', { name: 'No' })).not.toBeChecked()
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

  // ─── Recovering from a failed save (UAT finding #12) ────────────────────────
  //
  // Uploads happen before the save, and object paths are deterministic. Previously the
  // new image ids lived only in handleContinue's local `updated`, which was discarded
  // when saveIdVerifications threw — so the retry re-uploaded to a path that already
  // existed, upload-id-image rejected it, and the operator could neither continue nor
  // cancel. Any failure at this step did it: a duplicate number, a dropped connection.

  it('does not re-upload images when retrying after a failed save', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([JANE])
    uploadIdImage.mockResolvedValue({ id: 'img-front-1' })
    // Fails once — a rejected save, a network blip, anything — then succeeds.
    saveIdVerifications
      .mockRejectedValueOnce(new Error('Network request failed'))
      .mockResolvedValueOnce(undefined)
    renderPage()

    await screen.findByLabelText('Verification method')
    await user.selectOptions(screen.getByLabelText('Verification method'), 'Sighted original document')
    await user.selectOptions(screen.getByLabelText('Document or data-source type'), 'Passport')
    await user.type(screen.getByLabelText('Document or reference number'), 'P123456')

    await user.click(screen.getByRole('button', { name: /start camera for front/i }))
    await user.click(screen.getByRole('button', { name: 'Capture front' }))
    await user.click(screen.getByRole('button', { name: 'Accept front image' }))

    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(saveIdVerifications).toHaveBeenCalledTimes(1))
    expect(uploadIdImage).toHaveBeenCalledTimes(1)

    // The retry must differ from the first attempt only in what previously failed.
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() => expect(saveIdVerifications).toHaveBeenCalledTimes(2))
    expect(uploadIdImage).toHaveBeenCalledTimes(1)
  })

  it('carries the uploaded image id into the retry, so the record still points at the stored image', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([JANE])
    uploadIdImage.mockResolvedValue({ id: 'img-front-1' })
    saveIdVerifications
      .mockRejectedValueOnce(new Error('Network request failed'))
      .mockResolvedValueOnce(undefined)
    renderPage()

    await screen.findByLabelText('Verification method')
    await user.selectOptions(screen.getByLabelText('Verification method'), 'Sighted original document')
    await user.selectOptions(screen.getByLabelText('Document or data-source type'), 'Passport')
    await user.type(screen.getByLabelText('Document or reference number'), 'P123456')

    await user.click(screen.getByRole('button', { name: /start camera for front/i }))
    await user.click(screen.getByRole('button', { name: 'Capture front' }))
    await user.click(screen.getByRole('button', { name: 'Accept front image' }))

    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(saveIdVerifications).toHaveBeenCalledTimes(1))
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(saveIdVerifications).toHaveBeenCalledTimes(2))

    // Skipping the upload is only correct if the id it produced survived — otherwise the
    // retry would save a verification with no image against a stored object.
    const [payload] = saveIdVerifications.mock.calls[1]
    expect(payload['party-ind-001'].frontImageId).toBe('img-front-1')
  })

  // ─── The reason and the collision can arrive in either order (finding #19) ──
  //
  // The reason field appears as soon as a verification method is chosen, so staff can pick
  // one before typing the document number. handleCaptureReasonChange runs at selection
  // time, when there is nothing to link to, so it set no prior_verification_id — and
  // checkDocumentCollision only ever CLEARED a reason that had become invalid, never
  // linked one that was still valid. The row saved unlinked, collided with
  // uq_idv_doc_new_capture, and the operator was told "already on file" with no way
  // forward but re-picking the same reason.

  it('links a reason that was chosen before the collision was discovered', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([JANE])
    fetchPriorVerifications.mockResolvedValue([ELIGIBLE_PRIOR])
    fetchVerificationForDocument.mockResolvedValue(null)
    renderPage()

    await screen.findByLabelText('Verification method')
    await user.selectOptions(screen.getByLabelText('Verification method'), 'Sighted original document')

    // Chosen while nothing collides — valid, but nothing to link to yet.
    await user.selectOptions(await screen.findByLabelText('Reason for taking a new copy'), 'id_changed')

    // Now the collision appears.
    fetchVerificationForDocument.mockResolvedValue(ON_FILE)
    await enterDocument(user)
    await waitFor(() =>
      expect(screen.getByLabelText('Reason for taking a new copy')).toHaveValue('id_changed'))

    // Driver licence needs both sides.
    await user.click(screen.getByRole('button', { name: /start camera for front/i }))
    await user.click(screen.getByRole('button', { name: 'Capture front' }))
    await user.click(screen.getByRole('button', { name: 'Accept front image' }))
    await user.click(screen.getByRole('button', { name: /start camera for back/i }))
    await user.click(screen.getByRole('button', { name: 'Capture back' }))
    await user.click(screen.getByRole('button', { name: 'Accept back image' }))

    await user.click(screen.getByRole('button', { name: 'Continue' }))

    // The link is only observable in what gets saved — the helper text is gated on the
    // reason and the collision, not on prior_verification_id, so it is no evidence of one.
    // Unlinked, this row collides with uq_idv_doc_new_capture and the save is rejected.
    await waitFor(() => expect(saveIdVerifications).toHaveBeenCalled())
    const [payload] = saveIdVerifications.mock.calls[0]
    expect(payload['party-ind-001'].priorVerificationId).toBe(ON_FILE.id)
  })

  it('does not discard an expiry the operator already typed when it establishes that link', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([JANE])
    fetchPriorVerifications.mockResolvedValue([ELIGIBLE_PRIOR])
    fetchVerificationForDocument.mockResolvedValue(null)
    renderPage()

    await screen.findByLabelText('Verification method')
    await user.selectOptions(screen.getByLabelText('Verification method'), 'Sighted original document')
    await user.selectOptions(await screen.findByLabelText('Reason for taking a new copy'), 'id_changed')

    await user.click(screen.getByRole('radio', { name: 'Yes' }))
    await user.type(await screen.findByLabelText('Expiry date'), '12/05/2035')

    fetchVerificationForDocument.mockResolvedValue(ON_FILE)
    await enterDocument(user)

    // Linking must set ONLY the link. Re-running the whole reason handler would reset
    // expiry — and for a renewal it clears it, silently wiping what was just entered.
    await waitFor(() => expect(screen.getByLabelText('Expiry date')).toHaveValue('12/05/2035'))
  })

  // ─── Entry order no longer matters (UAT finding #14) ────────────────────────

  it('re-runs the collision check when the document type changes, so number-then-type still detects it', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([JANE])
    renderPage()

    await screen.findByLabelText('Verification method')
    await user.selectOptions(screen.getByLabelText('Verification method'), 'Sighted original document')

    // Deliberately the "wrong" order: number first, while the type is still blank.
    await user.type(screen.getByLabelText(/document or reference number/i), 'DL987654321')
    await user.tab()
    // That blur cannot find anything — the lookup is keyed on (type, number).
    expect(fetchVerificationForDocument).not.toHaveBeenCalled()

    await user.selectOptions(screen.getByLabelText('Document or data-source type'), 'Driver licence')

    // Choosing the type must re-run it rather than leaving the collision undetected.
    await waitFor(() => {
      expect(fetchVerificationForDocument).toHaveBeenCalledWith(
        expect.objectContaining({ documentType: 'Driver licence', documentNumber: 'DL987654321' }),
      )
    })
  })
})
