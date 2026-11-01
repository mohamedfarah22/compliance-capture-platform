// Gold Phase 6 UAT fixtures: the sheet's accounts S1, M1, A1, I1, X1 (plus inactive manager and admin)
// with real aal1 and aal2 tokens. Runs first; every other file reads what it saves.
import { expect, test } from '@playwright/test'
import { createFixtures } from './support.js'

test('6.0 setup: seven staff accounts across two businesses have aal1 and aal2 tokens', async () => {
  const f = await createFixtures()
  expect(Object.keys(f.staff).sort()).toEqual(['a1', 'i1', 'ia', 'im', 'm1', 's1', 'x1'])
  const aal = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()).aal
  for (const account of Object.values(f.staff)) {
    expect(aal(account.aal1)).toBe('aal1')
    expect(aal(account.aal2)).toBe('aal2')
  }
})
