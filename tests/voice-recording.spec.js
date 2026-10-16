import {test, expect} from '@playwright/test';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {mkdirSync} from 'node:fs';
const evidenceDir=process.env.MBOT_VOICE_OUTPUT || fileURLToPath(new URL('../test-results/voice-ui',import.meta.url));
mkdirSync(evidenceDir,{recursive:true});
let js, css, editorJs, editorCss;
const asset = {id:'clip-1',name:'Hello robot',durationMs:1200,bytes:1400,ready:true};
test.beforeAll(async()=>{
 const built = await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import VoiceRecording from './web/src/components/VoiceRecording.jsx';import './web/src/index.css';const root=createRoot(document.getElementById('root'));window.renderVoice=(status)=>root.render(<VoiceRecording runtimeStatus={status} onSelect={block=>window.selected=block}/>);window.unmountVoice=()=>root.unmount();window.renderVoice(window.initialStatus);`,resolveDir:fileURLToPath(new URL('..',import.meta.url)),loader:'jsx'},bundle:true,write:false,outdir:'/virtual',format:'iife',logLevel:'silent'});
 js=built.outputFiles.find(f=>f.path.endsWith('.js')).text;css=built.outputFiles.find(f=>f.path.endsWith('.css')).text;
 const editorBuilt=await build({stdin:{contents:`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import BlocklyEditor from './web/src/components/BlocklyEditor.jsx';import './web/src/index.css';function Harness(){const [blocks,setBlocks]=useState([{type:'repeat',times:1024,do:[{type:'wait',duration:0.01}]}]);return <BlocklyEditor blocks={blocks} onBlocksChange={v=>{window.emitted=v;setBlocks(v);}} robotStatus={{...window.initialStatus,build:'mbot-av-control-v1'}}/>;}createRoot(document.getElementById('root')).render(<Harness/>);`,resolveDir:fileURLToPath(new URL('..',import.meta.url)),loader:'jsx'},bundle:true,write:false,outdir:'/virtual',format:'iife',logLevel:'silent'});
 editorJs=editorBuilt.outputFiles.find(f=>f.path.endsWith('.js')).text;editorCss=editorBuilt.outputFiles.find(f=>f.path.endsWith('.css')).text;
});
async function mount(page,{supported=true,mode='normal',holdUpload=false,list=[asset],origin='https://voice.test',editor=false}={}) {
 const posts=[],unexpected=[];let release;
 await page.clock.install({time:new Date('2026-01-01T00:00:00Z')});await page.clock.pauseAt(new Date('2026-01-01T00:00:00Z'));
 await page.routeWebSocket('**/*',s=>s.close());
 await page.route('**/*',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname;
  if(path==='/') return route.fulfill({contentType:'text/html',body:'<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div>'});
  if(path==='/api/robot/recordings'&&req.method()==='GET') return route.fulfill({json:{recordings:list}});
  if(path==='/api/robot/recordings'&&req.method()==='POST') {posts.push({mime:req.headers()['content-type'],body:req.postData()});if(holdUpload)await new Promise(r=>release=r);return route.fulfill({json:{...asset,id:'new-clip'}}).catch(()=>{});}
  if(path==='/api/robot/recordings/clip-1'&&req.method()==='DELETE') {list=[];return route.fulfill({status:204});}
  if(path==='/api/robot/recordings/clip-1/sync'&&req.method()==='POST') return route.fulfill({json:asset});
  unexpected.push(path);return route.abort();
 });
 await page.addInitScript(({supported,mode})=>{
  window.initialStatus={robotOnline:true,capabilities:supported?['recorded_audio_v1']:[]};
  window.mediaProof={requested:0,stopped:0,revoked:[],created:[],plays:0};
  const proof=window.mediaProof;
  const create=URL.createObjectURL.bind(URL);URL.createObjectURL=b=>{const url=create(b);proof.created.push(url);return url;};
  const revoke=URL.revokeObjectURL.bind(URL);URL.revokeObjectURL=u=>{proof.revoked.push(u);revoke(u);};
  HTMLMediaElement.prototype.play=function(){proof.plays++;return Promise.resolve();};
  HTMLMediaElement.prototype.pause=function(){};
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>{
   proof.requested++;if(mode==='denied')throw new DOMException('Permission denied','NotAllowedError');
   if(mode==='pending')await new Promise(resolve=>window.grantMic=resolve);
   let stopped=false;const track={stop(){if(!stopped){stopped=true;proof.stopped++;}},addEventListener(){},removeEventListener(){}};
   return {getTracks:()=>[track]};
  }}});
  window.MediaRecorder=class {
   static isTypeSupported(type){return type==='audio/webm;codecs=opus';}
   constructor(stream,options){this.state='inactive';this.mimeType=options.mimeType;window.fakeRecorder=this;}
   start(){this.state='recording';if(mode==='start-error')throw Error('Encoder could not start');}
   stop(){this.state='inactive';queueMicrotask(()=>{this.ondataavailable?.({data:new Blob(['fake audio test fixture'],{type:this.mimeType})});this.onstop?.();});}
  };
  if(mode==='unsupported')window.MediaRecorder=undefined;
 },{supported,mode});
 await page.goto(origin);await page.addStyleTag({content:(editor?editorCss:css)+(editor?'#root{height:100vh}':'body{overflow:auto}#root{height:auto;max-width:600px;margin:24px auto;padding:12px}')});await page.addScriptTag({content:editor?editorJs:js});
 if(!editor)await expect(page.getByRole('heading',{name:'Voice clips'})).toBeVisible();
 else await expect(page.locator('.scratch-editor')).toBeVisible();
 return {posts,unexpected,release:()=>release?.()};
}
test('real editor Sound inserts a selected saved clip with trusted ID only',async({page})=>{
 const f=await mount(page,{editor:true});
 await page.getByTitle('Sound',{exact:true}).click();
 await page.getByLabel('Saved clip').selectOption('clip-1');
 await page.getByRole('button',{name:'Use clip',exact:true}).click();
 const selector=page.locator('.se-script.main').getByLabel('Recording');
 await expect(selector).toHaveValue('clip-1');
 await expect(selector.locator('option:checked')).toHaveText('Hello robot');
 const block=await page.evaluate(()=>emitted.at(-1));
 expect(block).toMatchObject({type:'play_recording',recording:'clip-1'});
 expect(Object.keys(block).sort()).toEqual(['_id','recording','type']);
 expect(f.posts).toEqual([]);expect(f.unexpected).toEqual([]);
 await page.screenshot({path:`${evidenceDir}/tablet-editor.png`,fullPage:true,animations:'disabled'});
});
test('tablet repeat 1024 input has room for digits and number spinner',async({page})=>{
 await mount(page,{editor:true});
 const repeat=page.locator('.se-script.main input[type=number]').first();
 await expect(repeat).toHaveValue('1024');
 const width=await repeat.evaluate(el=>el.getBoundingClientRect().width);
 expect(width).toBeGreaterThanOrEqual(60);
});

test('persisted unsynced clips preview locally but need explicit robot sync before use',async({page})=>{
 await mount(page,{list:[{...asset,ready:false}]});
 await page.getByLabel('Saved clip').selectOption('clip-1');
 await expect(page.getByRole('button',{name:'Preview',exact:true})).toBeEnabled();
 await expect(page.getByRole('button',{name:'Use clip',exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'Sync to robot',exact:true}).click();
 await expect(page.getByRole('button',{name:'Use clip',exact:true})).toBeEnabled();
});

test('installed capability is required and microphone is never requested on mount',async({page})=>{
 await mount(page,{supported:false});
 await expect(page.getByRole('button',{name:'Record',exact:true})).toBeDisabled();
 await expect(page.getByText(/Unavailable.*installed/)).toBeVisible();
 expect(await page.evaluate(()=>mediaProof.requested)).toBe(0);
 await page.screenshot({path:`${evidenceDir}/tablet-unavailable.png`,fullPage:true,animations:'disabled'});
});
for(const mode of ['denied','start-error','unsupported']) test(`microphone ${mode} is recoverable without leaked tracks`,async({page})=>{
 await mount(page,{mode});
 if(mode==='unsupported'){await expect(page.getByText(/does not support microphone/)).toBeVisible();return;}
 await page.getByRole('button',{name:'Record',exact:true}).click();
 await expect(page.getByRole('alert')).toBeVisible();
 expect(await page.evaluate(()=>mediaProof.stopped)).toBe(mode==='start-error'?1:0);
});
test('LAN HTTP explains secure-context requirement without requesting microphone',async({page})=>{
 await mount(page,{origin:'http://voice.test'});
 await expect(page.getByText(/needs HTTPS/)).toBeVisible();
 await expect(page.getByRole('button',{name:'Record',exact:true})).toBeDisabled();
 expect(await page.evaluate(()=>mediaProof.requested)).toBe(0);
});
for(const action of ['cancel','unmount','withdraw']) test(`late microphone grant after ${action} stops every track`,async({page})=>{
 await mount(page,{mode:'pending'});
 await page.getByRole('button',{name:'Record',exact:true}).click();
 await expect(page.getByText('Waiting for microphone permission…')).toBeVisible();
 if(action==='cancel')await page.getByRole('button',{name:'Cancel',exact:true}).click();
 if(action==='unmount')await page.evaluate(()=>unmountVoice());
 if(action==='withdraw'){await page.evaluate(()=>renderVoice({robotOnline:false,capabilities:[]}));await expect(page.getByText(/Unavailable.*installed/)).toBeVisible();}
 await page.evaluate(()=>grantMic());
 await expect.poll(()=>page.evaluate(()=>mediaProof.stopped)).toBe(1);
 expect(await page.evaluate(()=>window.fakeRecorder)).toBeUndefined();
});
for(const action of ['cancel','unmount','error','limit','stop']) test(`active ${action} releases microphone and draft URLs`,async({page})=>{
 await mount(page);
 await page.getByRole('button',{name:'Record',exact:true}).click();
 await expect(page.getByRole('button',{name:'Stop',exact:true})).toBeEnabled();
 if(action==='cancel')await page.getByRole('button',{name:'Cancel',exact:true}).click();
 if(action==='unmount')await page.evaluate(()=>unmountVoice());
 if(action==='error')await page.evaluate(()=>fakeRecorder.onerror({error:Error('encoder failed')}));
 if(action==='limit')await page.clock.runFor(3001);
 if(action==='stop')await page.getByRole('button',{name:'Stop',exact:true}).click();
 expect(await page.evaluate(()=>mediaProof.stopped)).toBe(1);
 if(['limit','stop'].includes(action)){
  await expect(page.getByRole('button',{name:'Delete draft'})).toBeVisible();
  await page.getByRole('button',{name:'Delete draft'}).click();
  const p=await page.evaluate(()=>mediaProof);expect(p.created).toHaveLength(1);expect(p.revoked).toEqual(p.created);
 }
});
test('cancelled upload response cannot select an old asset or overwrite a new recording',async({page})=>{
 const f=await mount(page,{holdUpload:true});
 await page.getByRole('button',{name:'Record',exact:true}).click();await page.clock.runFor(3001);
 await page.getByRole('button',{name:'Save clip'}).click();await expect.poll(()=>f.posts.length).toBe(1);
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await page.getByRole('button',{name:'Record',exact:true}).click();f.release();
 await expect(page.getByRole('button',{name:'Stop',exact:true})).toBeEnabled();
 await expect(page.getByLabel('Saved clip')).not.toHaveValue('new-clip');
 expect(await page.evaluate(()=>window.selected)).toBeUndefined();
});
test('saved delete is verified through refreshed registry; mobile controls fit',async({page})=>{
 await page.setViewportSize({width:390,height:844});await mount(page);
 await page.getByLabel('Saved clip').selectOption('clip-1');
 await expect(page.getByRole('button',{name:'Use clip',exact:true})).toBeEnabled();
 await page.screenshot({path:`${evidenceDir}/mobile-ready.png`,fullPage:true,animations:'disabled'});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.getByRole('button',{name:'Delete',exact:true}).click();
 await expect(page.getByLabel('Saved clip')).toHaveValue('');
 await expect(page.getByText(/Clip deleted/)).toBeVisible();
});

test('Record, three-second stop, preview, save, and explicit block selection',async({page})=>{
 const f=await mount(page);
 await page.getByLabel('Clip name').fill('A hello');
 await page.getByRole('button',{name:'Record',exact:true}).click();
 await expect(page.getByRole('button',{name:'Stop',exact:true})).toBeEnabled();
 await page.clock.runFor(3001);
 await expect(page.getByRole('button',{name:'Save clip',exact:true})).toBeEnabled();
 expect(await page.evaluate(()=>mediaProof.stopped)).toBe(1);
 await page.getByRole('button',{name:'Preview draft',exact:true}).click();
 expect(await page.evaluate(()=>mediaProof.plays)).toBe(1);
 await page.getByRole('button',{name:'Save clip',exact:true}).click();
 await expect(page.getByLabel('Saved clip')).toHaveValue('new-clip');
 expect(f.posts).toEqual([{mime:'audio/webm;codecs=opus',body:'fake audio test fixture'}]);
 expect(await page.evaluate(()=>window.selected)).toBeUndefined();
 await page.getByRole('button',{name:'Use clip',exact:true}).click();
 expect(await page.evaluate(()=>selected)).toEqual({type:'play_recording',recording:'new-clip'});
 expect(f.unexpected).toEqual([]);
});
