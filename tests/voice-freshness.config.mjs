// Isolated actual React; never starts the app server or MQTT harness.
export default {
  testDir:'.', testMatch:['voice-freshness.spec.js'], workers:1, retries:0,
  timeout:15000, expect:{timeout:3000}, reporter:[['list']],
  outputDir:'../audit/voice-freshness/results',
  use:{viewport:{width:1280,height:900},serviceWorkers:'block',launchOptions:{
    executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,args:['--no-sandbox'],
  }},
};
