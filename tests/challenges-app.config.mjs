export default {
 testDir:'.',testMatch:['challenges-app.spec.js'],workers:1,retries:0,timeout:20000,expect:{timeout:4000},reporter:[['list']],
 use:{viewport:{width:1280,height:900},launchOptions:{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,args:['--no-sandbox']}},
};
