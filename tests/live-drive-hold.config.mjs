// Isolated real JSX tests: every API and socket intercepted, no hardware.
export default {
  testDir: '.', testMatch: ['live-drive-hold.spec.js'],
  workers: 1, retries: 0, timeout: 20000, expect: { timeout: 3000 },
  reporter: [['list']],
  use: { launchOptions: {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args: ['--no-sandbox'],
  } },
};
