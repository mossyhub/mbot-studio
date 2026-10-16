// Isolated component/contract tests; no application server or MQTT connection.
export default {
  testDir: '.',
  testMatch: ['live-turn-controls.spec.js', 'live-queue.spec.js'],
  workers: 1, retries: 0, timeout: 20000,
  expect: { timeout: 3000 },
  reporter: [['list']],
  use: {
    launchOptions: {
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? {
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      } : {}),
      args: ['--no-sandbox'],
    },
  },
};
