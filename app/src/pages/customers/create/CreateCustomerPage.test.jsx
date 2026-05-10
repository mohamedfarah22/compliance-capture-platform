import { Route, Routes, MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CreateCustomerPage from './CreateCustomerPage.jsx'
import { wizardStorageKeys } from '../../../components/wizardStorage.js'

function renderCreatePage() {
  return render(
    <MemoryRouter initialEntries={['/customers/create']}>
      <Routes>
        <Route path="/customers/create" element={<CreateCustomerPage />} />
        <Route path="/customers" element={<h1>Customer / Party Search</h1>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('CreateCustomerPage', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  beforeEach(() => {
    window.sessionStorage.clear()
  })

  it('displays the required copy and controls on first render', () => {
    renderCreatePage()

    expect(screen.getByRole('heading', { name: 'Create New Customer / Party' })).toBeInTheDocument()
    expect(
      screen.getByText(
        'Enter the details for a new customer or party involved in this transaction.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByText('Step 1 of 3')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Individual' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Company / Business' })).toBeInTheDocument()
    expect(screen.getByLabelText('First name')).toBeInTheDocument()
    expect(screen.getByLabelText('Middle name')).toBeInTheDocument()
    expect(screen.getByLabelText('Last name')).toBeInTheDocument()
    expect(screen.getByLabelText('Date of birth')).toBeInTheDocument()
    expect(screen.getByLabelText('Phone number')).toBeInTheDocument()
    expect(screen.getByLabelText('Email address')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save customer' })).toBeInTheDocument()
  })

  it('shows validation errors for Individual when saving with empty required fields', async () => {
    const user = userEvent.setup()
    renderCreatePage()

    await user.click(screen.getByRole('button', { name: 'Save customer' }))

    expect(screen.getByText('Enter a first name.')).toBeInTheDocument()
    expect(screen.getByText('Enter a last name.')).toBeInTheDocument()
    expect(screen.getByText('Enter a date of birth.')).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Customer / Party Search' }),
    ).not.toBeInTheDocument()
  })

  it('switches to Company / Business and shows correct fields', async () => {
    const user = userEvent.setup()
    renderCreatePage()

    await user.click(screen.getByRole('button', { name: 'Company / Business' }))

    expect(screen.getByLabelText('Registered entity name')).toBeInTheDocument()
    expect(screen.getByLabelText('ABN / ACN')).toBeInTheDocument()
    expect(screen.getByLabelText('Registered suburb / postcode')).toBeInTheDocument()
    expect(screen.queryByLabelText('First name')).not.toBeInTheDocument()
  })

  it('shows validation errors for Company when saving with empty required fields', async () => {
    const user = userEvent.setup()
    renderCreatePage()

    await user.click(screen.getByRole('button', { name: 'Company / Business' }))
    await user.click(screen.getByRole('button', { name: 'Save customer' }))

    expect(screen.getByText('Enter a registered entity name.')).toBeInTheDocument()
    expect(screen.getByText('Enter an ABN or ACN.')).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Customer / Party Search' }),
    ).not.toBeInTheDocument()
  })

  it('saves a valid Individual to storage and navigates to /customers', async () => {
    const user = userEvent.setup()
    renderCreatePage()

    await user.type(screen.getByLabelText('First name'), 'Jane')
    await user.type(screen.getByLabelText('Last name'), 'Doe')

    const dobInput = screen.getByLabelText('Date of birth')
    await user.type(dobInput, '15/06/1990')

    await user.click(screen.getByRole('button', { name: 'Save customer' }))

    expect(screen.getByRole('heading', { name: 'Customer / Party Search' })).toBeInTheDocument()

    const stored = JSON.parse(window.sessionStorage.getItem(wizardStorageKeys.customers))
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({
      type: 'individual',
      firstName: 'Jane',
      lastName: 'Doe',
      displayName: 'Jane Doe',
    })
  })

  it('saves a valid Company to storage and navigates to /customers', async () => {
    const user = userEvent.setup()
    renderCreatePage()

    await user.click(screen.getByRole('button', { name: 'Company / Business' }))
    await user.type(screen.getByLabelText('Registered entity name'), 'Acme Pty Ltd')
    await user.type(screen.getByLabelText('ABN / ACN'), '12 345 678 901')
    await user.click(screen.getByRole('button', { name: 'Save customer' }))

    expect(screen.getByRole('heading', { name: 'Customer / Party Search' })).toBeInTheDocument()

    const stored = JSON.parse(window.sessionStorage.getItem(wizardStorageKeys.customers))
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({
      type: 'company',
      entityName: 'Acme Pty Ltd',
      abnAcn: '12 345 678 901',
      displayName: 'Acme Pty Ltd',
    })
  })

  it('Cancel navigates to /customers when the confirm dialog is accepted', async () => {
    const user = userEvent.setup()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderCreatePage()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.getByRole('heading', { name: 'Customer / Party Search' })).toBeInTheDocument()
  })

  it('appends new party to an existing customers array in storage', async () => {
    const existing = [
      {
        id: 'ind-001',
        type: 'individual',
        displayName: 'Sarah Johnson',
        detail: 'DOB: 14 Mar 1985',
      },
    ]
    window.sessionStorage.setItem(wizardStorageKeys.customers, JSON.stringify(existing))

    const user = userEvent.setup()
    renderCreatePage()

    await user.type(screen.getByLabelText('First name'), 'New')
    await user.type(screen.getByLabelText('Last name'), 'Person')

    const dobInput = screen.getByLabelText('Date of birth')
    await user.type(dobInput, '01/01/2000')

    await user.click(screen.getByRole('button', { name: 'Save customer' }))

    const stored = JSON.parse(window.sessionStorage.getItem(wizardStorageKeys.customers))
    expect(stored).toHaveLength(2)
    expect(stored[0]).toMatchObject({ displayName: 'Sarah Johnson' })
    expect(stored[1]).toMatchObject({ displayName: 'New Person' })
  })
})
