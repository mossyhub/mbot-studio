// Real React tests; no application server, global MQTT setup, or hardware.
export default {
  testDir:'.', testMatch:['editor-parameter-repairs.spec.js','voice-recording.spec.js'],
  workers:1, retries:0, timeout:15000, expect:{timeout:4000}, reporter:[['list']],
  outputDir:'../test-results/editor-isolated',
  use:{viewport:{width:768,height:900},serviceWorkers:'block',launchOptions:{
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH} : {}),
    args:['--no-sandbox'],
  }},
};
