// Isolated React browser checks. Never starts the app server or MQTT.
export default {
  testDir: '.', testMatch: ['guided-live.spec.js'], workers: 1, retries: 0,
  timeout: 20000, expect: { timeout: 3000 }, reporter: [['list']],
  outputDir: '../test-results/guided-live',
  use: { serviceWorkers: 'block', launchOptions: {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args: ['--no-sandbox'],
  } },
};
