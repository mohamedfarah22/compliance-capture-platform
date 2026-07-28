import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import ConductingPersonPage from './ConductingPersonPage.jsx'
import { deleteTransaction, loadConductingPerson, loadCustomers, loadTransaction, saveConductingPerson, saveConductorInfo } from '../../lib/wizardApi.js'
import { useAuth } from '../../context/AuthContext.jsx'

vi.mock('../../lib/wizardApi.js', () => ({
  deleteTransaction: vi.fn(),
  loadConductingPerson: vi.fn(),
  loadCustomers: vi.fn(),
  loadTransaction: vi.fn(),
  saveConductingPerson: vi.fn(),
  saveConductorInfo: vi.fn(),
}))

vi.mock('../../context/AuthContext.jsx', () => ({
  useAuth: vi.fn(),
}))

const PARTIES = [
  { id: 'ind-001', type: 'individual', displayName: 'Jane Smith', dateOfBirth: '1990-04-15' },
  { id: 'co-001', type: 'company', displayName: 'Acme Pty Ltd', abnAcn: '12345678901' },
]

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/conducting-person']}>
      <Routes>
        <Route path="/" element={<h1>Start TTR Transaction</h1>} />
        <Route path="/party-details" element={<h1>Party Details</h1>} />
        <Route path="/conducting-person" element={<ConductingPersonPage />} />
        <Route path="/id-verification" element={<h1>ID Verification Details</h1>} />
        <Route path="/recipient-delivery" element={<h1>Recipient / Delivery</h1>} />
      </Routes>
    </MemoryRouter>,
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
  beforeEach(() => {
    useAuth.mockReturnValue({ staffMember: { full_name: 'Jane Staff' }, canApproveReports: false, signOut: vi.fn() })
    deleteTransaction.mockResolvedValue(undefined)
    loadCustomers.mockResolvedValue(PARTIES)
    loadConductingPerson.mockResolvedValue(null)
    loadTransaction.mockResolvedValue(null)
    saveConductingPerson.mockResolvedValue(undefined)
    saveConductorInfo.mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders only the "Is a different person conducting the transaction?" question on first render', async () => {
    renderPage()

    expect(await screen.findByText('Is a different person conducting the transaction on behalf of a party?')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'No' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Yes' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Full legal name')).not.toBeInTheDocument()
  })

  it('selecting No hides the full form and marks conducting person as same as party', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Is a different person conducting the transaction on behalf of a party?')
    await user.click(screen.getByRole('radio', { name: 'No' }))

    expect(screen.queryByLabelText('Full legal name')).not.toBeInTheDocument()
    expect(screen.getByText(/the conducting person is the same as the customer/i)).toBeInTheDocument()
  })

  it('selecting Yes reveals the full conducting person detail form', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Is a different person conducting the transaction on behalf of a party?')
    await user.click(screen.getByRole('radio', { name: 'Yes' }))

    expect(screen.getByLabelText('Full legal name')).toBeInTheDocument()
    expect(screen.getByLabelText('Customer / party being represented')).toBeInTheDocument()
  })

  it('shows a validation error when fullLegalName is empty and Yes is selected', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Is a different person conducting the transaction on behalf of a party?')
    await user.click(screen.getByRole('radio', { name: 'Yes' }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByText('Enter the full legal name.')).toBeInTheDocument()
    expect(saveConductingPerson).not.toHaveBeenCalled()
  })

  it('shows validation errors when any residential address field is empty and Yes is selected', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Is a different person conducting the transaction on behalf of a party?')
    await user.click(screen.getByRole('radio', { name: 'Yes' }))
    await user.type(screen.getByLabelText('Full legal name'), 'Alice Brown')
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByText('Enter the residential address.')).toBeInTheDocument()
  })

  it('shows a validation error when partyRepresented is not selected', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Is a different person conducting the transaction on behalf of a party?')
    await user.click(screen.getByRole('radio', { name: 'Yes' }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByText('Select the party this person is acting for.')).toBeInTheDocument()
  })

  it('shows a validation error when authorityToAct text is empty', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Is a different person conducting the transaction on behalf of a party?')
    await user.click(screen.getByRole('radio', { name: 'Yes' }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByText('Describe the authority to act.')).toBeInTheDocument()
  })

  it('calls saveConductingPerson() with the correctly structured data on continue', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Is a different person conducting the transaction on behalf of a party?')
    await user.click(screen.getByRole('radio', { name: 'Yes' }))
    await fillMinimumYesForm(user)
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() => {
      expect(saveConductingPerson).toHaveBeenCalledWith(
        expect.objectContaining({
          hasConductingPerson: 'yes',
          representedPartyId: 'ind-001',
          fullName: 'Alice Brown',
          relationship: 'Agent',
          authorityToAct: 'Power of attorney',
          residentialAddress: expect.objectContaining({
            street: '5 High St',
            suburb: 'Richmond',
            state: 'VIC',
            postcode: '3121',
          }),
        }),
      )
    })
    expect(await screen.findByRole('heading', { name: 'ID Verification Details' })).toBeInTheDocument()
  })

  it('shows the "describe relationship" text field only when relationship is set to Other', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Is a different person conducting the transaction on behalf of a party?')
    await user.click(screen.getByRole('radio', { name: 'Yes' }))
    expect(screen.queryByLabelText('Describe relationship')).not.toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText('Relationship to the customer / party'), 'Other')

    expect(screen.getByLabelText('Describe relationship')).toBeInTheDocument()
  })

  it('shows the employee role field only when "is employee" is set to yes', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Is a different person conducting the transaction on behalf of a party?')
    await user.click(screen.getByRole('radio', { name: 'Yes' }))
    expect(screen.queryByLabelText('Employee title or role')).not.toBeInTheDocument()

    await user.click(within(screen.getByTestId('isEmployee-group')).getByRole('radio', { name: 'Yes' }))

    expect(screen.getByLabelText('Employee title or role')).toBeInTheDocument()
  })

  it('reveals the another entity fields when "acting through another entity" is set to yes', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Is a different person conducting the transaction on behalf of a party?')
    await user.click(screen.getByRole('radio', { name: 'Yes' }))
    expect(screen.queryByLabelText('Entity name')).not.toBeInTheDocument()

    await user.click(within(screen.getByTestId('actingViaEntity-group')).getByRole('radio', { name: 'Yes' }))

    expect(screen.getByLabelText('Entity name')).toBeInTheDocument()
  })

  it('shows a warning modal when the user switches from Yes back to No after entering data', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Is a different person conducting the transaction on behalf of a party?')
    await user.click(screen.getByRole('radio', { name: 'Yes' }))
    await user.type(screen.getByLabelText('Full legal name'), 'Alice Brown')
    await user.click(within(screen.getByTestId('hasConductingPerson-group')).getByRole('radio', { name: 'No' }))

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Clear conducting person details?')).toBeInTheDocument()
  })

  it('when multiple parties exist and no separate conducting person is recorded, requires selecting which party conducted the transaction', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([
      { id: 'ind-001', type: 'individual', displayName: 'Jane Smith' },
      { id: 'ind-002', type: 'individual', displayName: 'Bob Jones' },
    ])
    renderPage()

    await screen.findByText('Is a different person conducting the transaction on behalf of a party?')
    await user.click(screen.getByRole('radio', { name: 'No' }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByText('Select the party that conducted this transaction.')).toBeInTheDocument()
    expect(saveConductorInfo).not.toHaveBeenCalled()

    await user.selectOptions(screen.getByLabelText('Which party conducted this transaction?'), 'ind-002')
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() => {
      expect(saveConductorInfo).toHaveBeenCalledWith({ conductedByPartyId: 'ind-002', methodOfConductingTxn: null })
    })
  })

  it('when the conducting individual for a company customer cannot be identified, requires a methodOfConductingTxn code instead of otherPerson details', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Is a different person conducting the transaction on behalf of a party?')
    await user.click(screen.getByRole('radio', { name: 'No' }))

    expect(await screen.findByText('Can the individual who conducted this transaction be identified?')).toBeInTheDocument()
    await user.click(within(screen.getByTestId('conductorIdentifiable-group')).getByRole('radio', { name: 'Yes' }))
    expect(screen.queryByLabelText('Method of conducting the transaction')).not.toBeInTheDocument()

    await user.click(within(screen.getByTestId('conductorIdentifiable-group')).getByRole('radio', { name: /No — impersonal channel/ }))
    expect(screen.getByLabelText('Method of conducting the transaction')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByText('Select the method of conducting the transaction.')).toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText('Method of conducting the transaction'), 'N')
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() => {
      expect(saveConductorInfo).toHaveBeenCalledWith({ conductedByPartyId: 'co-001', methodOfConductingTxn: 'N' })
    })
  })

  it('skips straight to /recipient-delivery — bypassing /id-verification — when there is no individual to verify (company-only customer, impersonal channel)', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([{ id: 'co-001', type: 'company', displayName: 'Acme Pty Ltd', abnAcn: '12345678901' }])
    renderPage()

    await screen.findByText('Is a different person conducting the transaction on behalf of a party?')
    await user.click(screen.getByRole('radio', { name: 'No' }))
    await user.click(within(screen.getByTestId('conductorIdentifiable-group')).getByRole('radio', { name: /No — impersonal channel/ }))
    await user.selectOptions(screen.getByLabelText('Method of conducting the transaction'), 'N')
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByRole('heading', { name: 'Recipient / Delivery' })).toBeInTheDocument()
  })

  it('still navigates to /id-verification when an individual party exists', async () => {
    const user = userEvent.setup()
    loadCustomers.mockResolvedValue([{ id: 'ind-001', type: 'individual', displayName: 'Jane Smith' }])
    renderPage()

    await screen.findByText('Is a different person conducting the transaction on behalf of a party?')
    await user.click(screen.getByRole('radio', { name: 'No' }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByRole('heading', { name: 'ID Verification Details' })).toBeInTheDocument()
  })

  // ─── UAT finding #10 — date of birth, and the silent save ───────────────────
  //
  // chk_cp_dob requires a date whenever dob_known is true, and nothing on the page
  // enforced that. Worse, handleContinue awaited its saves bare, so the rejection
  // escaped as an uncaught promise: a console trace, nothing on screen, and a page that
  // simply would not advance.
  //
  // Only reachable because fix #4 made dob_known save correctly — while it was always
  // false, `dob_known = FALSE OR ...` always held and the constraint could never fire.

  async function startConductingPersonWithDobKnown(user) {
    await screen.findByText('Is a different person conducting the transaction on behalf of a party?')
    await user.click(screen.getByRole('radio', { name: 'Yes' }))
    await fillMinimumYesForm(user)
    await user.click(within(screen.getByTestId('dobKnown-group')).getByRole('radio', { name: 'Yes' }))
  }

  it('blocks Continue with a field error when the date of birth is known but not entered', async () => {
    const user = userEvent.setup()
    renderPage()

    await startConductingPersonWithDobKnown(user)
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByText(/Enter the date of birth, or set/i)).toBeInTheDocument()
    // The database must not be the validator here — the save is never attempted.
    expect(saveConductingPerson).not.toHaveBeenCalled()
    expect(screen.queryByRole('heading', { name: 'ID Verification Details' })).not.toBeInTheDocument()
  })

  it('continues once the date of birth is supplied', async () => {
    const user = userEvent.setup()
    renderPage()

    await startConductingPersonWithDobKnown(user)
    await user.type(screen.getByLabelText('Date of birth'), '14/02/1986')
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() => expect(saveConductingPerson).toHaveBeenCalled())
    expect(saveConductingPerson).toHaveBeenCalledWith(
      expect.objectContaining({ dobKnown: 'yes', dateOfBirth: '1986-02-14' }),
    )
  })

  it('does not demand a date of birth when it is recorded as unknown', async () => {
    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Is a different person conducting the transaction on behalf of a party?')
    await user.click(screen.getByRole('radio', { name: 'Yes' }))
    await fillMinimumYesForm(user)
    await user.click(within(screen.getByTestId('dobKnown-group')).getByRole('radio', { name: 'No' }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() => expect(saveConductingPerson).toHaveBeenCalled())
    expect(screen.queryByText(/Enter the date of birth, or set/i)).not.toBeInTheDocument()
  })

  it('shows a rejected save on screen instead of throwing it into the console', async () => {
    const user = userEvent.setup()
    saveConductingPerson.mockRejectedValue({
      code: '23514',
      message: 'new row for relation "conducting_persons" violates check constraint "chk_cp_dob"',
    })
    renderPage()

    await screen.findByText('Is a different person conducting the transaction on behalf of a party?')
    await user.click(screen.getByRole('radio', { name: 'Yes' }))
    await fillMinimumYesForm(user)
    await user.click(within(screen.getByTestId('dobKnown-group')).getByRole('radio', { name: 'No' }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/Enter the date of birth, or set/i)
    expect(screen.queryByRole('heading', { name: 'ID Verification Details' })).not.toBeInTheDocument()
  })

  it('translates the other conducting-person constraints rather than leaking raw SQL', async () => {
    const user = userEvent.setup()
    saveConductingPerson.mockRejectedValue({
      code: '23514',
      message: 'violates check constraint "chk_cp_entity"',
    })
    renderPage()

    await screen.findByText('Is a different person conducting the transaction on behalf of a party?')
    await user.click(screen.getByRole('radio', { name: 'Yes' }))
    await fillMinimumYesForm(user)
    await user.click(within(screen.getByTestId('dobKnown-group')).getByRole('radio', { name: 'No' }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/Entity name and street address are required/i)
    expect(alert).not.toHaveTextContent(/check constraint/i)
  })
})
