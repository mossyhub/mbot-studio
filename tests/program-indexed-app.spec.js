import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { lowerProgram } from '../server/src/services/program-lowering.js';
import { INDEXED_PROGRAM_PROFILE, LEGACY_PROGRAM_PROFILE } from '../server/src/services/program-encoding.js';
let js, css;
test.beforeAll(async () => {
  const built = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import App from './web/src/App.jsx';import './web/src/index.css';createRoot(document.getElementById('root')).render(<App/>);`, resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'jsx' }, bundle: true, write: false, outdir: '/virtual', format: 'iife', logLevel: 'silent' });
  js = built.outputFiles.find(f => f.path.endsWith('.js')).text;
  css = built.outputFiles.find(f => f.path.endsWith('.css')).text;
});
// Explicit server-response fixture for the agreed indexed-v1 profile; not a
// fabricated execution claim. All HTTP and sockets are intercepted below.
const blocks = [{type:'move_forward',duration:2,speed:20,_id:'move'}, {type:'repeat',times:1023,do:[{type:'wait',duration:0.01,_id:'wait'}],_id:'loop'}];
async function mount(page, { indexed = true, early, tamper = false, reject, programNoise = false,
  noiseFirst = false, delaySubmission = false, preflightOverrides = {}, responseOverrides = {} } = {}) {
  const sockets = [], posts = [], unexpected = [];
  let online = true, capability = indexed;
  let releaseSubmission;
  const send = (event='completed',run_id='indexed-run',type='program') => sockets.forEach(s => s.send(JSON.stringify({type:'mqtt',topic:'robot/execution',data:{event,run_id,type}})));
  await page.clock.install({time:new Date('2026-01-01T00:00:00Z')});
  await page.clock.pauseAt(new Date('2026-01-01T00:00:00Z'));
  await page.routeWebSocket('**/*', socket => sockets.push(socket));
  const proof = program => {
    const profile = capability ? INDEXED_PROGRAM_PROFILE : LEGACY_PROGRAM_PROFILE;
    return {runnable:true,...lowerProgram(program,{profile}),encoding:profile.encoding,limits:profile.limits,
      uniqueCommandCount:capability?2:1,wireBytes:2300};
  };
  await page.route('**/*', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({contentType:'text/html',body:'<div id="root"></div>'});
    if (path === '/api/config') return route.fulfill({json:{additions:[]}});
    if (path === '/api/ai/model') return route.fulfill({json:{model:'test'}});
    if (path === '/api/ai/blocks-to-code') return route.fulfill({json:{code:'# preview'}});
    if (path === '/api/robot/status') return route.fulfill({json:{robotOnline:online,mqttConnected:online,application:'cooperative-v1',build:'mbot-av-control-v1',boot:'boot-1',armed:true,motion_enabled:true,capabilities:['move_forward','wait',...(capability?['program_indexed_v1']:[])]}});
    if (path === '/api/robot/program/validate') {
      try {
        if (reject) throw Error(reject);
        return route.fulfill({json:{...proof(route.request().postDataJSON().program),...preflightOverrides}});
      } catch (error) { return route.fulfill({status:400,json:{runnable:false,error:error.message}}); }
    }
    if (path === '/api/robot/program') {
      posts.push(route.request().postDataJSON());
      if (delaySubmission) await new Promise(resolve=>{releaseSubmission=resolve;});
      if (early) {
        if (noiseFirst) for(let i=0;i<64;i++) send('started',`earlier-${i}`);
        send(early);
        // Neither thousands of block events nor later started events may evict
        // or regress an already received whole-program terminal.
        for (let i=0;i<2200;i++) send('completed',`noise-${i}`,'wait');
        if (programNoise) for(let i=0;i<64;i++) send('completed',`other-program-${i}`);
        send('started');
        if (early !== 'completed') send('completed');
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      const response = {...proof(posts.at(-1).program),sent:true,run_id:posts.length===1?'indexed-run':`indexed-run-${posts.length}`,...responseOverrides};
      if(tamper) response.sourceMap = response.sourceMap.toReversed();
      return route.fulfill({json:response});
    }
    if(path === '/api/robot/stop') return route.fulfill({json:{sent:true}});
    unexpected.push(path); return route.abort();
  });
  await page.addInitScript(({program})=>{
    localStorage.setItem('mbot-studio-profiles',JSON.stringify([{id:'a',name:'Alex'},{id:'b',name:'Blair'}]));
    localStorage.setItem('mbot-studio-current-profile','a');
    localStorage.setItem('mbot-studio-projects:a',JSON.stringify([{id:'p',name:'Long pattern',blocks:program,pythonCode:'# preview'}]));
    localStorage.setItem('mbot-studio-current-project:a','p');
    localStorage.setItem('mbot-studio-muted','true');
  },{program:indexed?blocks:[blocks[0]]});
  await page.goto('http://indexed.test/');
  await page.addStyleTag({content:css}); await page.addScriptTag({content:js});
  await expect(page.locator('.scratch-editor')).toBeVisible();
  await page.clock.runFor(300);
  await expect(page.getByTestId('program-readiness')).not.toContainText('Checking');
  return {send,posts,unexpected,release:()=>releaseSubmission(),setCapability:v=>{capability=v;},setOnline:v=>{online=v;}};
}
const saved = page => page.evaluate(()=>JSON.parse(localStorage.getItem('mbot-studio-challenges:a')||'{}'));

test('bounded early summaries retain a matching terminal through unrelated program noise', async ({page}) => {
  await mount(page,{early:'failed',programNoise:true});
  await page.getByRole('button',{name:'Run Program'}).click();
  await expect(page.getByTestId('program-lifecycle')).toContainText('Failed — device confirmed');
  expect(await saved(page)).toEqual({});
});
test('early summary saturation fails closed rather than forgetting a possible failure', async ({page}) => {
  await mount(page,{early:'failed',noiseFirst:true});
  await page.getByRole('button',{name:'Run Program'}).click();
  await expect(page.getByTestId('program-lifecycle')).toContainText('Unverified — too many unrelated early program events');
  expect(await saved(page)).toEqual({});
});

for (const mode of ['source-map mismatch','encoding mismatch','Stop','profile switch']) test(`indexed ${mode} cannot earn awards`, async ({page}) => {
  const f = await mount(page,{tamper:mode==='source-map mismatch',responseOverrides:mode==='encoding mismatch'?{encoding:'unknown-v2'}:{}});
  await page.getByRole('button',{name:'Run Program'}).click();
  await expect(page.getByTestId('program-lifecycle')).toContainText('Submitted');
  if (mode === 'Stop') await page.getByRole('button',{name:'🛑 STOP',exact:true}).click();
  if (mode === 'profile switch') {
    await page.getByTitle('Switch child profile').click();
    await page.getByRole('button',{name:'Blair',exact:true}).click();
    await page.getByTitle('Switch child profile').click();
    await page.getByRole('button',{name:'Alex',exact:true}).click();
  }
  f.send();
  const lifecycle = page.getByTestId('program-lifecycle');
  if (mode === 'Stop') {
    await expect(lifecycle).toContainText('Unverified — device reported completion after Stop');
    await expect(lifecycle).toContainText('device stop is not confirmed');
  } else if (mode === 'profile switch') {
    await expect(lifecycle).toContainText('Canceled locally — profile changed');
    await expect(lifecycle).toContainText('the robot may still be running');
  } else await expect(lifecycle).toContainText('Completed');
  expect(await saved(page)).toEqual({});
  if (mode === 'Stop' || mode === 'profile switch') {
    await expect(lifecycle).not.toContainText('Completed');
    await page.clock.runFor(300); // Revalidate the restored profile's program.
    const run = page.getByRole('button',{name:'Run Program'});
    await expect(run).toBeEnabled();await run.click();
    await expect(lifecycle).toContainText('Submitted — awaiting device confirmation (indexed-run-2)');
    f.send('canceled');f.send('completed');
    await expect(lifecycle).toContainText('Submitted — awaiting device confirmation (indexed-run-2)');
    f.send('completed','indexed-run-2');
    await expect(lifecycle).toContainText('Completed — device confirmed (indexed-run-2)');
    expect((await saved(page)).ch_forward.runId).toBe('indexed-run-2');
    expect(f.posts).toHaveLength(2);
  }
});

test('indexed observation deadline includes the HTTP submission delay', async ({page}) => {
  const f = await mount(page,{delaySubmission:true});
  await page.getByRole('button',{name:'Run Program'}).click();
  await expect.poll(()=>f.posts.length).toBe(1);
  await page.clock.runFor(314000);
  f.release();
  await expect(page.getByTestId('program-lifecycle')).toContainText('Submitted');
  await page.clock.runFor(1001);
  await expect(page.getByTestId('program-lifecycle')).toContainText('Unverified — timed out');
});

test('capability withdrawal invalidates the indexed preflight without rewriting saved blocks', async ({page}) => {
  const f = await mount(page);
  await expect(page.getByTestId('program-readiness')).toContainText('/ 1024 executed steps');
  f.setCapability(false);
  await page.clock.runFor(5000);
  await expect(page.getByTestId('program-readiness')).toContainText('Checking this program');
  await page.clock.runFor(300);
  await expect(page.getByTestId('program-readiness')).toContainText('Needs attention');
  await expect(page.getByRole('button',{name:'Run Program'})).toBeDisabled();
  await expect(page.locator('.se-script.main input[type="number"]').last()).toHaveValue('0.01');
  expect(f.posts).toEqual([]);
});

for (const error of ['Program exceeds 32 distinct commands','Complete program payload exceeds 8192 bytes','Program requested holds exceed 120 seconds']) test(`preflight exposes ${error}`, async ({page}) => {
  await mount(page,{reject:error});
  await expect(page.getByTestId('program-readiness')).toContainText(error);
  await expect(page.getByRole('button',{name:'Run Program'})).toBeDisabled();
});

for (const encoding of ['flat','unknown-v2']) test(`${encoding} preflight cannot select the indexed observer even with a capability marker`, async ({page}) => {
  await mount(page,{preflightOverrides:{encoding,limits:{instructions:999999,observationTimeoutMs:999999}}});
  await expect(page.getByTestId('program-readiness')).toContainText('/ 32 robot steps');
  await page.getByRole('button',{name:'Run Program'}).click();
  await expect(page.getByTestId('program-lifecycle')).toContainText('Submitted');
  await page.clock.runFor(120001);
  await expect(page.getByTestId('program-lifecycle')).toContainText('Unverified — timed out');
});

for (const early of ['completed','failed','canceled']) test(`early ${early} survives 2200 unrelated block events without lifecycle regression`, async ({page}) => {
  const f = await mount(page,{early});
  await page.getByRole('button',{name:'Run Program'}).click();
  await expect(page.getByTestId('program-lifecycle')).toContainText(`${early[0].toUpperCase()}${early.slice(1)} — device confirmed`);
  if (early === 'completed') await expect.poll(async ()=>(await saved(page)).ch_forward?.verification).toBe('device-completed');
  else expect(await saved(page)).toEqual({});
  expect(f.unexpected).toEqual([]);
});

test('readiness distinguishes executed steps from distinct commands with negotiated bounds', async ({page}) => {
  const f = await mount(page);
  await expect(page.getByTestId('program-readiness')).toContainText('1024 / 1024 executed steps');
  await expect(page.getByTestId('program-readiness')).toContainText('2 / 32 distinct commands');
  await expect(page.getByTestId('program-readiness')).toContainText('2300 / 8192 wire bytes');
  await expect(page.getByTestId('program-readiness')).toContainText('/ 120 s requested holds');
  expect(f.unexpected).toEqual([]);
  await page.screenshot({path:test.info().outputPath('indexed-readiness-desktop.png')});
  await page.setViewportSize({width:820,height:900});
  const readiness = page.getByTestId('program-readiness');
  expect(await readiness.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
  await page.screenshot({path:test.info().outputPath('indexed-readiness-tablet.png')});
});

test('indexed completion after 120 seconds still verifies immutable submitted evidence', async ({page}) => {
  const f = await mount(page);
  await page.getByRole('button',{name:'Run Program'}).click();
  await expect(page.getByTestId('program-lifecycle')).toContainText('Submitted');
  await page.locator('.se-script.main input[type="number"]').first().fill('0');
  await page.clock.runFor(121000);
  await expect(page.getByTestId('program-lifecycle')).toContainText('Submitted');
  f.send('completed','wrong-run'); f.send('completed','indexed-run','wait');
  expect(await saved(page)).toEqual({});
  f.send();
  await expect(page.getByTestId('program-lifecycle')).toContainText('Completed');
  await expect.poll(async ()=>(await saved(page)).ch_forward?.verification).toBe('device-completed');
  expect(f.posts[0].program).toEqual(blocks);
  expect(f.unexpected).toEqual([]);
});

for(const indexed of [true,false]) test(`${indexed?'indexed':'legacy'} observer has its own absolute deadline; telemetry cannot extend it`, async ({page})=>{
  const f = await mount(page,{indexed});
  await page.getByRole('button',{name:'Run Program'}).click();
  await expect(page.getByTestId('program-lifecycle')).toContainText('Submitted');
  await page.clock.runFor(indexed?314000:119000);
  f.send('started');
  await expect(page.getByTestId('program-lifecycle')).toContainText('Started');
  await page.clock.runFor(1001);
  await expect(page.getByTestId('program-lifecycle')).toContainText('Unverified — timed out');
  await expect(page.getByTestId('program-lifecycle')).toContainText('may still be running');
  expect(await saved(page)).toEqual({});
});
