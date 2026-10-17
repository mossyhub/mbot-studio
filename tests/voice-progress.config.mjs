// Fully intercepted browser-only recording progress tests. No app/MQTT setup.
export default {
 testDir:'.',testMatch:['voice-progress.spec.js'],workers:1,retries:0,timeout:15000,expect:{timeout:3000},reporter:[['list']],
 outputDir:process.env.MBOT_VOICE_OUTPUT || '../audit/voice-progress/results',
 use:{viewport:{width:1024,height:768},serviceWorkers:'block',launchOptions:{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,args:['--no-sandbox','--disable-dev-shm-usage']}}
};
