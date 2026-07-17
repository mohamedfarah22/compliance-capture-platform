import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import WizardFrame from './WizardFrame.jsx'
import { useAuth } from '../../context/AuthContext.jsx'

vi.mock('../../context/AuthContext.jsx', () => ({
  useAuth: vi.fn(),
}))

function renderFrame(props = {}) {
  return render(
    <MemoryRouter>
      <WizardFrame title="Test Page" {...props}>
        <p>Page content</p>
      </WizardFrame>
    </MemoryRouter>,
  )
}

describe('WizardFrame', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders the title, subtitle, and children', () => {
    useAuth.mockReturnValue({ staffMember: { full_name: 'Jane Staff' }, canApproveReports: false, signOut: vi.fn() })
    renderFrame({ subtitle: 'Subtitle text' })

    expect(screen.getByRole('heading', { name: 'Test Page' })).toBeInTheDocument()
    expect(screen.getByText('Subtitle text')).toBeInTheDocument()
    expect(screen.getByText('Page content')).toBeInTheDocument()
  })

  it('does not render a Back button when onBack is not provided', () => {
    useAuth.mockReturnValue({ staffMember: { full_name: 'Jane Staff' }, canApproveReports: false, signOut: vi.fn() })
    renderFrame()

    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument()
  })

  it('fires onBack when the Back button is clicked', async () => {
    const onBack = vi.fn()
    const user = userEvent.setup()
    useAuth.mockReturnValue({ staffMember: { full_name: 'Jane Staff' }, canApproveReports: false, signOut: vi.fn() })
    renderFrame({ onBack })

    await user.click(screen.getByRole('button', { name: 'Back' }))

    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('shows a Reports link only when canApproveReports is true', () => {
    useAuth.mockReturnValue({ staffMember: { full_name: 'Jane Staff' }, canApproveReports: true, signOut: vi.fn() })
    renderFrame()

    expect(screen.getByRole('link', { name: 'Reports' })).toBeInTheDocument()
  })

  it('hides the Reports link when canApproveReports is false', () => {
    useAuth.mockReturnValue({ staffMember: { full_name: 'Jane Staff' }, canApproveReports: false, signOut: vi.fn() })
    renderFrame()

    expect(screen.queryByRole('link', { name: 'Reports' })).not.toBeInTheDocument()
  })

  it('calls signOut when the Sign out button is clicked', async () => {
    const signOut = vi.fn()
    const user = userEvent.setup()
    useAuth.mockReturnValue({ staffMember: { full_name: 'Jane Staff' }, canApproveReports: false, signOut })
    renderFrame()

    await user.click(screen.getByRole('button', { name: /sign out/i }))

    expect(signOut).toHaveBeenCalledTimes(1)
  })
})
