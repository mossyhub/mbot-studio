import { defineConfig } from '@playwright/test';

// Isolated frontend only. Every API and WebSocket is intercepted by the specs.
export default defineConfig({
  testDir: '.', testMatch: ['telemetry-ui.spec.js', 'cooperative-livecontrol.spec.js'],
  workers: 1, retries: 0, timeout: 20000, expect: { timeout: 3000 },
  outputDir: '/hermes_work/mbot-ota-evidence/telemetry-test-results',
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:15189',
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      args: ['--no-sandbox'],
    },
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 15189 --strictPort',
    cwd: new URL('../web', import.meta.url).pathname,
    url: 'http://127.0.0.1:15189', reuseExistingServer: false,
  },
});
