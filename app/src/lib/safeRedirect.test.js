import { describe, it, expect } from 'vitest'
import { safeRedirect } from './safeRedirect.js'

describe('safeRedirect', () => {
  it('keeps a path inside the app, query string included', () => {
    expect(safeRedirect('/reports')).toBe('/reports')
    expect(safeRedirect('/review-batch/abc?token=xyz')).toBe('/review-batch/abc?token=xyz')
  })

  it('falls back to the wizard start when nothing was requested', () => {
    expect(safeRedirect(null)).toBe('/start')
    expect(safeRedirect('')).toBe('/start')
  })

  it('refuses anything that would leave the app after sign-in', () => {
    ;[
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      '\\\\evil.example',
      '/\t/evil.example',
      'javascript:alert(1)',
      'reports',
    ].forEach((value) => expect(safeRedirect(value)).toBe('/start'))
  })
})
