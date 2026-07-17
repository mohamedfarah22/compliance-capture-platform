import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import TextInput from './TextInput.jsx'

describe('TextInput', () => {
  afterEach(() => {
    cleanup()
  })

  it('fires onChange with the typed value', () => {
    const onValue = vi.fn()
    render(<TextInput aria-label="Name" onChange={(e) => onValue(e.target.value)} value="" />)

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'a' } })

    expect(onValue).toHaveBeenCalledWith('a')
  })

  it('passes through arbitrary input props such as placeholder and maxLength', () => {
    render(<TextInput aria-label="Name" maxLength={10} placeholder="Enter name" value="" onChange={() => {}} />)

    const input = screen.getByLabelText('Name')
    expect(input).toHaveAttribute('placeholder', 'Enter name')
    expect(input).toHaveAttribute('maxLength', '10')
  })

  it('renders an icon when the icon prop is provided', () => {
    render(<TextInput aria-label="Search" icon={<span data-testid="search-icon" />} value="" onChange={() => {}} />)

    expect(screen.getByTestId('search-icon')).toBeInTheDocument()
  })
})
