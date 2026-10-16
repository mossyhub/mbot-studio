import {test,expect} from '@playwright/test';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {lowerProgram} from '../server/src/services/program-lowering.js';
let js,css;
test.beforeAll(async()=>{const r=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import App from './web/src/App.jsx';import './web/src/index.css';createRoot(document.getElementById('root')).render(<App/>);`,resolveDir:fileURLToPath(new URL('..',import.meta.url)),loader:'jsx'},bundle:true,write:false,outdir:'/virtual',format:'iife',logLevel:'silent'});js=r.outputFiles.find(f=>f.path.endsWith('.js')).text;css=r.outputFiles.find(f=>f.path.endsWith('.css')).text;});
async function mount(page,{ack=true,early=false}={}) {
  const posts=[],sockets=[],unexpected=[];
  await page.routeWebSocket('**/ws',socket=>sockets.push(socket));
  const send=(event='completed',run_id='run-1',type='program')=>sockets.forEach(s=>s.send(JSON.stringify({type:'mqtt',topic:'robot/execution',data:{event,run_id,type}})));
  await page.route('**/*',async r=>{
    const path=new URL(r.request().url()).pathname;
    if(path==='/')return r.fulfill({contentType:'text/html',body:'<div id="root"></div>'});
    if(path==='/api/config')return r.fulfill({json:{additions:[]}});
    if(path==='/api/ai/model')return r.fulfill({json:{model:'test'}});
    if(path==='/api/ai/blocks-to-code')return r.fulfill({json:{code:'# source preview'}});
    if(path==='/api/robot/status')return r.fulfill({json:{robotOnline:true,mqttConnected:true,application:'cooperative-v1',build:'mbot-av-control-v1',capabilities:['move_forward','move_backward','turn_left','turn_right','wait','stop','set_led','display_text','play_tone','play_sound','display_animation','servo','dc_motor'],armed:true,motion_enabled:true}});
    if(path==='/api/robot/program/validate')return r.fulfill({json:{runnable:true,...lowerProgram(r.request().postDataJSON().program)}});
    if(path==='/api/robot/program') {const body=r.request().postDataJSON();posts.push(body);if(early)send();return r.fulfill({json:ack?{sent:true,run_id:`run-${posts.length}`,...lowerProgram(body.program)}:{sent:true}});}
    if(path==='/api/robot/stop')return r.fulfill({json:{sent:true}});
    unexpected.push(path);return r.abort();
  });
  await page.addInitScript(()=>{localStorage.setItem('mbot-studio-profiles',JSON.stringify([{id:'a',name:'Alex'},{id:'b',name:'Blair'}]));localStorage.setItem('mbot-studio-current-profile','a');localStorage.setItem('mbot-studio-muted','true');});
  await page.goto('http://missions.test/');await page.addStyleTag({content:css});await page.addScriptTag({content:js});
  await expect(page.locator('.scratch-editor')).toBeVisible();
  return {posts,send,unexpected};
}
async function start(page) {
  await page.getByRole('button',{name:'Challenges',exact:false}).click();
  await page.getByRole('button',{name:/First Steps/}).click();
  await page.getByRole('button',{name:'Start Programming',exact:false}).click();
  await expect(page.getByTestId('mission-strip')).toContainText('First Steps');
  await expect(page.locator('.se-script.main input[type="number"]').last()).toHaveValue('1');
  await page.locator('.se-script.main input[type="number"]').last().fill('2');
  await expect(page.getByRole('button',{name:'Run Program'})).toBeEnabled();
}
const saved = page=>page.evaluate(()=>JSON.parse(localStorage.getItem('mbot-studio-challenges:a')||'{}'));
test('real App Start → edit → Run → correlated completion → automatic challenge credit',async({page})=>{
 const fixture=await mount(page);await start(page);
 await page.getByRole('button',{name:'Run Program'}).click();await expect.poll(()=>fixture.posts.length).toBe(1);
 await expect(page.getByTestId('program-lifecycle')).toContainText('Submitted');
 expect(await saved(page)).toEqual({});
 fixture.send('started');fixture.send('completed','other');fixture.send('completed','run-1','move_forward');
 expect(await saved(page)).toEqual({});
 // Editing while a run is in flight must not change the submitted evidence.
 await page.locator('.se-script.main input[type="number"]').last().fill('1');
 fixture.send();await expect(page.getByTestId('mission-strip')).toContainText('Device-confirmed');
 fixture.send();
 await page.getByRole('button',{name:'Challenges',exact:false}).click();
 await expect(page.locator('.challenge-card').filter({hasText:'First Steps'})).toContainText('Device-confirmed');
 expect((await saved(page)).ch_forward.verification).toBe('device-completed');
 const stats=await page.evaluate(()=>JSON.parse(localStorage.getItem('mbot-studio-achievements:a')).stats);
 expect(stats.verified_runs).toBe(1);expect(fixture.unexpected).toEqual([]);
 await page.screenshot({path:test.info().outputPath('challenges-desktop.png')});
 await page.setViewportSize({width:820,height:900});await page.screenshot({path:test.info().outputPath('challenges-tablet.png')});
});
for(const kind of ['failed','canceled'])test(`${kind} then delayed completion earns nothing`,async({page})=>{const f=await mount(page);await start(page);await page.getByRole('button',{name:'Run Program'}).click();await expect.poll(()=>f.posts.length).toBe(1);f.send(kind);await expect(page.getByTestId('program-lifecycle')).toContainText(kind==='failed'?'Failed':'Canceled');f.send();expect(await saved(page)).toEqual({});});
test('profile switch invalidates run awards even after switching back',async({page})=>{const f=await mount(page);await start(page);await page.getByRole('button',{name:'Run Program'}).click();await expect.poll(()=>f.posts.length).toBe(1);await page.getByTitle('Switch child profile').click();await page.getByRole('button',{name:'Blair',exact:true}).click();f.send();await page.getByTitle('Switch child profile').click();await page.getByRole('button',{name:'Alex',exact:true}).click();f.send();expect(await saved(page)).toEqual({});expect(await page.evaluate(()=>localStorage.getItem('mbot-studio-achievements:b'))).toBeNull();});
test('ACK without run ID gives no credit',async({page})=>{const f=await mount(page,{ack:false});await start(page);await page.getByRole('button',{name:'Run Program'}).click();await expect(page.getByTestId('program-lifecycle')).toContainText('Unverified');expect(await saved(page)).toEqual({});});
test('completion before HTTP response is buffered and verified once',async({page})=>{await mount(page,{early:true});await start(page);await page.getByRole('button',{name:'Run Program'}).click();await expect(page.getByTestId('mission-strip')).toContainText('Device-confirmed');});
test('editing a submitted non-solution into a solution cannot credit the older run',async({page})=>{
 const f=await mount(page);await start(page);await page.locator('.se-script.main input[type="number"]').last().fill('1');await expect(page.getByRole('button',{name:'Run Program'})).toBeEnabled();await page.getByRole('button',{name:'Run Program'}).click();await expect.poll(()=>f.posts.length).toBe(1);await page.locator('.se-script.main input[type="number"]').last().fill('2');f.send();await expect(page.getByTestId('program-lifecycle')).toContainText('Completed');expect(await saved(page)).toEqual({});
});
test('Stop invalidates earning before the cancellation event arrives',async({page})=>{
 const f=await mount(page);await start(page);
 const status=page.getByTestId('program-lifecycle');
 const run=page.getByRole('button',{name:'Run Program'});
 await run.click();await expect(status).toContainText('Submitted');
 await page.getByRole('button',{name:'🛑 STOP',exact:true}).click();
 await expect(status).toContainText('device stop is not confirmed');
 // An in-flight completion can arrive after Stop. It cannot become success or credit.
 f.send();await expect(status).toContainText('Unverified');
 await expect(status).not.toContainText('Completed');
 expect(await saved(page)).toEqual({});
 expect(await page.evaluate(()=>localStorage.getItem('mbot-studio-achievements:a')||'')).not.toContain('first_program');
 await expect(run).toBeEnabled();await run.click();
 await expect(status).toContainText('Submitted — awaiting device confirmation (run-2)');
 f.send('canceled','run-1');f.send('completed','run-1');
 await expect(status).toContainText('Submitted — awaiting device confirmation (run-2)');
 f.send('completed','run-2');await expect(page.getByTestId('mission-strip')).toContainText('Device-confirmed');
 expect((await saved(page)).ch_forward.runId).toBe('run-2');
 expect(f.posts).toHaveLength(2);expect(f.unexpected).toEqual([]);
});
test('historical reused badge IDs keep original meanings and dates while current awards stay independent',async({page})=>{
 const f=await mount(page);
 const history={first_program:11,used_condition:22,five_programs:33,all_beginner:44};
 await page.evaluate(earned=>localStorage.setItem('mbot-studio-achievements:a',JSON.stringify({earned,stats:{programs_run:19}})),history);
 await page.getByRole('button',{name:/🏆/}).click();
 const current=page.locator('.achievements-panel > .achievements-grid');
 const legacy=page.locator('.achievement-legacy');
 await expect(current.locator('.achievement-card.earned')).toHaveCount(0);
 await expect(page.locator('.achievements-count')).toContainText('0 / 24');
 await expect(legacy.locator('.achievement-card')).toHaveCount(4);
 const oldCriteria={'Hello Robot!':'Run your first program.','Decision Maker':'Use an if/else condition.','Prolific Coder':'Run 5 different programs.','Beginner Champion':'Complete every beginner challenge.'};
 for(const [name,description] of Object.entries(oldCriteria)) {
  const card=legacy.locator('.achievement-card').filter({has:page.getByRole('heading',{name,exact:true})});
  await expect(card).toContainText(description);
  await expect(card).toContainText(await page.evaluate(()=>new Date(11).toLocaleDateString()));
 }
 await expect(legacy).toContainText('Just keep running programs — every Run counts!');
 await start(page);
 await page.getByRole('button',{name:'Run Program'}).click();await expect.poll(()=>f.posts.length).toBe(1);
 f.send();await expect(page.getByTestId('mission-strip')).toContainText('Device-confirmed');
 await page.getByRole('button',{name:/🏆/}).click();
 const hello=current.locator('.achievement-card').filter({has:page.getByRole('heading',{name:'Hello Robot!',exact:true})});
 await expect(hello).toHaveClass(/earned/);
 await expect(hello).toContainText('Finish a program with matching device confirmation.');
 const state=await page.evaluate(()=>JSON.parse(localStorage.getItem('mbot-studio-achievements:a')));
 expect(state.earned).toEqual(history);
 expect(state.earnedByVersion['curriculum-v2'].first_program).toBeGreaterThan(history.first_program);
 await expect(hello).toContainText(await page.evaluate(t=>new Date(t).toLocaleDateString(),state.earnedByVersion['curriculum-v2'].first_program));
 await expect(legacy.locator('.achievement-card')).toHaveCount(4);
 await expect(current.locator('.achievement-card').filter({hasText:'Decision Maker'})).not.toHaveClass(/earned/);
 expect(f.unexpected).toEqual([]);
});

test('all three levels are navigable; configured hardware gate and legacy collections are honest',async({page})=>{
 await mount(page);
 await page.evaluate(()=>{localStorage.setItem('mbot-studio-challenges:a',JSON.stringify({ch_square:{stars:2,completedAt:42},ch_forward:{stars:1,completedAt:43}}));localStorage.setItem('mbot-studio-achievements:a',JSON.stringify({earned:{night_coder:42,unknown_old_badge:43},stats:{programs_run:12}}));});
 await page.getByRole('button',{name:'Challenges',exact:false}).click();await expect(page.locator('.challenge-card').filter({hasText:'First Steps'})).toContainText('Previously earned');await expect(page.getByRole('button',{name:'I Did It',exact:false})).toHaveCount(0);
 await page.getByRole('button',{name:/LEVEL 2 Builder/}).click();await expect(page.locator('.challenge-card')).toHaveCount(5);
 await page.getByRole('button',{name:/LEVEL 3 Inventor/}).click();await page.locator('.challenge-card').filter({hasText:'Gentle Claw Pulses'}).click();await expect(page.getByRole('button',{name:'Start Programming'})).toBeDisabled();await expect(page.locator('.challenge-detail')).toContainText('Configure M1');
 await page.getByText('Legacy collection · 1 past missions').click();await expect(page.locator('.mission-legacy')).toContainText('Square Dance');
 await page.getByRole('button',{name:/🏆/}).click();await expect(page.locator('.achievement-legacy')).toContainText('Night Owl');await expect(page.locator('.achievement-legacy')).toContainText('unknown_old_badge');await expect(page.getByRole('button',{name:/Reset/})).toHaveCount(0);await page.screenshot({path:test.info().outputPath('achievements-desktop.png')});
});
