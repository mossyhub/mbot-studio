import {test,expect} from '@playwright/test';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
let js,css,editorJs,editorCss;
const id='a'.repeat(64),asset={id,name:'Test clip',durationMs:2000,bytes:8064,ready:false};
const idle={active:false,generation:0,phase:'idle',ackedBytes:0,totalBytes:null};
const active={active:true,generation:1,sessionId:'session-1',bootId:'boot-A',assetId:id,assetIndex:1,assetCount:1,phase:'transferring',ackedBytes:512,totalBytes:8064,startedAt:1,updatedAt:2,error:null};
test.beforeAll(async()=>{const b=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import VoiceRecording from './web/src/components/VoiceRecording.jsx';import './web/src/index.css';const root=createRoot(document.getElementById('root'));window.renderVoice=boot=>root.render(<VoiceRecording runtimeStatus={{robotOnline:true,mqttConnected:true,boot,build:'mbot-av-control-v1',capabilities:['recorded_audio_v1']}} onSelect={()=>{}}/>);renderVoice('boot-A');`,resolveDir:fileURLToPath(new URL('..',import.meta.url)),loader:'jsx'},bundle:true,write:false,outdir:'/virtual',format:'iife',logLevel:'silent'});js=b.outputFiles.find(f=>f.path.endsWith('.js')).text;css=b.outputFiles.find(f=>f.path.endsWith('.css')).text;});
test.beforeAll(async()=>{
 const b=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import Editor from './web/src/components/BlocklyEditor.jsx';import './web/src/index.css';createRoot(document.getElementById('root')).render(<Editor blocks={[]} onBlocksChange={()=>{}} robotStatus={{robotOnline:true,mqttConnected:true,boot:'boot-A',build:'mbot-av-control-v1',capabilities:['recorded_audio_v1']}}/>);`,resolveDir:fileURLToPath(new URL('..',import.meta.url)),loader:'jsx'},bundle:true,write:false,outdir:'/virtual',format:'iife',logLevel:'silent'});
 editorJs=b.outputFiles.find(f=>f.path.endsWith('.js')).text;editorCss=b.outputFiles.find(f=>f.path.endsWith('.css')).text;
});
async function mount(page,{initial=idle,editor=false}={}){
 let snapshot=initial,syncRoute,calls=0;const unexpected=[];
 await page.clock.install();await page.clock.pauseAt(new Date());await page.routeWebSocket('**/*',s=>s.close());
 await page.route('**/*',r=>{const path=new URL(r.request().url()).pathname;
  if(path==='/')return r.fulfill({contentType:'text/html',body:editor?'<div id="root"></div>':'<div class="se-palette-list" id="root"></div>'});
  if(path==='/api/robot/recordings')return r.fulfill({json:{recordings:[asset]}});
  if(path==='/api/robot/recordings/transfer-status'){calls++;return r.fulfill({json:snapshot});}
  if(path.endsWith('/sync')){syncRoute=r;return;}
  unexpected.push(path);return r.abort();
 });
 await page.addInitScript(()=>{
  navigator.mediaDevices.getUserMedia=()=>{throw Error('No microphone allowed');};HTMLMediaElement.prototype.load=function(){};
  const fetch=window.fetch.bind(window);window.holdNextProgress=false;window.pendingProgress=[];
  window.fetch=async(url,options)=>{
   const hold=url.endsWith('/transfer-status') && window.holdNextProgress;
   if(hold)window.holdNextProgress=false;
   const response=await fetch(url,options);const json=response.json.bind(response);
   response.json=async()=>{const value=await json();if(hold)await new Promise(resolve=>window.pendingProgress.push(resolve));return value;};
   return response;
  };
 });
 await page.goto('https://voice-progress.test/');await page.addStyleTag({content:(editor?editorCss:css)+(editor?'#root{height:100vh}':'#root{width:240px;height:360px;overflow:auto}')+'*{animation:none!important;transition:none!important}'});await page.addScriptTag({content:editor?editorJs:js});
 if(editor)await page.getByTitle('Sound',{exact:true}).click();
 await page.getByLabel('Saved clip').selectOption(id);
 return {snapshot:v=>snapshot=v,calls:()=>calls,unexpected,syncRoute:()=>syncRoute};
}
test('passive mount snapshot exposes another busy owner without background polling or readiness',async({page})=>{
 const f=await mount(page,{initial:active});await expect(button(page,'Sync to robot')).toBeDisabled();await expect(page.locator('.voice-sync-feedback')).toContainText('Robot busy');
 const count=f.calls();await page.clock.runFor(5000);expect(f.calls()).toBe(count);expect(f.syncRoute()).toBeUndefined();
 f.snapshot({...active,active:false,phase:'succeeded'});await button(page,'Refresh').click();await expect(button(page,'Sync to robot')).toBeEnabled();await expect(button(page,'Use clip')).toBeDisabled();
});
for(const change of ['cancel','boot'])test(`late progress body after ${change} cannot overwrite fresh sync`,async({page})=>{
 const f=await mount(page);await expect.poll(f.calls).toBe(1);await page.evaluate(()=>window.holdNextProgress=true);f.snapshot(active);await button(page,'Sync to robot').click();
 await expect.poll(()=>page.evaluate(()=>pendingProgress.length)).toBe(1);
 if(change==='cancel')await button(page,'Cancel').click();else {const count=f.calls();f.snapshot(idle);await page.evaluate(()=>renderVoice('boot-B'));await expect.poll(f.calls).toBe(count+1);}
 const boot=change==='boot'?'boot-B':'boot-A';f.snapshot({...active,generation:2,sessionId:'session-2',bootId:boot,ackedBytes:1024});
 await expect(button(page,'Sync to robot')).toBeEnabled();await button(page,'Sync to robot').click();await expect(page.getByRole('progressbar')).toHaveAttribute('value','1024');
 await page.evaluate(()=>pendingProgress.splice(0).forEach(resolve=>resolve()));await expect(page.getByRole('progressbar')).toHaveAttribute('value','1024');await expect(button(page,'Use clip')).toBeDisabled();
 await f.syncRoute().fulfill({json:{...asset,ready:true}});await expect(button(page,'Use clip')).toBeEnabled();expect(f.unexpected).toEqual([]);
});

