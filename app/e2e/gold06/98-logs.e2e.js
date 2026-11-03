// Gold Phase 6 UAT, spec 6.1 "Logs": edge functions log IDs and error codes only.
import { expect, test } from '@playwright/test'
import { edgeLogs, fixtures } from './support.js'

test('6.163 (added by UAT) — across the whole run the edge runtime logs hold none of the dummy names, phones, emails or ID numbers', async () => {
  const logs = edgeLogs(fixtures().startedAt)
  // The failures of section D and F were logged, so the logs are being read at all.
  for (const line of ['gold-create-customer: save failed', 'gold-update-customer-id: save failed', 'gold-update-customer: update failed']) expect(logs).toContain(line)
  for (const secret of ['Uatsix', 'Alice', 'Erin', 'Carol', '0412', '0488', 'example.test', 'UAT6-DL', 'UAT6-PP', 'UAT6-FAIL', 'Student card']) {
    expect(logs, secret).not.toContain(secret)
  }
})
