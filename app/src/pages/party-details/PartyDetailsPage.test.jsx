import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import PartyDetailsPage from './PartyDetailsPage.jsx'
import { deleteTransaction, loadCustomers, saveCustomers } from '../../lib/wizardApi.js'
import { useAuth } from '../../context/AuthContext.jsx'

vi.mock('../../lib/wizardApi.js', () => ({
  deleteTransaction: vi.fn(),
  loadCustomers: vi.fn(),
  saveCustomers: vi.fn(),
}))

vi.mock('../../context/AuthContext.jsx', () => ({
  useAuth: vi.fn(),
}))

const INDIVIDUAL_PARTY = {
  id: 'party-1',
  type: 'individual',
  isComplete: false,
  fullName: '',
  displayName: 'Jane Doe',
  aliases: [],
  residentialAddress: { street: '', suburb: '', state: '', postcode: '', country: 'Australia' },
  hasPostalAddress: false,
  postalAddress: { street: '', suburb: '', state: '', postcode: '', country: 'Australia' },
  phone: '',
  occupation: '',
  gender: '',
  citizenshipCountryCode: 'AU',
  taxResidencyCountryCode: 'AU',
}

// fullName falls back to displayName when blank (see PartyDetailsPage.loadPartyData) — this
// fixture has neither, so the "full legal name" field genuinely renders empty for validation tests.
const EMPTY_INDIVIDUAL_PARTY = { ...INDIVIDUAL_PARTY, displayName: '', citizenshipCountryCode: '', taxResidencyCountryCode: '' }

const COMPANY_PARTY = {
  id: 'party-2',
  type: 'company',
  isComplete: false,
  entityName: '',
  displayName: 'Acme Pty Ltd',
  businessAddress: { street: '', suburb: '', state: '', postcode: '', country: 'Australia' },
  hasCompanyPostalAddress: false,
  companyPostalAddress: { street: '', suburb: '', state: '', postcode: '', country: 'Australia' },
  legalForm: '',
  companyPhone: '',
  registrationIdentifierType: 'ABN',
  registrationIdentifier: '',
  principalActivity: '',
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/party-details']}>
      <Routes>
        <Route path="/transaction-details" element={<h1>Transaction Details</h1>} />
        <Route path="/party-details" element={<PartyDetailsPage />} />
        <Route path="/conducting-person" element={<h1>Conducting Person</h1>} />
        <Route path="/" element={<h1>Start TTR Transaction</h1>} />
      </Routes>
    </MemoryRouter>,
  )
}

async function fillIndividualForm(user) {
  // fullName is pre-filled from the loaded party's displayName as a fallback — clear before typing.
  await user.clear(screen.getByLabelText('Full legal name'))
  await user.type(screen.getByLabelText('Full legal name'), 'Jane Doe')
  await user.type(screen.getByPlaceholderText('Select date of birth'), '15/06/1985')
  await user.type(screen.getByLabelText('Street address'), '1 Main St')
  await user.type(screen.getByLabelText('Suburb'), 'Coburg')
  await user.selectOptions(screen.getByLabelText('State'), 'VIC')
  await user.type(screen.getByLabelText('Postcode'), '3058')
  await user.type(screen.getByLabelText('Phone number'), '0400000000')
  await user.type(screen.getByLabelText('Occupation or principal activity'), 'Jeweller')
  await user.selectOptions(screen.getByLabelText('Gender'), 'F')
}

