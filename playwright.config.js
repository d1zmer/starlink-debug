// End-to-end tests: npx playwright test
const { defineConfig, devices } = require('@playwright/test');

const port = Number(process.env.PORT || 4173);

module.exports = defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}/`,
    locale: 'en-US',
    colorScheme: 'dark',
    trace: 'retain-on-failure',
    // Optional: point at an already-installed Chromium instead of `npx playwright install`.
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
    { name: 'phone', use: { ...devices['Pixel 7'] }, testMatch: /responsive\.spec\.js/ },
  ],
  webServer: {
    command: `node tests/e2e/serve.mjs`,
    url: `http://127.0.0.1:${port}/`,
    env: { PORT: String(port) },
    reuseExistingServer: !process.env.CI,
  },
});
