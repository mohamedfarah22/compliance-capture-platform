import { Route, Routes, MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ConductingPersonPage from './ConductingPersonPage.jsx'
import { wizardStorageKeys } from '../../components/wizardStorage.js'

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/conducting-person']}>
      <Routes>
        <Route path="/" element={<h1>Start TTR Transaction</h1>} />
        <Route path="/party-details" element={<h1>Party Details</h1>} />
        <Route path="/conducting-person" element={<ConductingPersonPage />} />
        <Route path="/id-verification" element={<h1>ID Verification Details</h1>} />
      </Routes>
    </MemoryRouter>,
  )
}

function seedParties() {
  window.sessionStorage.setItem(
    wizardStorageKeys.customers,
    JSON.stringify([
      {
        id: 'ind-001',
        type: 'individual',
        displayName: 'Jane Smith',
        dateOfBirth: '1990-04-15',
      },
      {
        id: 'co-001',
        type: 'company',
        displayName: 'Acme Pty Ltd',
        abnAcn: '12 345 678 901',
      },
    ]),
  )
}

function seedSavedData(overrides = {}) {
  window.sessionStorage.setItem(
    wizardStorageKeys.conductingPerson,
    JSON.stringify({
      hasConductingPerson: 'yes',
      representedPartyId: 'ind-001',
      fullName: 'John Doe',
      aliases: [],
      dobKnown: null,
      dateOfBirth: '',
      residentialAddress: {
        street: '10 Park Rd',
        suburb: 'Fitzroy',
        state: 'VIC',
        postcode: '3065',
        country: 'Australia',
      },
      postalAddressDifferent: false,
      postalAddress: { street: '', suburb: '', state: '', postcode: '', country: 'Australia' },
      phone: '0411222333',
      occupation: 'Lawyer',
      relationship: 'Agent',
      relationshipOther: '',
      authorityToAct: 'Power of attorney',
      isEmployee: null,
      employeeRole: '',
      actingViaEntity: null,
      entityName: '',
      entityAddress: { street: '', suburb: '', state: '', postcode: '', country: 'Australia' },
      entityRegType: '',
      entityRegNumber: '',
      ...overrides,
    }),
  )
}

async function fillMinimumYesForm(user) {
  await user.selectOptions(screen.getByLabelText('Customer / party being represented'), 'ind-001')
  await user.type(screen.getByLabelText('Full legal name'), 'Alice Brown')
  await user.type(screen.getByLabelText('Street address'), '5 High St')
  await user.type(screen.getByLabelText('Suburb'), 'Richmond')
  await user.selectOptions(screen.getByLabelText('State'), 'VIC')
  await user.type(screen.getByLabelText('Postcode'), '3121')
  await user.selectOptions(screen.getByLabelText('Relationship to the customer / party'), 'Agent')
  await user.type(screen.getByLabelText('Authority to act'), 'Power of attorney')
}

