import { Route, Routes, MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import StartTransactionPage from './StartTransactionPage.jsx'
import { wizardStorageKeys } from '../../components/wizardStorage.js'

function renderStartPage() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<StartTransactionPage />} />
        <Route path="/customers" element={<h1>Customer / Party Search</h1>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('StartTransactionPage', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    window.sessionStorage.clear()
  })

  it('displays the start transaction copy and form controls', () => {
    renderStartPage()

    expect(screen.getByRole('heading', { name: 'Start TTR Transaction' })).toBeInTheDocument()
    expect(
      screen.getByText('Create a new reportable bullion transaction record.'),
    ).toBeInTheDocument()
    expect(screen.getByText('This flow is for reportable TTR transactions only.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Transaction setup' })).toBeInTheDocument()
    expect(screen.getByText('Transaction scenario')).toBeInTheDocument()
    expect(screen.getByLabelText(/Sell bullion to customer/)).toBeInTheDocument()
    expect(screen.getByText('Customer pays business')).toBeInTheDocument()
    expect(screen.getByLabelText(/Buy bullion from customer/)).toBeInTheDocument()
    expect(screen.getByText('Business pays customer')).toBeInTheDocument()
    expect(screen.getByLabelText('Transaction reference')).toBeInTheDocument()
    expect(
      screen.getByText("Use the store's invoice or internal transaction reference number."),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Transaction date and time')).toBeInTheDocument()
    expect(screen.getByLabelText('Staff member')).toHaveValue('John Smith')
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start transaction' })).toBeInTheDocument()
  })

  it('shows required field validation when submitted empty', async () => {
    const user = userEvent.setup()
    renderStartPage()

    await user.click(screen.getByRole('button', { name: 'Start transaction' }))

    expect(screen.getByText('Select a transaction scenario.')).toBeInTheDocument()
    expect(screen.getByText('Enter a transaction reference.')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Customer / Party Search' })).not.toBeInTheDocument()
  })

  it('stores normalized transaction data and navigates to customer search', async () => {
    const user = userEvent.setup()
    renderStartPage()

    await user.click(screen.getByLabelText(/Sell bullion to customer/))
    await user.type(screen.getByLabelText('Transaction reference'), 'INV-1001')
    await user.click(screen.getByRole('button', { name: 'Start transaction' }))

    expect(screen.getByRole('heading', { name: 'Customer / Party Search' })).toBeInTheDocument()

    const storedTransaction = JSON.parse(
      window.sessionStorage.getItem(wizardStorageKeys.transaction),
    )

    expect(storedTransaction).toEqual(
      expect.objectContaining({
        scenario: 'sell',
        transactionRef: 'INV-1001',
        staffMember: 'John Smith',
        status: 'Draft',
      }),
    )
    expect(storedTransaction.dateTime).toEqual(expect.any(String))
    expect(storedTransaction.createdAt).toEqual(expect.any(String))
  })

})
