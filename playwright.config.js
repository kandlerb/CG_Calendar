// Browser tests for the page itself, run against demo.html so they need no
// Supabase project. `npm run test:e2e`.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:8123',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'python3 -m http.server 8123 --directory public',
    url: 'http://localhost:8123/demo.html',
    reuseExistingServer: !process.env.CI,
  },
});
