import {test, expect} from '@playwright/test';
import {build} from 'esbuild';
import { openBlocks } from './guided-navigation.js';
import {fileURLToPath} from 'node:url';

// Adapted from the independent review's real-App and boot-change reproductions.
const baseStatus={robotOnline:true,mqttConnected:true,build:'mbot-av-control-v1',application:'cooperative-v1',boot:'boot-A',armed:true,motion_enabled:true,capabilities:['recorded_audio_v1','wait','move_forward','program_indexed_v1']};
const asset={id:'clip-1',name:'Test clip',durationMs:1000,bytes:1000,ready:true};
const bundles={};
test.beforeAll(async()=>{
  for(const kind of ['voice','app']) {
    const component=kind==='app'?`import App from './web/src/App.jsx';root.render(<App/>);`:`import Voice from './web/src/components/VoiceRecording.jsx';window.renderVoice=s=>root.render(<Voice runtimeStatus={s} onSelect={b=>window.chosen=b} onRecordingsChange={rows=>window.rows=rows}/>);renderVoice(window.initialStatus);`;
    const built=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import './web/src/index.css';const root=createRoot(document.getElementById('root'));window.unmount=()=>root.unmount();${component}`,resolveDir:fileURLToPath(new URL('..',import.meta.url)),loader:'jsx'},bundle:true,write:false,outdir:'/virtual',format:'iife',logLevel:'silent'});
    bundles[kind]={js:built.outputFiles.find(f=>f.path.endsWith('.js')).text,css:built.outputFiles.find(f=>f.path.endsWith('.css')).text};
  }
});
const button=(page,name)=>page.getByRole('button',{name,exact:true});
async function mount(page,{kind='voice',list=[asset],holdStatus=false}={}) {
  const unexpected=[];
  await page.clock.install({time:new Date('2026-01-01T00:00:00Z')});
  await page.clock.pauseAt(new Date('2026-01-01T00:00:00Z'));
  await page.routeWebSocket('**/*',()=>{});
  await page.route('**/*',route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/')return route.fulfill({contentType:'text/html',body:'<div id="root"></div>'});
    if(path==='/api/config')return route.fulfill({json:{additions:[]}});
    if(path==='/api/ai/model')return route.fulfill({json:{model:'fixture'}});
    if(path==='/api/ai/blocks-to-code')return route.fulfill({json:{code:'# fixture'}});
    if(path==='/api/robot/status')return route.fulfill({json:baseStatus});
    if(path==='/api/robot/recordings')return route.fulfill({json:{recordings:list}});
    if(path==='/api/robot/recordings/clip-1/sync')return route.fulfill({json:asset});
    unexpected.push(path);return route.abort();
  });
  await page.addInitScript(({baseStatus,holdStatus})=>{
    window.initialStatus=baseStatus;
    localStorage.setItem('mbot-studio-muted','true');
    localStorage.setItem('mbot-studio-profiles',JSON.stringify([{id:'a',name:'Alex'}]));
    localStorage.setItem('mbot-studio-current-profile','a');
    window.proof={tracks:0,stopped:0};
    HTMLMediaElement.prototype.play=function(){return Promise.resolve();};
    HTMLMediaElement.prototype.pause=function(){};HTMLMediaElement.prototype.load=function(){};
    Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>{
      const tracks=[0,1].map(()=>{proof.tracks++;let stopped=false;return {stop(){if(!stopped){stopped=true;proof.stopped++;}},addEventListener(){}};});return {getTracks:()=>tracks};
    }}});
    window.MediaRecorder=class{static isTypeSupported(t){return t==='audio/webm;codecs=opus';}constructor(s,o){this.state='inactive';this.mimeType=o.mimeType;}start(){this.state='recording';}stop(){this.state='inactive';queueMicrotask(()=>{this.ondataavailable?.({data:new Blob(['fixture'],{type:this.mimeType})});this.onstop?.();});}};
    // Hold already-read bodies, deliberately ignoring abort, to prove the fence
    // as well as cancellation. Every underlying request is locally intercepted.
    window.pending=[];window.requests=[];window.rules={};
    if(holdStatus)rules['/api/robot/status']={hold:true};
    const fetch=window.fetch.bind(window);
    window.fetch=async(url,options={})=>{
      const rule={...rules[url]}; const request={url,signal:options.signal};requests.push(request);
      const response=await fetch(url,options);const json=response.json.bind(response);
      response.json=async()=>{
        let data=await json();
        if(rule.data!==undefined)data=rule.data;
        if(rule.hold)await new Promise(resolve=>pending.push({url,resolve}));
        if(rule.fail)throw Error('fixture refresh failure');
        return data;
      };
      if(rule.httpError)return {ok:false,status:503,json:response.json};
      return response;
    };
  },{baseStatus,holdStatus});
  await page.goto('https://freshness.test/');
  await page.addStyleTag({content:bundles[kind].css+'*{animation:none!important;transition:none!important}'});
  await page.addScriptTag({content:bundles[kind].js});
  await expect(page.locator(kind==='app'?'.scratch-editor':'.voice-recording')).toBeVisible();
  if(kind==='app'){await openBlocks(page);await page.getByTitle('Sound',{exact:true}).click();}
  return {unexpected};
}
const setRule=(page,url,rule)=>page.evaluate(({url,rule})=>{rules[url]=rule;},{url,rule});
const release=(page,url)=>page.evaluate(url=>{const held=pending.filter(p=>p.url===url);window.pending=pending.filter(p=>p.url!==url);held.forEach(p=>p.resolve());},url);
const waitHeld=(page,url)=>expect.poll(()=>page.evaluate(url=>pending.filter(p=>p.url===url).length,url)).toBe(1);
const statusUrl='/api/robot/status',listUrl='/api/robot/recordings',syncUrl='/api/robot/recordings/clip-1/sync';

for(const failure of ['http','body','timeout']) test(`real App ${failure} refresh fails closed and permits a fresh recovery`,async({page})=>{
  await mount(page,{kind:'app'});
  await expect(button(page,'Record')).toBeEnabled();
  await setRule(page,statusUrl,failure==='http'?{httpError:true}:failure==='body'?{fail:true}:{hold:true});
  await page.clock.runFor(5001);
  if(failure==='timeout') { await waitHeld(page,statusUrl); await page.clock.runFor(4500); }
  await expect(button(page,'Record')).toBeDisabled();
  if(failure==='timeout')await release(page,statusUrl);
  await expect(button(page,'Record')).toBeDisabled();
  await setRule(page,statusUrl,{});
  // Stop just after the next poll; do not race intercepted real HTTP against
  // another simulated 4.5s deadline in the same clock advancement.
  await page.clock.runFor(failure==='timeout'?500:5000);
  await expect(button(page,'Record')).toBeEnabled();
});

test('real App unmount aborts pending status and stops polling',async({page})=>{
  await mount(page,{kind:'app',holdStatus:true});await waitHeld(page,statusUrl);
  await page.evaluate(()=>unmount());
  expect(await page.evaluate(()=>requests.find(r=>r.url==='/api/robot/status').signal?.aborted)).toBe(true);
  await release(page,statusUrl);await page.clock.runFor(15000);
  expect(await page.evaluate(()=>requests.filter(r=>r.url==='/api/robot/status').length)).toBe(1);
  await expect(page.locator('#root')).toBeEmpty();
});

test('explicit broker disconnect cancels active capture and blocks a new one',async({page})=>{
  await mount(page);
  await button(page,'Record').click();
  await expect(button(page,'Stop')).toBeEnabled();
  await page.evaluate(s=>renderVoice({...s,mqttConnected:false}),baseStatus);
  await expect.poll(()=>page.evaluate(()=>proof.stopped)).toBe(2);
  await expect(button(page,'Record')).toBeDisabled();
  await expect(button(page,'Stop')).toBeDisabled();
  await page.evaluate(s=>renderVoice(s),baseStatus);
  await expect(button(page,'Record')).toBeEnabled();
  await button(page,'Record').click();
  await expect(button(page,'Stop')).toBeEnabled();
  expect(await page.evaluate(()=>proof.tracks)).toBe(4);
});

for(const transition of ['boot','reconnect']) test(`${transition} invalidates ready receipts immediately and refreshes without losing local clips`,async({page})=>{
  await mount(page);
  await page.getByLabel('Saved clip').selectOption(asset.id);
  await expect(button(page,'Use clip')).toBeEnabled();
  await setRule(page,listUrl,{hold:true,data:{recordings:[{...asset,ready:false}]}});
  if(transition==='reconnect'){
    await page.evaluate(s=>renderVoice({...s,mqttConnected:false}),baseStatus);
    await expect(button(page,'Use clip')).toBeDisabled();
    await expect(button(page,'Preview')).toBeEnabled();
    await release(page,listUrl);
  }
  await page.evaluate(({s,transition})=>renderVoice({...s,boot:transition==='boot'?'boot-B':s.boot}),{s:baseStatus,transition});
  await expect(button(page,'Use clip')).toBeDisabled();
  await expect(button(page,'Preview')).toBeEnabled();
  await expect(page.getByLabel('Saved clip')).toHaveValue(asset.id);
  await expect.poll(()=>page.evaluate(()=>rows[0]?.ready)).toBe(false);
  await waitHeld(page,listUrl);
  await release(page,listUrl);
  await expect(button(page,'Sync to robot')).toBeEnabled();
  await button(page,'Sync to robot').click();
  await expect(button(page,'Use clip')).toBeEnabled();
  await button(page,'Use clip').click();
  expect(await page.evaluate(()=>chosen)).toEqual({type:'play_recording',recording:asset.id});
});

for(const transition of ['boot','reconnect']) test(`${transition}: boot-A late sync cannot mark a replacement connection ready, fresh sync can`,async({page})=>{
  await mount(page,{list:[{...asset,ready:false}]});
  await page.getByLabel('Saved clip').selectOption(asset.id);
  await setRule(page,syncUrl,{hold:true});
  await button(page,'Sync to robot').click();await waitHeld(page,syncUrl);
  if(transition==='reconnect') {
    await page.evaluate(s=>renderVoice({...s,mqttConnected:false}),baseStatus);
    await expect(button(page,'Record')).toBeDisabled();
  }
  await page.evaluate(({s,transition})=>renderVoice({...s,boot:transition==='boot'?'boot-B':s.boot}),{s:baseStatus,transition});
  await release(page,syncUrl);
  await expect(button(page,'Use clip')).toBeDisabled();
  expect(await page.evaluate(()=>requests.find(r=>r.url.endsWith('/sync')).signal?.aborted)).toBe(true);
  await expect(button(page,'Sync to robot')).toBeEnabled();
  await setRule(page,syncUrl,{});await button(page,'Sync to robot').click();
  await expect(button(page,'Use clip')).toBeEnabled();
});

for(const transition of ['boot','reconnect','unmount']) test(`${transition} rejects an old library body even when abort arrives too late`,async({page})=>{
  await mount(page);
  await page.getByLabel('Saved clip').selectOption(asset.id);
  await setRule(page,listUrl,{hold:true});
  await button(page,'Refresh').click();await waitHeld(page,listUrl);
  await setRule(page,listUrl,{data:{recordings:[{...asset,name:'Current library clip',ready:false}]}});
  if(transition==='unmount')await page.evaluate(()=>unmount());
  else {
    if(transition==='reconnect') {
      await page.evaluate(s=>renderVoice({...s,robotOnline:false}),baseStatus);
      await expect(button(page,'Record')).toBeDisabled();
    }
    await page.evaluate(({s,transition})=>renderVoice({...s,boot:transition==='boot'?'boot-B':s.boot}),{s:baseStatus,transition});
    await expect(page.getByLabel('Saved clip').locator('option:checked')).toContainText('Current library clip');
  }
  await release(page,listUrl);
  expect(await page.evaluate(()=>requests.filter(r=>r.url==='/api/robot/recordings')[1].signal?.aborted)).toBe(true);
  if(transition==='unmount')await expect(page.locator('#root')).toBeEmpty();
  else {
    await expect(button(page,'Use clip')).toBeDisabled();
    await expect(button(page,'Preview')).toBeEnabled();
    await expect(page.getByLabel('Saved clip').locator('option:checked')).toContainText('Current library clip');
  }
});

test('failed new-boot library refresh preserves local preview but never old readiness',async({page})=>{
  await mount(page);
  await page.getByLabel('Saved clip').selectOption(asset.id);
  await setRule(page,listUrl,{fail:true});
  await page.evaluate(s=>renderVoice({...s,boot:'boot-B'}),baseStatus);
  await expect(page.getByRole('alert')).toContainText('invalid recording list');
  await expect(button(page,'Use clip')).toBeDisabled();
  await expect(button(page,'Preview')).toBeEnabled();
  await expect(page.getByLabel('Saved clip')).toHaveValue(asset.id);
  await setRule(page,listUrl,{});await button(page,'Refresh').click();
  await expect(button(page,'Use clip')).toBeEnabled();
});

test('real App rejects older online body after newer offline status',async({page})=>{
  const f=await mount(page,{kind:'app',holdStatus:true});await waitHeld(page,statusUrl);
  await setRule(page,statusUrl,{data:{...baseStatus,robotOnline:false,mqttConnected:false,capabilities:[]}});
  await page.clock.runFor(5001);
  await expect(page.getByText(/Unavailable.*installed/)).toBeVisible();
  await release(page,statusUrl);
  await expect(button(page,'Record')).toBeDisabled();
  expect(await page.evaluate(()=>requests.find(r=>r.url==='/api/robot/status').signal?.aborted)).toBe(true);
  expect(f.unexpected).toEqual([]);
});
