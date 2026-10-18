export default {
  testDir: '.', testMatch: 'turn-calibration.spec.js', workers: 1, retries: 0,
  timeout: 30000, expect: { timeout: 3000 }, reporter: [['list']],
  use: { launchOptions: {
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
    args: ['--no-sandbox'],
  } },
};
