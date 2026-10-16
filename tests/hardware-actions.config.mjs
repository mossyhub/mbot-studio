// In-memory editor fixtures only: never starts the app or connects to a robot.
export default {
  testDir: '.', testMatch: ['hardware-actions.spec.js'],
  workers: 1, retries: 0, timeout: 20000, expect: { timeout: 3000 },
  reporter: 'list',
  use: { launchOptions: {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args: ['--no-sandbox'],
  } },
};