for(const width of [1024,1280])test(`real editor progress and terminal error fit the Sound palette at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:768});const f=await mount(page,{editor:true});f.snapshot(active);await button(page,'Sync to robot').click();await expect(page.getByRole('progressbar')).toHaveAttribute('value','512');
 for(const target of [page.locator('.voice-sync-feedback'),button(page,'Cancel')])expect(await target.evaluate(e=>{const r=e.getBoundingClientRect(),p=e.closest('.se-palette-list').getBoundingClientRect();return r.top>=p.top&&r.bottom<=p.bottom&&r.left>=p.left&&r.right<=p.right;})).toBe(true);
 await f.syncRoute().fulfill({status:409,json:{error:'Recording sync was canceled. The clip is still saved on Studio.',code:'RECORDING_TRANSFER_REJECTED'}});await expect(page.getByRole('alert')).toContainText('canceled');
 expect(await page.locator('.voice-sync-feedback').evaluate(e=>{const r=e.getBoundingClientRect(),p=e.closest('.se-palette-list').getBoundingClientRect();return r.top>=p.top&&r.bottom<=p.bottom&&r.left>=p.left&&r.right<=p.right;})).toBe(true);
 await page.screenshot({path:test.info().outputPath(`editor-sync-failed-${width}.png`)});expect(f.unexpected).toEqual([]);
});

const button=(p,name)=>p.getByRole('button',{name,exact:true});
test('ACK bytes and verifying remain visible near Sync, success depends on POST not percent',async({page})=>{
 const f=await mount(page);await expect.poll(f.calls).toBe(1);f.snapshot(active);await button(page,'Sync to robot').click();
 await expect(page.getByRole('progressbar')).toHaveAttribute('value','512');await expect(page.locator('.voice-sync-feedback')).toContainText('512 / 8064');await expect(button(page,'Use clip')).toBeDisabled();
 expect(await page.locator('.voice-sync-feedback').evaluate(e=>{const r=e.getBoundingClientRect(),p=e.closest('.se-palette-list').getBoundingClientRect();return r.top>=p.top&&r.bottom<=p.bottom;})).toBe(true);
 expect(await button(page,'Cancel').evaluate(e=>{const r=e.getBoundingClientRect(),p=e.closest('.se-palette-list').getBoundingClientRect();return r.top>=p.top&&r.bottom<=p.bottom;})).toBe(true);
 await page.screenshot({path:test.info().outputPath('sync-transferring.png')});
 await page.clock.runFor(1000);f.snapshot({...active,phase:'verifying',ackedBytes:8064});await page.clock.runFor(1000);
 await expect(page.locator('.voice-sync-feedback')).toContainText(/Verifying/);await expect(page.getByRole('progressbar')).toHaveAttribute('value','8064');await expect(button(page,'Use clip')).toBeDisabled();
 await f.syncRoute().fulfill({json:{...asset,ready:true}});await expect(page.locator('.voice-sync-feedback')).toContainText(/verified on the robot/);await expect(button(page,'Use clip')).toBeEnabled();
 const visible=await page.locator('.voice-sync-feedback').evaluate(e=>{const r=e.getBoundingClientRect(),p=e.closest('.se-palette-list').getBoundingClientRect();return r.top>=p.top&&r.bottom<=p.bottom;});expect(visible).toBe(true);
 const calls=f.calls();await page.clock.runFor(5000);expect(f.calls()).toBe(calls);expect(f.unexpected).toEqual([]);
});
test('terminal HTTP409 is prominent, retained and recoverable without a fake ready receipt',async({page})=>{
 const f=await mount(page);f.snapshot(active);await button(page,'Sync to robot').click();await expect.poll(()=>!!f.syncRoute()).toBe(true);await expect(page.getByRole('progressbar')).toHaveAttribute('value','512');
 await f.syncRoute().fulfill({status:409,json:{code:'RECORDING_TRANSFER_REJECTED',error:'Recording sync timed out waiting for robot confirmation. The clip is still saved on Studio.'}});
 await expect(page.locator('.voice-sync-feedback').getByRole('alert')).toContainText('timed out');await expect(page.locator('.voice-sync-feedback')).toContainText('512 / 8064');await expect(button(page,'Use clip')).toBeDisabled();await expect(button(page,'Sync to robot')).toBeEnabled();
 await page.clock.runFor(10000);await expect(page.getByRole('alert')).toContainText('timed out');expect(f.unexpected).toEqual([]);
});
test('Cancel stops polling and old body cannot alter a fresh intentional sync',async({page})=>{
 const f=await mount(page);f.snapshot(active);await button(page,'Sync to robot').click();await expect(page.getByRole('progressbar')).toHaveAttribute('value','512');
 await button(page,'Cancel').click();const old=f.syncRoute();const calls=f.calls();await page.clock.runFor(4000);expect(f.calls()).toBe(calls);
 f.snapshot({...active,generation:2,sessionId:'session-2',ackedBytes:1024});await button(page,'Sync to robot').click();await expect(page.getByRole('progressbar')).toHaveAttribute('value','1024');
 await old.fulfill({json:{...asset,ready:true}}).catch(()=>{});await expect(button(page,'Use clip')).toBeDisabled();await expect(page.getByRole('progressbar')).toHaveAttribute('value','1024');
 await f.syncRoute().fulfill({json:{...asset,ready:true}});await expect(button(page,'Use clip')).toBeEnabled();expect(f.unexpected).toEqual([]);
});
