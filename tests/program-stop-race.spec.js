import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { lowerProgram } from '../server/src/services/program-lowering.js';
import { INDEXED_PROGRAM_PROFILE as profile } from '../server/src/services/program-encoding.js';
let js, css;
test.beforeAll(async () => {
  const built = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import App from './web/src/App.jsx';import './web/src/index.css';createRoot(document.getElementById('root')).render(<App/>);`, resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'jsx' }, bundle: true, write: false, outdir: '/virtual', format: 'iife', logLevel: 'silent' });
  js = built.outputFiles.find(f => f.path.endsWith('.js')).text;
  css = built.outputFiles.find(f => f.path.endsWith('.css')).text;
});
const blocks = [{type:'move_forward',duration:2,speed:20,_id:'move'}];
const runButton = page => page.getByRole('button',{name:'Run Program'});
const stopButton = page => page.getByRole('button',{name:'🛑 STOP',exact:true});
const lifecycle = page => page.getByTestId('program-lifecycle');
async function mount(page, {stopFailure = false, holdHttp = false, holdBody = false} = {}) {
  const posts = [], stops = [], unexpected = [];
  await page.clock.install({time:new Date('2026-01-01T00:00:00Z')});
  await page.clock.pauseAt(new Date('2026-01-01T00:00:00Z'));
  await page.routeWebSocket('**/*', () => {});
  const proof = program => ({runnable:true,...lowerProgram(program,{profile}),encoding:profile.encoding,limits:profile.limits,uniqueCommandCount:1,wireBytes:200});
  await page.route('**/*', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({contentType:'text/html',body:'<div id="root"></div>'});
    if (path === '/api/config') return route.fulfill({json:{additions:[]}});
    if (path === '/api/ai/model') return route.fulfill({json:{model:'test'}});
    if (path === '/api/ai/blocks-to-code') return route.fulfill({json:{code:'# preview'}});
    if (path === '/api/robot/status') return route.fulfill({json:{robotOnline:true,mqttConnected:true,application:'cooperative-v1',build:'mbot-av-control-v1',boot:'boot-1',armed:true,motion_enabled:true,capabilities:['move_forward','wait','program_indexed_v1']}});
    if (path === '/api/robot/program/validate') return route.fulfill({json:proof(route.request().postDataJSON().program)});
    if (path === '/api/robot/program') {
      posts.push(route.request().postDataJSON());
      return route.fulfill({json:{...proof(posts.at(-1).program),sent:true,run_id:`run-${posts.length}`}});
    }
    if (path === '/api/robot/stop') {
      stops.push(path);
      if (stopFailure === 'network') return route.abort('failed');
      return route.fulfill({status:stopFailure?503:200,json:stopFailure?{error:'Stop unavailable'}:{sent:true}});
    }
    unexpected.push(path); return route.abort();
  });
  await page.addInitScript(program => {
    localStorage.setItem('mbot-studio-profiles',JSON.stringify([{id:'a',name:'Alex'},{id:'b',name:'Blair'}]));
    localStorage.setItem('mbot-studio-current-profile','a');
    for (const id of ['a','b']) {
      localStorage.setItem(`mbot-studio-projects:${id}`,JSON.stringify([{id:'p',name:'Motion',blocks:program,pythonCode:'# preview'}]));
      localStorage.setItem(`mbot-studio-current-project:${id}`,'p');
    }
    localStorage.setItem('mbot-studio-muted','true');
  }, blocks);
  await page.goto('http://stop-race.test/');
  await page.addStyleTag({content:css}); await page.addScriptTag({content:js});
  await expect(page.locator('.scratch-editor')).toBeVisible();
  await page.clock.runFor(300);
  await expect(runButton(page)).toBeEnabled();
  // Only the run observer is held; actual App and all its UI remain real.
  // Deliberately deliver callbacks even after close/abort to exercise fences.
  await page.evaluate(({holdHttp,holdBody}) => {
    window.race = {sockets:[],requests:[],stops:[],release:[],bodyReads:0};
    window.WebSocket = class extends EventTarget {
      constructor(url) { super(); this.url=url; this.closed=false; window.race.sockets.push(this); }
      close() { this.closed=true; } send() {}
    };
    const fetch = window.fetch.bind(window);
    window.fetch = async (url, options) => {
      if (url === '/api/robot/stop') window.race.stops.push({closed:window.race.sockets.every(s=>s.closed),aborted:window.race.requests.every(r=>r.signal.aborted)});
      if (url !== '/api/robot/program') return fetch(url,options);
      window.race.requests.push(options);
      // Fetch the real intercepted HTTP response, then delay its delivery/body.
      const response = await fetch(url, options);
      if (holdHttp && window.race.requests.length === 1) await new Promise(resolve=>window.race.release.push(resolve));
      const readJson = response.json.bind(response);
      response.json = () => { window.race.bodyReads++; return readJson(); };
      if (holdBody && window.race.requests.length === 1) {
        const json = response.json.bind(response);
        response.json = async () => { const data = await json(); await new Promise(resolve=>window.race.release.push(resolve)); return data; };
      }
      return response;
    };
  }, {holdHttp,holdBody});
  return {posts,stops,unexpected};
}
const open = (page,index=0) => page.evaluate(i=>window.race.sockets[i].onopen(new Event('open')),index);
const drain = page => page.evaluate(()=>new Promise(resolve=>queueMicrotask(()=>queueMicrotask(resolve))));
const release = page => page.evaluate(()=>window.race.release.splice(0).forEach(resolve=>resolve()));
async function start(page) {
  await runButton(page).click();
  await expect(lifecycle(page)).toContainText('Submitting');
}
async function complete(page,index,runId) {
  await page.evaluate(({index,runId})=>window.race.sockets[index].onmessage({data:JSON.stringify({type:'mqtt',topic:'robot/execution',data:{event:'completed',type:'program',run_id:runId}})}),{index,runId});
}

test('profile switch revokes the pending generation even when switching back before open', async ({page}) => {
  const f = await mount(page);
  await start(page);
  for (const name of ['Blair','Alex']) {
    await page.getByTitle('Switch child profile').click();
    await page.getByRole('button',{name,exact:true}).click();
  }
  await open(page); await drain(page);
  expect(f.posts,'Profile changes must not leave a hidden motion submission').toHaveLength(0);
  expect(await page.evaluate(()=>window.race.sockets[0].closed)).toBe(true);
  await expect.poll(async () => { await page.clock.runFor(300); return runButton(page).isEnabled(); }).toBe(true);
  await start(page); await open(page,1);
  await expect(lifecycle(page)).toContainText('Submitted');
  expect(f.posts).toHaveLength(1);
});

for (const phase of ['headers','body']) test(`already pending HTTP ${phase}: abort precedes server Stop and late completion cannot affect fresh Run`, async ({page}) => {
  const f = await mount(page,{holdHttp:phase==='headers',holdBody:phase==='body'});
  await start(page); await open(page);
  await expect.poll(()=>f.posts.length).toBe(1);
  await expect.poll(()=>page.evaluate(()=>window.race.release.length)).toBe(1);
  await stopButton(page).click();
  await expect.poll(()=>f.stops.length).toBe(1);
  expect(await page.evaluate(()=>window.race.stops[0])).toEqual({closed:true,aborted:true});
  await expect(lifecycle(page)).toContainText('device stop is not confirmed');
  await start(page); await open(page,1);
  await expect(lifecycle(page)).toContainText('Submitted');
  const reads = await page.evaluate(()=>window.race.bodyReads);
  await release(page); await complete(page,0,'run-1'); await drain(page);
  expect(await page.evaluate(()=>window.race.bodyReads),'Canceled HTTP continuation must not consume a late response').toBe(reads);
  await expect(lifecycle(page)).toContainText('Submitted');
  await complete(page,1,'run-2');
  await expect(lifecycle(page)).toContainText('Completed');
  expect(f.posts).toHaveLength(2);
  expect(f.unexpected).toEqual([]);
});

for (const stopFailure of [false,true,'network']) test(`Stop twice (${stopFailure==='network'?'network failure':stopFailure?'HTTP failure':'success'}) never restores canceled submission; fresh Run succeeds`, async ({page}) => {
  const f = await mount(page,{stopFailure});
  await start(page);
  await stopButton(page).click(); await stopButton(page).click();
  await expect.poll(()=>f.stops.length).toBe(2);
  await open(page); await drain(page);
  expect(f.posts).toHaveLength(0);
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('mbot-studio-challenges:a')||'{}'))).toEqual({});
  await expect(runButton(page)).toBeEnabled();
  await start(page); await open(page,1);
  await expect(lifecycle(page)).toContainText('Submitted');
  await complete(page,0,'run-1');
  await expect(lifecycle(page)).toContainText('Submitted');
  await complete(page,1,'run-1');
  await expect(lifecycle(page)).toContainText('Completed');
  expect(f.posts).toHaveLength(1);
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('mbot-studio-challenges:a')||'{}').ch_forward?.verification)).toBe('device-completed');
});

for (const event of ['open','error','close']) test(`Stop before observer opens cancels submission synchronously; late ${event} cannot POST`, async ({page}) => {
  const f = await mount(page);
  await start(page);
  expect(f.posts).toHaveLength(0);
  await stopButton(page).click();
  await expect.poll(()=>f.stops.length).toBe(1);
  await page.evaluate(event=>window.race.sockets[0][`on${event}`](new Event(event)),event); await drain(page);
  expect(f.posts,'Canceled motion must never be POSTed after Stop').toHaveLength(0);
  expect(await page.evaluate(()=>window.race.stops)).toEqual([{closed:true,aborted:true}]);
  await expect(lifecycle(page)).toContainText('Canceled');
  await expect(runButton(page)).toBeEnabled();
  expect(f.unexpected).toEqual([]);
});
