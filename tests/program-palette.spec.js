// Real React editor only; all requests fulfilled locally or aborted.
import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
let bundle;
const status = { build: 'mbot-av-control-v1', capabilities: ['move_forward','move_backward','turn_left','turn_right','dc_motor','servo','wait','stop','display_text','set_led','play_tone','play_sound','set_volume','stop_sound','display_animation'] };
test.beforeAll(async () => {
  bundle = (await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import Editor from './web/src/components/BlocklyEditor.jsx'; const root=createRoot(document.getElementById('root')); window.mount=(blocks,robotStatus)=>root.render(React.createElement(Editor,{blocks,robotStatus,onBlocksChange:b=>window.saved=b}));`, resolveDir: fileURLToPath(new URL('..',import.meta.url)), loader:'jsx' }, bundle:true,write:false,format:'iife',loader:{'.css':'empty'},logLevel:'silent' })).outputFiles[0].text;
});
async function mount(page, blocks=[], robotStatus=status) {
  await page.route('**/*',r=>r.request().url()==='http://palette.test/' ? r.fulfill({contentType:'text/html',body:'<div id="root"></div>'}) : r.abort());
  await page.goto('http://palette.test/');
  await page.addStyleTag({content:'#root{display:flex;height:700px}'+readFileSync(new URL('../web/src/components/BlocklyEditor.css',import.meta.url),'utf8')});
  await page.addScriptTag({content:bundle});
  await page.evaluate(({blocks,robotStatus})=>window.mount(blocks,robotStatus),{blocks,robotStatus});
}
test('power and native angle controls expand only on advertised capabilities without rewriting saved values', async ({page}) => {
  const blocks = [
    { type: 'move_forward', speed: 100, duration: 1, _id: 'forward' },
    { type: 'dc_motor', port: 'M1', speed: -100, duration: 1, _id: 'motor' },
    { type: 'turn_left', angle: 360, _id: 'left' },
  ];
  await mount(page, blocks);
  const forward = page.getByRole('group', { name: 'move forward block', exact: true }).locator('input').first();
  const dc = page.getByRole('group', { name: 'DC motor block', exact: true }).locator('input').first();
  const angle = page.getByRole('group', { name: 'turn left block', exact: true }).locator('input');
  await expect(forward).toHaveAttribute('max', '50');
  await expect(dc).toHaveAttribute('min', '-50');
  await expect(angle).toHaveAttribute('max', '30');
  await expect(forward).toHaveValue('100');
  await expect(dc).toHaveValue('-100');
  await expect(angle).toHaveValue('360');
  const expanded = { ...status, capabilities: [...status.capabilities, 'motor_power_100', 'turn_angle_360'] };
  await page.evaluate(({blocks, runtime}) => window.mount(blocks, runtime), { blocks, runtime: expanded });
  await expect(forward).toHaveAttribute('max', '100');
  await expect(dc).toHaveAttribute('min', '-100');
  await expect(dc).toHaveAttribute('max', '100');
  await expect(angle).toHaveAttribute('max', '360');
  expect(await page.evaluate(() => window.saved)).toBeUndefined();
  await angle.fill('90');
  expect((await page.evaluate(() => window.saved))[2].angle).toBe(90);
  await angle.fill('360');
  expect((await page.evaluate(() => window.saved))[2].angle).toBe(360);
  await page.evaluate(runtime => window.mount(window.saved, runtime), status);
  await expect(angle).toHaveAttribute('max', '30');
  await expect(angle).toHaveValue('360');
});

test('legacy values remain visible and unchanged with AV controls; legacy else is editable', async ({page})=>{
  const blocks=[{type:'turn_left',speed:75,angle:90},{type:'play_sound',sound:'meow'},{type:'if_predicate',cond:true,then:[],else:[{type:'wait',duration:2}]}];
  await mount(page,blocks);
  const turn=page.getByRole('group',{name:'turn left block',exact:true});
  await expect(turn.locator('input').last()).toHaveAttribute('max','30');
  await expect(turn).toContainText('speed: 75');
  await expect(page.getByRole('group',{name:'play sound block'}).locator('select')).toHaveValue('meow');
  await expect(page.getByRole('group',{name:'play sound block'})).toContainText('Unavailable: meow');
  await expect(page.locator('.se-script.main .se-mouth-divider')).toHaveText('else');
  await page.getByRole('group',{name:'wait block',exact:true}).locator('input').fill('3');
  const saved=await page.evaluate(()=>window.saved);
  expect(saved[0]).toMatchObject(blocks[0]); expect(saved[1]).toMatchObject(blocks[1]);
  expect(saved[2]).toMatchObject({type:'if_else_predicate',cond:true,else:[{type:'wait',duration:3}]});
  expect((readFileSync(new URL('../web/src/components/BlocklyEditor.jsx',import.meta.url),'utf8').match(/^  if_predicate:/gm)||[])).toHaveLength(1);
});

test('Robot-ready matches the real lowerer subset rather than candidate expressions', async ({page})=>{
  await mount(page);
  const search=page.getByRole('searchbox',{name:'Search blocks'});
  await search.fill('op_');
  await expect(page.locator('.se-palette-entry .reporter, .se-palette-entry .predicate')).toHaveCount(13);
  await expect(page.locator('.se-palette').getByText('join',{exact:true})).toHaveCount(0);
  await search.fill('say');
  await expect(page.getByRole('button',{name:'Add say',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Add say',exact:true}).press('Enter');
  expect((await page.evaluate(()=>window.saved))[0]).toMatchObject({type:'say',text:'Hi!'});
  await page.evaluate(s=>window.mount(window.saved,{...s,capabilities:[]}),status);
  await search.fill('move forward');
  await expect(page.getByRole('button',{name:'Add move forward',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'All blocks',exact:true}).click();
  await expect(page.locator('.se-palette')).toContainText('does not advertise');
});

test('runtime updates preserve stored values and drag defaults remain runtime-specific', async ({page})=>{
  const blocks=[{type:'turn_right',angle:120,speed:65,_id:'stored-turn'}];
  await mount(page,blocks,null);
  await expect(page.locator('.se-palette')).toContainText('Runtime unverified');
  await expect(page.getByRole('group',{name:'turn right block'}).locator('input').last()).toHaveValue('120');
  await page.evaluate(({blocks,status})=>window.mount(blocks,status),{blocks,status});
  expect(await page.evaluate(()=>window.saved)).toBeUndefined();
  await page.getByRole('searchbox',{name:'Search blocks'}).fill('turn left');
  const transfer=await page.evaluateHandle(()=>new DataTransfer());
  await page.getByRole('button',{name:'Add turn left',exact:true}).dispatchEvent('dragstart',{dataTransfer:transfer});
  await page.locator('.se-script.main > [data-arr-slot]').last().dispatchEvent('drop',{dataTransfer:transfer});
  await transfer.dispose();
  expect(await page.evaluate(()=>window.saved)).toEqual([blocks[0],{type:'turn_left',angle:30,_id:expect.any(String)}]);
});

test('AV palette is Robot-ready, searches across categories and click-add uses AV defaults', async ({page})=>{
  await mount(page);
  await expect(page.getByRole('button',{name:'Robot-ready',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(page.locator('.se-palette').getByText('set motor speed',{exact:true})).toHaveCount(0);
  await page.getByRole('searchbox',{name:'Search blocks'}).fill('turn left');
  await page.getByRole('button',{name:'Add turn left',exact:true}).click();
  expect(await page.evaluate(()=>window.saved)).toEqual([{type:'turn_left',angle:30,_id:expect.any(String)}]);
  await page.getByRole('searchbox',{name:'Search blocks'}).fill('servo');
  await page.getByRole('button',{name:'Add move servo',exact:true}).click();
  expect((await page.evaluate(()=>window.saved))[1]).toMatchObject({type:'servo',speed:0});
  await page.getByRole('button',{name:'All blocks',exact:true}).click();
  await page.getByRole('searchbox',{name:'Search blocks'}).fill('forever');
  await expect(page.locator('.se-palette')).toContainText('Requires on-device dynamic control flow');
});
