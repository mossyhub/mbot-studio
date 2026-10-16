import {test,expect} from '@playwright/test';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
test.use({viewport:{width:1280,height:800},launchOptions:{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,args:['--no-sandbox']}});
let js,css;
test.beforeAll(async()=>{const r=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import App from './web/src/App.jsx';import './web/src/index.css';createRoot(document.getElementById('root')).render(<App/>);`,resolveDir:fileURLToPath(new URL('..',import.meta.url)),loader:'jsx'},bundle:true,write:false,outdir:'/virtual',format:'iife',logLevel:'silent'});js=r.outputFiles.find(f=>f.path.endsWith('.js')).text;css=r.outputFiles.find(f=>f.path.endsWith('.css')).text;});
async function mount(page,blocks=[]){
 const posts=[];await page.route('**/*',r=>r.request().url()==='http://connection.test/'?r.fulfill({contentType:'text/html',body:'<div id="root"></div>'}):r.fulfill({json:{}}));
 await page.routeWebSocket('**/ws',()=>{});
 await page.route('**/api/robot/status',r=>r.fulfill({json:{robotOnline:true,mqttConnected:true,application:'cooperative-v1',build:'mbot-av-control-v1',capabilities:['wait','stop'],armed:true,motion_enabled:true}}));
 await page.route('**/api/robot/program/validate',r=>r.fulfill({json:{runnable:true,compiledCount:r.request().postDataJSON().program.length}}));
 await page.route('**/api/robot/program',r=>{posts.push(r.request().postDataJSON());return r.fulfill({json:{sent:true,run_id:'test-run'}})});
 await page.addInitScript(blocks=>{localStorage.setItem('mbot-studio-current-profile','profile_default');localStorage.setItem('mbot-studio-current-project:profile_default','connection');localStorage.setItem('mbot-studio-projects:profile_default',JSON.stringify([{id:'connection',name:'Connection test',blocks}]));},blocks);
 await page.goto('http://connection.test/');await page.addStyleTag({content:css});await page.addScriptTag({content:js});await expect(page.locator('.scratch-editor')).toBeVisible();
 return posts;
}
async function dragLooseWait(page){
 await page.getByTitle('Control',{exact:true}).click();
 const source=page.getByRole('button',{name:'Add wait',exact:true});const box=await source.boundingBox();
 await page.mouse.move(box.x+12,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+30,box.y+box.height/2,{steps:5});await page.mouse.move(900,460,{steps:12});await page.mouse.up();
 await expect(page.locator('.se-script.floating')).toHaveCount(1);
}
test('loose blocks explain why Run is disabled and explicitly connect without executing',async({page})=>{
 const posts=await mount(page);await dragLooseWait(page);
 await expect(page.getByTestId('program-readiness')).toContainText('not connected');
 await expect(page.getByRole('button',{name:'Run Program'})).toBeDisabled();
 await expect(page.locator('.se-script.floating')).toContainText('Not connected');
 await page.getByRole('button',{name:'Connect to program',exact:true}).click();
 await expect(page.locator('.se-script.floating')).toHaveCount(0);
 await expect(page.getByTestId('program-readiness')).toContainText('Ready to run');
 expect(posts).toEqual([]);
 await page.getByRole('button',{name:'Run Program'}).click();await expect.poll(()=>posts.length).toBe(1);
 expect(posts[0].program.map(({type,duration})=>({type,duration}))).toEqual([{type:'wait',duration:1}]);
});
test('mixed workspace warns and connects an entire loose stack once in order',async({page})=>{
 const posts=await mount(page,[{type:'wait',duration:0.1,_id:'main'}]);await dragLooseWait(page);
 const transfer=await page.evaluateHandle(()=>new DataTransfer());const source=page.getByRole('button',{name:'Add wait',exact:true});
 await source.dispatchEvent('dragstart',{dataTransfer:transfer});const slot=page.locator('.se-script.floating [data-arr-slot]').last();await slot.dispatchEvent('dragover',{dataTransfer:transfer});await slot.dispatchEvent('drop',{dataTransfer:transfer});await transfer.dispose();
 await expect(page.locator('.se-script.floating .se-prim.num')).toHaveCount(2);
 await expect(page.getByTestId('program-readiness')).toContainText('2 blocks not connected');
 await page.getByRole('button',{name:'Connect to program',exact:true}).click();
 await expect(page.getByRole('button',{name:'Run Program'})).toBeEnabled();
 await expect(page.getByTestId('program-readiness')).not.toContainText('not connected');
 await page.getByRole('button',{name:'Run Program'}).click();await expect.poll(()=>posts.length).toBe(1);
 expect(posts[0].program.map(b=>b.duration)).toEqual([0.1,1,1]);
 expect(new Set(posts[0].program.map(b=>b._id)).size).toBe(3);
});