describe('PartyDetailsPage', () => {
  beforeEach(() => {
    useAuth.mockReturnValue({ staffMember: { full_name: 'Jane Staff' }, canApproveReports: false, signOut: vi.fn() })
    deleteTransaction.mockResolvedValue(undefined)
    saveCustomers.mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders a navigator card for each party loaded from the DB', async () => {
    loadCustomers.mockResolvedValue([INDIVIDUAL_PARTY, COMPANY_PARTY])
    renderPage()

    expect((await screen.findAllByText('Jane Doe')).length).toBeGreaterThan(0)
    expect(screen.getByText('Acme Pty Ltd')).toBeInTheDocument()
    expect(screen.getByText('Parties (2)')).toBeInTheDocument()
  })

  it('individual: shows validation errors when fullLegalName, DOB, phone, occupation, gender, citizenshipCountryCode, or taxResidencyCountryCode are empty', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([EMPTY_INDIVIDUAL_PARTY])
    renderPage()

    await screen.findByLabelText('Full legal name')
    // citizenshipCountryCode/taxResidencyCountryCode always default to 'AU' on load (see
    // PartyDetailsPage.loadPartyData) — clear them to exercise the required-field validation.
    await user.clear(screen.getByLabelText('Citizenship country'))
    await user.clear(screen.getByLabelText('Tax residency country'))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Enter the full legal name.')).toBeInTheDocument()
    expect(screen.getByText('Enter the date of birth.')).toBeInTheDocument()
    expect(screen.getByText('Enter the phone number.')).toBeInTheDocument()
    expect(screen.getByText('Enter the occupation or principal activity.')).toBeInTheDocument()
    expect(screen.getByText('Select the gender.')).toBeInTheDocument()
    expect(screen.getByText('Enter the citizenship country code.')).toBeInTheDocument()
    expect(screen.getByText('Enter the tax residency country code.')).toBeInTheDocument()
    expect(saveCustomers).not.toHaveBeenCalled()
  })

  it('individual: shows validation errors when any residential address field is empty', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([INDIVIDUAL_PARTY])
    renderPage()

    await screen.findAllByText('Jane Doe')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Enter the street address.')).toBeInTheDocument()
    expect(screen.getByText('Enter the suburb.')).toBeInTheDocument()
    expect(screen.getByText('Enter the state.')).toBeInTheDocument()
    expect(screen.getByText('Enter the postcode.')).toBeInTheDocument()
  })

  it('company: shows validation errors when legalEntityName, legalForm, phone, registrationId, or activity are empty', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([COMPANY_PARTY])
    renderPage()

    await screen.findAllByText('Acme Pty Ltd')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Enter the legal entity name.')).toBeInTheDocument()
    expect(screen.getByText('Select the legal form or structure.')).toBeInTheDocument()
    expect(screen.getByText('Enter the phone number.')).toBeInTheDocument()
    expect(screen.getByText('Enter the registration identifier.')).toBeInTheDocument()
    expect(screen.getByText('Enter the principal activity or business activity.')).toBeInTheDocument()
    expect(saveCustomers).not.toHaveBeenCalled()
  })

  it('company: shows validation errors when any principal business address field is empty', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([COMPANY_PARTY])
    renderPage()

    await screen.findAllByText('Acme Pty Ltd')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Enter the street address.')).toBeInTheDocument()
    expect(screen.getByText('Enter the suburb.')).toBeInTheDocument()
    expect(screen.getByText('Enter the state.')).toBeInTheDocument()
    expect(screen.getByText('Enter the postcode.')).toBeInTheDocument()
  })

  it('marks the party as complete after it is saved without validation errors', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([INDIVIDUAL_PARTY])
    renderPage()

    await screen.findAllByText('Jane Doe')
    await fillIndividualForm(user)
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(saveCustomers).toHaveBeenCalled())
    expect(await screen.findByText('Complete')).toBeInTheDocument()
  })

  it('calls saveCustomers() with the current party data when Save is clicked', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([INDIVIDUAL_PARTY])
    renderPage()

    await screen.findAllByText('Jane Doe')
    await fillIndividualForm(user)
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(saveCustomers).toHaveBeenCalledWith([
        expect.objectContaining({ id: 'party-1', fullName: 'Jane Doe', isComplete: true }),
      ])
    })
  })

  it('shows a blocking error and prevents navigation when any party is not yet complete', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([INDIVIDUAL_PARTY, COMPANY_PARTY])
    renderPage()

    await screen.findAllByText('Jane Doe')
    await fillIndividualForm(user)
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByText('Complete the required details for all parties before continuing.')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Conducting Person' })).not.toBeInTheDocument()
  })

  it('party details form captures fullLegalName and a complete residential address — the AUSTRAC-mandatory client-side elements of a customer record', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([INDIVIDUAL_PARTY])
    renderPage()

    await screen.findAllByText('Jane Doe')
    await fillIndividualForm(user)
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(saveCustomers).toHaveBeenCalledWith([
        expect.objectContaining({
          fullName: 'Jane Doe',
          residentialAddress: expect.objectContaining({
            street: '1 Main St',
            suburb: 'Coburg',
            state: 'VIC',
            postcode: '3058',
          }),
        }),
      ])
    })
  })

  it('date of birth is stored in YYYY-MM-DD format, compatible with the AUSTRAC BirthDate type', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([INDIVIDUAL_PARTY])
    renderPage()

    await screen.findAllByText('Jane Doe')
    await fillIndividualForm(user)
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(saveCustomers).toHaveBeenCalledWith([
        expect.objectContaining({ dateOfBirth: '1985-06-15' }),
      ])
    })
  })

  it('Australian residential address captures street, suburb, state, and postcode — all mandatory for the AUSTRAC Address type', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([INDIVIDUAL_PARTY])
    renderPage()

    await screen.findAllByText('Jane Doe')
    await fillIndividualForm(user)
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(saveCustomers).toHaveBeenCalledWith([
        expect.objectContaining({
          residentialAddress: {
            street: '1 Main St',
            suburb: 'Coburg',
            state: 'VIC',
            postcode: '3058',
            country: 'Australia',
          },
        }),
      ])
    })
  })

  it('occupation or principal activity is captured for every individual party, satisfying the AUSTRAC occupationBusinessActivity requirement', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([INDIVIDUAL_PARTY])
    renderPage()

    await screen.findAllByText('Jane Doe')
    await fillIndividualForm(user)
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(saveCustomers).toHaveBeenCalledWith([
        expect.objectContaining({ occupation: 'Jeweller' }),
      ])
    })
  })

  it('ABN accepted by the form is exactly 11 digits with no spaces or hyphens, matching the AUSTRAC ABN pattern [0-9]{11}', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([INDIVIDUAL_PARTY])
    renderPage()

    await screen.findAllByText('Jane Doe')
    await fillIndividualForm(user)
    await user.type(screen.getByLabelText('ABN'), '12 345 678 90')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('ABN must be exactly 11 digits.')).toBeInTheDocument()
    expect(saveCustomers).not.toHaveBeenCalled()
  })

  it('ACN accepted by the form is exactly 9 digits with no spaces or hyphens, matching the AUSTRAC ACN pattern [0-9]{9}', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([COMPANY_PARTY])
    renderPage()

    await screen.findAllByText('Acme Pty Ltd')
    await user.type(screen.getByLabelText('Legal entity name'), 'Acme Pty Ltd')
    await user.selectOptions(screen.getByLabelText('Legal form or structure'), 'Company')
    await user.type(screen.getByLabelText('Street address'), '1 Business Rd')
    await user.type(screen.getByLabelText('Suburb'), 'Melbourne')
    await user.selectOptions(screen.getByLabelText('State'), 'VIC')
    await user.type(screen.getByLabelText('Postcode'), '3000')
    await user.type(screen.getByLabelText('Phone number'), '0398765432')
    await user.type(screen.getByLabelText('Principal activity or business activity'), 'Bullion trading')
    await user.selectOptions(screen.getByLabelText('Registration identifier type'), 'ACN')
    await user.type(screen.getByLabelText('Registration identifier value'), '12 345 678')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('ACN must be exactly 9 digits.')).toBeInTheDocument()
    expect(saveCustomers).not.toHaveBeenCalled()
  })

  it('company: the express-trust question only appears when legal form is Trust, and selecting Yes reveals and saves trust type/name', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([COMPANY_PARTY])
    renderPage()

    await screen.findAllByText('Acme Pty Ltd')
    expect(screen.queryByLabelText('Is this an express trust?')).not.toBeInTheDocument()

    await user.type(screen.getByLabelText('Legal entity name'), 'Southern Cross Metals Trust')
    await user.selectOptions(screen.getByLabelText('Legal form or structure'), 'Trust')

    expect(screen.getByLabelText('Is this an express trust?')).toBeInTheDocument()
    expect(screen.queryByLabelText('Trust type')).not.toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText('Is this an express trust?'), 'Yes')

    expect(screen.getByLabelText('Trust type')).toBeInTheDocument()
    await user.type(screen.getByLabelText('Trust type'), 'Discretionary trust')
    await user.type(screen.getByLabelText('Trust name'), 'Southern Cross Family Trust')

    await user.type(screen.getByLabelText('Street address'), '22 Commerce St')
    await user.type(screen.getByLabelText('Suburb'), 'Box Hill')
    await user.selectOptions(screen.getByLabelText('State'), 'VIC')
    await user.type(screen.getByLabelText('Postcode'), '3128')
    await user.type(screen.getByLabelText('Phone number'), '0387654321')
    await user.type(screen.getByLabelText('Principal activity or business activity'), 'Precious metal trading')
    await user.type(screen.getByLabelText('Registration identifier value'), '98765432109')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(saveCustomers).toHaveBeenCalledWith([
      expect.objectContaining({
        legalForm: 'Trust',
        isExpressTrust: 'Yes',
        trustTypeOther: 'Discretionary trust',
        trustName: 'Southern Cross Family Trust',
      }),
    ]))
  })

  it('individual: reveals postal address fields when "different postal address" checkbox is checked', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([INDIVIDUAL_PARTY])
    renderPage()

    await screen.findAllByText('Jane Doe')
    expect(screen.queryByLabelText('Street / PO Box')).not.toBeInTheDocument()

    await user.click(screen.getByRole('checkbox', { name: /postal address is different/i }))

    expect(screen.getByLabelText('Street / PO Box')).toBeInTheDocument()
  })

  it('individual: adds an alias to the list when Enter is pressed or Add button is clicked', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([INDIVIDUAL_PARTY])
    renderPage()

    await screen.findAllByText('Jane Doe')
    await user.type(screen.getByPlaceholderText('Enter alias and press Enter'), 'J. Doe{Enter}')

    expect(screen.getByText('J. Doe')).toBeInTheDocument()

    await user.type(screen.getByPlaceholderText('Enter alias and press Enter'), 'Janey')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    expect(screen.getByText('Janey')).toBeInTheDocument()
  })

  it('individual: removes an alias from the list when the remove button is clicked', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([INDIVIDUAL_PARTY])
    renderPage()

    await screen.findAllByText('Jane Doe')
    await user.type(screen.getByPlaceholderText('Enter alias and press Enter'), 'J. Doe{Enter}')
    await user.click(screen.getByRole('button', { name: 'Remove alias J. Doe' }))

    expect(screen.queryByText('J. Doe')).not.toBeInTheDocument()
  })

  it('"Save and next party" navigates the navigator to the next incomplete party', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([INDIVIDUAL_PARTY, COMPANY_PARTY])
    renderPage()

    await screen.findAllByText('Jane Doe')
    await fillIndividualForm(user)
    await user.click(screen.getByRole('button', { name: 'Save and next party' }))

    expect(await screen.findByLabelText('Legal entity name')).toBeInTheDocument()
  })

  it('a gender value pre-filled from a matched customer search result remains editable and is included in the saveCustomers() payload', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([{ ...INDIVIDUAL_PARTY, gender: 'F' }])
    renderPage()

    await screen.findAllByText('Jane Doe')
    expect(screen.getByLabelText('Gender')).toHaveValue('F')

    await fillIndividualForm(user)
    await user.selectOptions(screen.getByLabelText('Gender'), 'M')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(saveCustomers).toHaveBeenCalledWith([expect.objectContaining({ gender: 'M' })])
    })
  })

  it('phone number stored does not exceed 20 characters, satisfying the AUSTRAC PhoneNum type maxLength constraint', async () => {
    loadCustomers.mockResolvedValue([INDIVIDUAL_PARTY])
    renderPage()

    await screen.findAllByText('Jane Doe')
    expect(screen.getByLabelText('Phone number')).toHaveAttribute('maxLength', '20')
  })

  it('pre-fills "Full legal name" with the middle name included when fullName/displayName are both blank — it must not be silently dropped', async () => {
    loadCustomers.mockResolvedValue([
      { ...EMPTY_INDIVIDUAL_PARTY, firstName: 'Jane', middleName: 'Alice', lastName: 'Citizen' },
    ])
    renderPage()

    await screen.findAllByText('Jane Alice Citizen')
    expect(screen.getByLabelText('Full legal name')).toHaveValue('Jane Alice Citizen')
  })
})
