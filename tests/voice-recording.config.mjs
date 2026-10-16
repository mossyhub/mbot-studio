export default {
  testDir:'.', testMatch:['voice-recording.spec.js'], workers:1, retries:0,
  timeout:15000, expect:{timeout:3000}, reporter:[['list']],
  outputDir:process.env.MBOT_VOICE_OUTPUT ? `${process.env.MBOT_VOICE_OUTPUT}/results` : '../test-results/voice-ui/results',
  use:{viewport:{width:768,height:900},launchOptions:{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,args:['--no-sandbox']}},
};
