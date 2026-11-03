import { defineConfig, devices } from '@playwright/test'
import { BASE_URL, localEnv } from './e2e/support/env.js'

const env = localEnv()

// Automated UAT for docs/uat-test-matrix.md (Part 0, Phase 4, Part 1 and Part 1C) against the local stack.
// Cases depend on each other in order, so everything runs serially in one worker.
export default defineConfig({
  testMatch: '**/*.e2e.js',
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  globalSetup: './e2e/global-setup.js',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: BASE_URL,
    permissions: ['camera'],
    // A real (synthetic) camera stream, so ID capture runs the app's own getUserMedia path.
    launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
    actionTimeout: 15_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'part0', testDir: './e2e/part0' },
    { name: 'phase4', testDir: './e2e/phase4' },
    { name: 'part1', testDir: './e2e/part1' },
    { name: 'gold06', testDir: './e2e/gold06' },
    { name: 'gold07', testDir: './e2e/gold07' },
    { name: 'gold08a', testDir: './e2e/gold08a' },
  ],
  webServer: {
    command: `npx vite --host 127.0.0.1 --port ${new URL(BASE_URL).port} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: false,
    // Process env outranks .env.local in Vite, so the app is pointed at the local stack.
    // The gold screens (gold08a) need the build flag on; the gold edge functions get theirs from config.toml.
    env: { VITE_SUPABASE_URL: env.API_URL, VITE_SUPABASE_ANON_KEY: env.ANON_KEY, VITE_GOLD_JOURNEY_ENABLED: 'true' },
  },
})
