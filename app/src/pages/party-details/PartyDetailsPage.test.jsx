import { Route, Routes, MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import PartyDetailsPage from './PartyDetailsPage.jsx'
import { wizardStorageKeys } from '../../components/wizardStorage.js'

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/party-details']}>
      <Routes>
        <Route path="/" element={<h1>Start TTR Transaction</h1>} />
        <Route path="/transaction-details" element={<h1>Transaction &amp; Cash Details</h1>} />
        <Route path="/party-details" element={<PartyDetailsPage />} />
        <Route path="/conducting-person" element={<h1>Conducting Person Details</h1>} />
      </Routes>
    </MemoryRouter>,
  )
}

function seedIndividual(overrides = {}) {
  window.sessionStorage.setItem(
    wizardStorageKeys.customers,
    JSON.stringify([
      {
        id: 'ind-001',
        type: 'individual',
        firstName: 'Jane',
        lastName: 'Smith',
        displayName: 'Jane Smith',
        dateOfBirth: '1990-04-15',
        ...overrides,
      },
    ]),
  )
}

function seedCompany(overrides = {}) {
  window.sessionStorage.setItem(
    wizardStorageKeys.customers,
    JSON.stringify([
      {
        id: 'co-001',
        type: 'company',
        entityName: 'Acme Pty Ltd',
        abnAcn: '12 345 678 901',
        displayName: 'Acme Pty Ltd',
        ...overrides,
      },
    ]),
  )
}

function seedTwo() {
  window.sessionStorage.setItem(
    wizardStorageKeys.customers,
    JSON.stringify([
      {
        id: 'ind-001',
        type: 'individual',
        firstName: 'Jane',
        lastName: 'Smith',
        displayName: 'Jane Smith',
        dateOfBirth: '1990-04-15',
      },
      {
        id: 'co-001',
        type: 'company',
        entityName: 'Acme Pty Ltd',
        abnAcn: '12 345 678 901',
        displayName: 'Acme Pty Ltd',
      },
    ]),
  )
}

async function fillIndividualForm(user) {
  await user.clear(screen.getByLabelText('Full legal name'))
  await user.type(screen.getByLabelText('Full legal name'), 'Jane Smith')
  await user.type(screen.getByLabelText('Street address'), '123 Main St')
  await user.type(screen.getByLabelText('Suburb'), 'Coburg')
  await user.selectOptions(screen.getByLabelText('State'), 'VIC')
  await user.type(screen.getByLabelText('Postcode'), '3058')
  await user.type(screen.getByLabelText('Country'), 'Australia')
  await user.type(screen.getByLabelText('Phone number'), '0412345678')
  await user.type(screen.getByLabelText('Occupation or principal activity'), 'Accountant')
}

async function fillCompanyForm(user) {
  await user.clear(screen.getByLabelText('Legal entity name'))
  await user.type(screen.getByLabelText('Legal entity name'), 'Acme Pty Ltd')
  await user.selectOptions(screen.getByLabelText('Legal form or structure'), 'Company')
  await user.type(screen.getByLabelText('Street address'), '456 Queen St')
  await user.type(screen.getByLabelText('Suburb'), 'Melbourne')
  await user.selectOptions(screen.getByLabelText('State'), 'VIC')
  await user.type(screen.getByLabelText('Postcode'), '3000')
  await user.type(screen.getByLabelText('Country'), 'Australia')
  await user.type(screen.getByLabelText('Phone number'), '0398765432')
  await user.type(screen.getByLabelText('Registration identifier value'), '12345678901')
  await user.type(screen.getByLabelText('Principal activity or business activity'), 'Bullion trading')
}

