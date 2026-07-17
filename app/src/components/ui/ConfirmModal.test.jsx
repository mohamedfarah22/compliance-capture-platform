import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ConfirmModal from './ConfirmModal.jsx'

describe('ConfirmModal', () => {
  afterEach(() => {
    cleanup()
  })

  it('fires the onConfirm callback when the confirm button is clicked', async () => {
    const onConfirm = vi.fn()
    const user = userEvent.setup()
    render(<ConfirmModal isOpen onCancel={() => {}} onConfirm={onConfirm} />)

    await user.click(screen.getByRole('button', { name: 'Exit' }))

    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('fires the onCancel callback — not onConfirm — when the Cancel button is clicked', async () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const user = userEvent.setup()
    render(<ConfirmModal isOpen onCancel={onCancel} onConfirm={onConfirm} />)

    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('renders nothing when isOpen is false', () => {
    render(<ConfirmModal isOpen={false} onCancel={() => {}} onConfirm={() => {}} />)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
