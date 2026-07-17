import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DatePicker from './DatePicker.jsx'

describe('DatePicker', () => {
  afterEach(() => {
    cleanup()
  })

  // The component's onChange contract passes an ISO 'yyyy-MM-dd' date string (not a Date
  // instance) — verified against the actual implementation in DatePicker.jsx.
  it('calls the onChange callback with a valid date value when a date is selected', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<DatePicker value="" onChange={onChange} />)

    await user.type(screen.getByRole('textbox'), '15/06/1985')

    expect(onChange).toHaveBeenLastCalledWith('1985-06-15')
  })
})