describe('PartyDetailsPage', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    window.sessionStorage.clear()
  })

  it('displays the heading, subtitle, and step indicator', () => {
    seedIndividual()
    renderPage()

    expect(screen.getByRole('heading', { name: 'Party Details' })).toBeInTheDocument()
    expect(
      screen.getByText('Complete the required details for each customer or party involved in this transaction.'),
    ).toBeInTheDocument()
    expect(screen.getByText('Step 3 of 4')).toBeInTheDocument()
  })

  it('shows the party name and type in the left-panel navigator', () => {
    seedIndividual()
    renderPage()

    // Name appears in both the navigator card and the summary banner
    expect(screen.getAllByText('Jane Smith').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Individual').length).toBeGreaterThan(0)
  })

  it('shows the party count in the navigator heading', () => {
    seedTwo()
    renderPage()

    expect(screen.getByText('Parties (2)')).toBeInTheDocument()
  })

  it('renders individual-specific fields for an individual party', () => {
    seedIndividual()
    renderPage()

    expect(screen.getByLabelText('Full legal name')).toBeInTheDocument()
    expect(screen.getByLabelText('Street address')).toBeInTheDocument()
    expect(screen.getByLabelText('Phone number')).toBeInTheDocument()
    expect(screen.getByLabelText('Occupation or principal activity')).toBeInTheDocument()
  })

  it('renders company-specific fields for a company party', () => {
    seedCompany()
    renderPage()

    expect(screen.getByLabelText('Legal entity name')).toBeInTheDocument()
    expect(screen.getByLabelText('Legal form or structure')).toBeInTheDocument()
    expect(screen.getByLabelText('Registration identifier value')).toBeInTheDocument()
    expect(screen.getByLabelText('Principal activity or business activity')).toBeInTheDocument()
  })

  it('pre-fills the individual full name from displayName in storage', () => {
    seedIndividual()
    renderPage()

    expect(screen.getByLabelText('Full legal name')).toHaveValue('Jane Smith')
  })

  it('pre-fills the company entity name from storage', () => {
    seedCompany()
    renderPage()

    expect(screen.getByLabelText('Legal entity name')).toHaveValue('Acme Pty Ltd')
  })

  it('shows required-field errors when Continue is clicked with empty individual form', async () => {
    const user = userEvent.setup()
    window.sessionStorage.setItem(
      wizardStorageKeys.customers,
      JSON.stringify([{ id: 'ind-001', type: 'individual' }]),
    )
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(screen.getByText('Enter the full legal name.')).toBeInTheDocument()
    expect(screen.getByText('Enter the date of birth.')).toBeInTheDocument()
    expect(screen.getByText('Enter the street address.')).toBeInTheDocument()
    expect(screen.getByText('Enter the phone number.')).toBeInTheDocument()
    expect(screen.getByText('Enter the occupation or principal activity.')).toBeInTheDocument()
  })

  it('shows required-field errors when Continue is clicked with empty company form', async () => {
    const user = userEvent.setup()
    window.sessionStorage.setItem(
      wizardStorageKeys.customers,
      JSON.stringify([{ id: 'co-001', type: 'company' }]),
    )
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(screen.getByText('Enter the legal entity name.')).toBeInTheDocument()
    expect(screen.getByText('Select the legal form or structure.')).toBeInTheDocument()
    expect(screen.getByText('Enter the street address.')).toBeInTheDocument()
    expect(screen.getByText('Enter the phone number.')).toBeInTheDocument()
    expect(screen.getByText('Enter the registration identifier.')).toBeInTheDocument()
    expect(screen.getByText('Enter the principal activity or business activity.')).toBeInTheDocument()
  })

  it('adds an alias tag when the Add button is clicked', async () => {
    const user = userEvent.setup()
    seedIndividual()
    renderPage()

    await user.type(screen.getByPlaceholderText('Enter alias and press Enter'), 'J. Smith')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    expect(screen.getByText('J. Smith')).toBeInTheDocument()
  })

  it('adds an alias tag when Enter is pressed', async () => {
    const user = userEvent.setup()
    seedIndividual()
    renderPage()

    await user.type(screen.getByPlaceholderText('Enter alias and press Enter'), 'Jane S.{Enter}')

    expect(screen.getByText('Jane S.')).toBeInTheDocument()
  })

  it('removes an alias tag when the remove button is clicked', async () => {
    const user = userEvent.setup()
    seedIndividual()
    renderPage()

    await user.type(screen.getByPlaceholderText('Enter alias and press Enter'), 'J. Smith')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    await user.click(screen.getByRole('button', { name: 'Remove alias J. Smith' }))

    expect(screen.queryByText('J. Smith')).not.toBeInTheDocument()
  })

  it('reveals postal address fields when the checkbox is checked', async () => {
    const user = userEvent.setup()
    seedIndividual()
    renderPage()

    expect(screen.queryByLabelText('Street / PO Box')).not.toBeInTheDocument()

    await user.click(screen.getByRole('checkbox', { name: /postal address is different/i }))

    expect(screen.getByLabelText('Street / PO Box')).toBeInTheDocument()
  })

  it('hides postal address fields when the checkbox is unchecked', async () => {
    const user = userEvent.setup()
    seedIndividual()
    renderPage()

    await user.click(screen.getByRole('checkbox', { name: /postal address is different/i }))
    await user.click(screen.getByRole('checkbox', { name: /postal address is different/i }))

    expect(screen.queryByLabelText('Street / PO Box')).not.toBeInTheDocument()
  })

  it('Save button persists data and marks party as complete', async () => {
    const user = userEvent.setup()
    seedIndividual()
    renderPage()

    await fillIndividualForm(user)
    await user.click(screen.getByRole('button', { name: 'Save' }))

    const stored = JSON.parse(window.sessionStorage.getItem(wizardStorageKeys.customers))
    expect(stored[0]).toMatchObject({ isComplete: true, phone: '0412345678' })
    expect(screen.getByText('Complete')).toBeInTheDocument()
  })

  it('"Save and next party" advances to the second party in the navigator', async () => {
    const user = userEvent.setup()
    seedTwo()
    renderPage()

    await fillIndividualForm(user)
    await user.click(screen.getByRole('button', { name: 'Save and next party' }))

    expect(screen.getByRole('heading', { name: 'Non-individual details' })).toBeInTheDocument()
  })

  it('Continue with all parties complete navigates to /conducting-person', async () => {
    const user = userEvent.setup()
    seedIndividual()
    renderPage()

    await fillIndividualForm(user)
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(screen.getByRole('heading', { name: 'Conducting Person Details' })).toBeInTheDocument()
  })

  it('Continue with incomplete parties shows an error and does not navigate', async () => {
    const user = userEvent.setup()
    seedTwo()
    renderPage()

    await fillIndividualForm(user)
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(
      screen.getByText('Complete the required details for all parties before continuing.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Party Details' })).toBeInTheDocument()
  })

  it('Back button navigates to /transaction-details', async () => {
    const user = userEvent.setup()
    seedIndividual()
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Back' }))

    expect(
      screen.getByRole('heading', { name: 'Transaction & Cash Details' }),
    ).toBeInTheDocument()
  })

  it('Exit button shows the confirm modal', async () => {
    const user = userEvent.setup()
    seedIndividual()
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Exit' }))

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Exit transaction?')).toBeInTheDocument()
  })

  it('confirming Exit navigates to /', async () => {
    const user = userEvent.setup()
    seedIndividual()
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Exit' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Exit' }))

    expect(screen.getByRole('heading', { name: 'Start TTR Transaction' })).toBeInTheDocument()
  })

  it('cancelling Exit closes the modal', async () => {
    const user = userEvent.setup()
    seedIndividual()
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Exit' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Party Details' })).toBeInTheDocument()
  })

  it('switching to a second party shows the company form', async () => {
    const user = userEvent.setup()
    seedTwo()
    renderPage()

    const partyButtons = screen.getAllByRole('button', { name: /acme pty ltd/i })
    await user.click(partyButtons[0])

    expect(screen.getByRole('heading', { name: 'Non-individual details' })).toBeInTheDocument()
  })
})