describe('ConductingPersonPage', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    window.sessionStorage.clear()
  })

  it('displays the heading and subtitle', () => {
    renderPage()

    expect(
      screen.getByRole('heading', { name: 'Conducting Person Details' }),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/record the person physically conducting the transaction/i),
    ).toBeInTheDocument()
  })

  it('displays the step indicator', () => {
    renderPage()

    expect(screen.getByText('Step 4')).toBeInTheDocument()
  })

  it('shows radio options and hides the full form by default', () => {
    renderPage()

    expect(screen.getByRole('radio', { name: 'No' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Yes' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Full legal name')).not.toBeInTheDocument()
  })

  it('selecting No shows the same-as-customer confirmation banner', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('radio', { name: 'No' }))

    expect(
      screen.getByText(/the conducting person is the same as the customer/i),
    ).toBeInTheDocument()
  })

  it('selecting Yes reveals the full form', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('radio', { name: 'Yes' }))

    expect(screen.getByLabelText('Full legal name')).toBeInTheDocument()
    expect(screen.getByLabelText('Customer / party being represented')).toBeInTheDocument()
  })

  it('switching from Yes (with form data) to No shows the clear warning dialog', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('radio', { name: 'Yes' }))
    await user.type(screen.getByLabelText('Full legal name'), 'Alice Brown')
    await user.click(within(screen.getByTestId('hasConductingPerson-group')).getByRole('radio', { name: 'No' }))

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Clear conducting person details?')).toBeInTheDocument()
  })

  it('confirming clear resets the form and shows the No confirmation banner', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('radio', { name: 'Yes' }))
    await user.type(screen.getByLabelText('Full legal name'), 'Alice Brown')
    await user.click(within(screen.getByTestId('hasConductingPerson-group')).getByRole('radio', { name: 'No' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Continue' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Full legal name')).not.toBeInTheDocument()
    expect(
      screen.getByText(/the conducting person is the same as the customer/i),
    ).toBeInTheDocument()
  })

  it('cancelling clear closes the dialog and keeps the form data', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('radio', { name: 'Yes' }))
    await user.type(screen.getByLabelText('Full legal name'), 'Alice Brown')
    await user.click(within(screen.getByTestId('hasConductingPerson-group')).getByRole('radio', { name: 'No' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Full legal name')).toHaveValue('Alice Brown')
  })

  it('Continue with no selection shows the hasConductingPerson validation error', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(
      screen.getByText('Select whether a different person is conducting the transaction.'),
    ).toBeInTheDocument()
  })

  it('Continue with No saves to storage and navigates to /id-verification', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('radio', { name: 'No' }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    const stored = JSON.parse(window.sessionStorage.getItem(wizardStorageKeys.conductingPerson))
    expect(stored.hasConductingPerson).toBe('no')
    expect(screen.getByRole('heading', { name: 'ID Verification Details' })).toBeInTheDocument()
  })

  it('Continue with Yes and empty required fields shows validation errors', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('radio', { name: 'Yes' }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(screen.getByText('Select the party this person is acting for.')).toBeInTheDocument()
    expect(screen.getByText('Enter the full legal name.')).toBeInTheDocument()
    expect(screen.getByText('Enter the residential address.')).toBeInTheDocument()
    expect(screen.getByText('Select the relationship to the party.')).toBeInTheDocument()
    expect(screen.getByText('Describe the authority to act.')).toBeInTheDocument()
  })

  it('Continue with Yes and minimum valid data saves and navigates', async () => {
    const user = userEvent.setup()
    seedParties()
    renderPage()

    await user.click(screen.getByRole('radio', { name: 'Yes' }))
    await fillMinimumYesForm(user)
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    const stored = JSON.parse(window.sessionStorage.getItem(wizardStorageKeys.conductingPerson))
    expect(stored).toMatchObject({ hasConductingPerson: 'yes', fullName: 'Alice Brown' })
    expect(screen.getByRole('heading', { name: 'ID Verification Details' })).toBeInTheDocument()
  })

  it('pre-fills from sessionStorage on mount', () => {
    seedParties()
    seedSavedData()
    renderPage()

    expect(screen.getByLabelText('Full legal name')).toHaveValue('John Doe')
    expect(screen.getByLabelText('Authority to act')).toHaveValue('Power of attorney')
  })

  it('Back button navigates to /party-details', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Back' }))

    expect(screen.getByRole('heading', { name: 'Party Details' })).toBeInTheDocument()
  })

  it('Exit button shows the ConfirmModal', async () => {
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

  it('cancelling exit closes the modal and stays on the page', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Exit' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Conducting Person Details' }),
    ).toBeInTheDocument()
  })

  it('adds a new alias row when "+ Add alias" is clicked', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('radio', { name: 'Yes' }))
    await user.click(screen.getByRole('button', { name: '+ Add alias' }))

    expect(screen.getByPlaceholderText('Enter alias')).toBeInTheDocument()
  })

  it('removes an alias row when the remove button is clicked', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('radio', { name: 'Yes' }))
    await user.click(screen.getByRole('button', { name: '+ Add alias' }))
    await user.type(screen.getByPlaceholderText('Enter alias'), 'J. Doe')
    await user.click(screen.getByRole('button', { name: 'Remove alias J. Doe' }))

    expect(screen.queryByPlaceholderText('Enter alias')).not.toBeInTheDocument()
  })

  it('postal address fields appear when the checkbox is checked', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('radio', { name: 'Yes' }))
    expect(screen.queryByLabelText('Street / PO Box')).not.toBeInTheDocument()

    await user.click(screen.getByRole('checkbox', { name: /postal address is different/i }))

    expect(screen.getByLabelText('Street / PO Box')).toBeInTheDocument()
  })

  it('entity details appear when actingViaEntity Yes is selected', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('radio', { name: 'Yes' }))
    await user.click(within(screen.getByTestId('actingViaEntity-group')).getByRole('radio', { name: 'Yes' }))

    expect(screen.getByLabelText('Entity name')).toBeInTheDocument()
  })

  it('employee role field appears when isEmployee Yes is selected', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('radio', { name: 'Yes' }))
    await user.click(within(screen.getByTestId('isEmployee-group')).getByRole('radio', { name: 'Yes' }))

    expect(screen.getByLabelText('Employee title or role')).toBeInTheDocument()
  })

  it('Describe relationship field appears when relationship is Other', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('radio', { name: 'Yes' }))
    await user.selectOptions(screen.getByLabelText('Relationship to the customer / party'), 'Other')

    expect(screen.getByLabelText('Describe relationship')).toBeInTheDocument()
  })
})
