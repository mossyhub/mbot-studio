// Isolated real JSX: no server, MQTT, device or application shell.
import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  args: ['--no-sandbox', '--disable-dev-shm-usage'] } });
let bundle;
test.beforeAll(async () => {
  const result = await build({ stdin: { contents: `import React from 'react';
    import {createRoot} from 'react-dom/client';
    import Editor from './web/src/components/BlocklyEditor.jsx';
    const root=createRoot(document.getElementById('root'));
    window.mount=(blocks,guidedMode=true,props={})=>{window.edited=blocks;root.render(React.createElement(Editor,
      {blocks,...(guidedMode===null?{}:{guidedMode}),...props,onBlocksChange:next=>{window.edited=next}}));};`,
    resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'jsx' },
    bundle:true,write:false,format:'iife',loader:{'.css':'empty'},logLevel:'silent' });
  bundle=result.outputFiles[0].text;
});
async function mount(page, blocks=[], guided=true, recordings=[], props={}) {
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>r.request().url()==='http://guided-editor.test/'
    ? r.fulfill({contentType:'text/html',body:'<div id="root"></div>'})
    : r.request().url()==='http://guided-editor.test/api/robot/recordings'
      ? r.fulfill({json:{recordings}}) : r.abort());
  await page.goto('http://guided-editor.test/');
  await page.addStyleTag({content:'*{box-sizing:border-box}body{margin:0}#root{display:flex;height:900px;max-height:100dvh}'
    +readFileSync(new URL('../web/src/components/BlocklyEditor.css',import.meta.url),'utf8')});
  await page.addScriptTag({content:bundle});
  await page.evaluate(({blocks,guided,props})=>window.mount(blocks,guided,props),{blocks,guided,props});
  await expect(page.locator('.scratch-editor')).toBeVisible();
  return errors;
}
const saved=page=>page.evaluate(()=>window.edited);

for(const width of [370,820,1440]) test(`Guided SVG joints and wrapped imported fields fit ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:1000});
  const blocks=[{type:'repeat',_id:'outer',times:3,do:[
    {type:'repeat',_id:'inner',times:2,do:[{type:'move_forward',_id:'move',params:{speed:25,duration:1}}]},
    {type:'if_else_predicate',_id:'if',cond:{type:'op_lt',_id:'less',a:{type:'sensor_distance',_id:'distance'},b:20},
      then:[{type:'wait',_id:'wait',params:{duration:1}}],else:[{type:'set_led',_id:'led',color:'green'}]}
  ]},{type:'display_text',_id:'text',params:{text:'Preserve me',size:16}}];
  const errors=await mount(page,blocks);
  await expect(page.locator('.se-script.main > .hat > .se-guided-shape path')).toHaveAttribute('d',/M/);
  await expect(page.getByRole('spinbutton',{name:'wait sec'})).toHaveValue('1');
  await page.getByRole('spinbutton',{name:'wait sec'}).fill('2');
  const edited=structuredClone(blocks); edited[0].do[1].then[0].params.duration=2;
  expect(await saved(page)).toEqual(edited);
  await page.getByRole('textbox',{name:'show text text'}).fill('Still wrapped');
  edited[1].params.text='Still wrapped'; expect(await saved(page)).toEqual(edited);
  await expect.poll(()=>page.evaluate(()=>{
    const root=document.querySelector('.se-script.main');
    const gaps=[];
    for(const container of [root,...root.querySelectorAll('.se-mouth')]){
      const children=[...container.children].filter(e=>e.matches('.se-block-shape'));
      children.slice(1).forEach((e,i)=>gaps.push(e.getBoundingClientRect().top-children[i].getBoundingClientRect().bottom));
      if(container.matches('.se-mouth')&&children.length){
        gaps.push(children[0].getBoundingClientRect().top-container.getBoundingClientRect().top);
        gaps.push(container.getBoundingClientRect().bottom-children.at(-1).getBoundingClientRect().bottom);
      }
    }
    return gaps.every(g=>Math.abs(g)<0.6);
  })).toBe(true);
  const geometry=await page.evaluate(()=>{
    const root=document.querySelector('.se-script.main');
    const groups=[...root.querySelectorAll('.se-block-shape')];
    return {overflow:document.documentElement.scrollWidth>innerWidth,
      outside:groups.filter(e=>e.getBoundingClientRect().right>innerWidth).map(e=>e.getAttribute('aria-label')),
      font:getComputedStyle(root.querySelector('input')).fontSize,
      paths:groups.every(e=>!!e.querySelector(':scope > .se-guided-shape path')?.getAttribute('d')),
      mouths:[...root.querySelectorAll('.se-mouth')].map(e=>({padding:getComputedStyle(e).padding,rail:e.getBoundingClientRect().left-e.parentElement.getBoundingClientRect().left})),
      // Shared 26x6 shoulder paints inside the socket; the C mouth stays open on the right.
      fills:[...root.querySelectorAll('.c > .se-guided-shape, .e > .se-guided-shape')].map(svg=>{
        const p=svg.firstElementChild,head=svg.parentElement.querySelector(':scope > .se-block-row');
        const y=head.getBoundingClientRect().height;
        return [p.isPointInFill(new DOMPoint(47,y+3)),p.isPointInFill(new DOMPoint(6,y+10)),p.isPointInFill(new DOMPoint(100,y+10))];
      })};
  });
  expect(geometry.overflow).toBe(false);expect(geometry.outside).toEqual([]);
  expect(geometry.font).toBe('14px');expect(geometry.paths).toBe(true);
  for(const m of geometry.mouths){expect(m.padding).toBe('0px');expect(m.rail).toBe(12);}
  for(const fill of geometry.fills) expect(fill).toEqual([true,true,false]);
  await page.screenshot({path:test.info().outputPath(`guided-${width}.png`),fullPage:true});
  expect(errors).toEqual([]);
});

async function dragLabel(page, source, target, offset={x:0,y:0}, cancel=false) {
  const label=await source.locator(':scope > .se-block-row > .se-block-text').boundingBox();
  const box=await source.boundingBox();
  const start={x:label.x+label.width/2,y:label.y+label.height/2};
  await source.evaluate(el=>window.original=el);
  await page.mouse.move(start.x,start.y);await page.mouse.down();
  await page.mouse.move(start.x+8,start.y,{steps:3});
  const joint=await target.boundingBox();
  const end={x:joint.x+(start.x-box.x)+offset.x,y:joint.y+(start.y-box.y)+offset.y};
  await page.mouse.move(end.x,end.y,{steps:15});await page.mouse.move(end.x+0.1,end.y);
  await expect(target).toHaveClass(/snap-active/);
  expect(await source.evaluate(el=>el===window.original)).toBe(true);
  await expect(page.locator('.se-moving-original')).toHaveCount(1);
  if(cancel) await page.keyboard.press('Escape');
  await page.mouse.up();
}

test('Guided connector magnet reorders original nodes from labels and builds nested repeats',async({page})=>{
  const errors=await mount(page);
  await page.getByRole('button',{name:'Add Blocks',exact:true}).click();
  await page.getByTitle('Control',{exact:true}).click();
  await page.getByRole('button',{name:'Add repeat',exact:true}).click();
  await page.getByRole('button',{name:'Add repeat',exact:true}).click();
  await page.getByRole('button',{name:'Add wait',exact:true}).click();
  await page.getByRole('button',{name:'Close Add Blocks'}).click();
  const initial=await saved(page), [outer,inner,wait]=initial;
  const main=page.locator('.se-script.main');
  await dragLabel(page,main.locator(':scope > .c').nth(1),page.locator(`[data-target-parent="${outer._id}"][data-target-index="0"][data-arr-slot]`));
  expect(await saved(page)).toEqual([{...outer,do:[inner]},wait]);
  await dragLabel(page,page.getByRole('group',{name:'wait block',exact:true}),page.locator(`[data-target-parent="${inner._id}"][data-target-index="0"][data-arr-slot]`),{x:16,y:12});
  expect(await saved(page)).toEqual([{...outer,do:[{...inner,do:[wait]}]}]);
  await dragLabel(page,page.getByRole('group',{name:'wait block',exact:true}),main.locator(':scope > [data-arr-slot][data-target-index="0"]'),{x:0,y:0},true);
  expect(await saved(page)).toEqual([{...outer,do:[{...inner,do:[wait]}]}]);
  await dragLabel(page,page.getByRole('group',{name:'wait block',exact:true}),main.locator(':scope > [data-arr-slot][data-target-index="0"]'));
  expect(await saved(page)).toEqual([wait,{...outer,do:[inner]}]);
  expect(errors).toEqual([]);
});

test('Guided connector does not magnetize a label near a joint when its top socket is over 28px away',async({page})=>{
  const blocks=[{type:'wait',duration:1,_id:'a'},{type:'set_led',color:'green',_id:'b'}];
  await mount(page,blocks);
  const source=page.getByRole('group',{name:'set LEDs block',exact:true});
  const box=await source.boundingBox(),label=await source.locator('.se-block-text').boundingBox();
  const x=label.x+label.width/2,y=label.y+label.height/2;
  const target=await page.locator('.se-script.main > [data-target-index="0"]').boundingBox();
  await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+8,y,{steps:3});
  // Cursor is at joint height but the dragged socket is 70px to its right.
  await page.mouse.move(target.x+(x-box.x)+70,target.y,{steps:12});
  await page.mouse.move(target.x+(x-box.x)+70.1,target.y);
  await expect(page.locator('.snap-active, .se-slot.active')).toHaveCount(0);
  await page.keyboard.press('Escape');await page.mouse.up();expect(await saved(page)).toEqual(blocks);
});

for(const zoom of [0.5,1.5]) test(`Guided magnetic move and Escape survive ${zoom} zoom and canvas scroll`,async({page})=>{
  const blocks=[{type:'wait',duration:1,_id:'a'},{type:'set_led',color:'green',_id:'b'}];
  await mount(page,blocks);
  for(let i=0;i<5;i++) await page.getByTitle(zoom<1?'Zoom out':'Zoom in',{exact:true}).click();
  await page.waitForTimeout(150);
  await page.locator('.se-canvas').evaluate(el=>{el.scrollTop=8;el.scrollLeft=8;});
  const source=page.getByRole('group',{name:'set LEDs block',exact:true});
  const target=page.locator('.se-script.main > [data-target-index="0"]');
  await dragLabel(page,source,target,{x:12,y:-8},true);
  expect(await saved(page)).toEqual(blocks);
  await dragLabel(page,source,target,{x:12,y:-8});
  expect(await saved(page)).toEqual([blocks[1],blocks[0]]);
});

test('Guided touch moves the original block, cancels safely, then commits through the same tree operations',async({page})=>{
  const blocks=[{type:'wait',duration:1,_id:'a'},{type:'set_led',color:'green',_id:'b'}];
  const errors=await mount(page,blocks);
  const cdp=await page.context().newCDPSession(page);
  const source=page.getByRole('group',{name:'set LEDs block',exact:true});
  for(const cancel of [true,false]){
    const box=await source.boundingBox(),label=await source.locator('.se-block-text').boundingBox();
    const x=label.x+label.width/2,y=label.y+label.height/2;
    const target=page.locator('.se-script.main > [data-target-index="0"]');
    const joint=await target.boundingBox();
    await source.evaluate(el=>window.original=el);
    const touch=(type,x,y)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'||type==='touchCancel'?[]:[{x,y}]});
    await touch('touchStart',x,y);await touch('touchMove',x+12,y);
    await expect(source).toHaveClass(/se-moving-original/);
    expect(await source.evaluate(el=>el===window.original)).toBe(true);
    expect(await saved(page)).toEqual(blocks);
    await touch('touchMove',joint.x+(x-box.x),joint.y+(y-box.y));
    await expect(target).toHaveClass(/snap-active/);
    await touch(cancel?'touchCancel':'touchEnd');
    await expect(page.locator('.se-moving-original')).toHaveCount(0);
    expect(await saved(page)).toEqual(cancel?blocks:[blocks[1],blocks[0]]);
  }
  expect(errors).toEqual([]);
});

test('Guided palette drag exposes the canvas and connects a compatible reporter without deleting wrapped fields',async({page})=>{
  await page.setViewportSize({width:370,height:900});
  const blocks=[{type:'wait',params:{duration:1},_id:'wait'}];
  await mount(page,blocks);
  await page.getByRole('button',{name:'Add Blocks',exact:true}).click();
  await page.getByTitle('Sensing',{exact:true}).click();
  const source=page.locator('.se-palette .reporter.palette').filter({has:page.getByText('distance',{exact:true})});
  const box=await source.boundingBox();
  await page.mouse.move(box.x+12,box.y+12);await page.mouse.down();
  await page.mouse.move(box.x+30,box.y+12,{steps:5});
  await expect(page.getByRole('region',{name:'Add Blocks'})).toBeHidden();
  const socket=page.locator('[data-target-parent="wait"][data-target-key="duration"]');
  const dest=await socket.boundingBox();
  await page.mouse.move(dest.x+dest.width/2,dest.y+dest.height/2,{steps:12});
  await page.mouse.move(dest.x+dest.width/2+0.1,dest.y+dest.height/2);await page.mouse.up();
  await expect.poll(async()=>(await saved(page))[0].params.duration.type).toBe('sensor_distance');
  expect((await saved(page))[0]._id).toBe('wait');
  expect((await saved(page))[0]).not.toHaveProperty('duration');
});

test('Guided native trash drop deletes the block instead of detaching it',async({page})=>{
  await mount(page,[{type:'wait',duration:1,_id:'wait'}]);
  const label=await page.getByRole('group',{name:'wait block',exact:true}).locator('.se-block-text').boundingBox();
  await page.mouse.move(label.x+10,label.y+8);await page.mouse.down();
  await page.mouse.move(label.x+30,label.y+8,{steps:5});
  const trash=page.locator('.se-trash');await expect(trash).toHaveClass(/visible/);
  const target=await trash.boundingBox();
  await page.mouse.move(target.x+target.width/2,target.y+target.height/2,{steps:12});
  await page.mouse.move(target.x+target.width/2+0.1,target.y+target.height/2);await page.mouse.up();
  await expect.poll(()=>saved(page)).toEqual([]);
  await expect(page.locator('.se-script.floating')).toHaveCount(0);
  await expect(page.locator('.se-count')).toHaveText('0 blocks');
});

test('Guided retains recording IDs/options, wrapped reporter clone fences and explicit unknown-parameter repair',async({page})=>{
  const blocks=[{type:'wait',_id:'wait',params:{duration:{type:'op_add',_id:'sum',a:1,b:2},extra:75}},
    {type:'play_recording',_id:'recording',params:{recording:'ready-clip'}}];
  const recordings=[{id:'ready-clip',name:'Ready voice',ready:true,durationMs:500,bytes:100},
    {id:'pending-clip',name:'Not ready',ready:false,durationMs:500,bytes:100}];
  const errors=await mount(page,blocks,true,recordings);
  const select=page.getByRole('combobox',{name:'Recording'});
  await expect(select).toHaveValue('ready-clip');
  await expect(select.locator('option')).toHaveText(['Ready voice']);
  expect(await saved(page)).toEqual(blocks);
  await page.getByRole('button',{name:'Remove unsupported extra',exact:true}).click();
  expect((await saved(page))[0].params).not.toHaveProperty('extra');
  await page.getByRole('group',{name:'wait block',exact:true}).locator(':scope > .se-block-row > .se-block-text').click();
  await page.keyboard.press('Control+d');
  const copied=await saved(page);
  expect(copied[0]._id).not.toBe(copied[1]._id);
  expect(copied[0].params.duration._id).not.toBe(copied[1].params.duration._id);
  await page.getByRole('group',{name:'wait block',exact:true}).nth(1).getByRole('spinbutton',{name:'+ a'}).fill('4');
  const edited=await saved(page);
  expect(edited[0].params.duration.a).toBe(1);expect(edited[1].params.duration.a).toBe(4);
  expect(edited[2]).toEqual(blocks[1]);expect(errors).toEqual([]);
});

test('Guided drawer opens the actual catalog, adds two blocks and returns focus on Close',async({page})=>{
  const errors=await mount(page);
  const add=page.getByRole('button',{name:'Add Blocks',exact:true});
  await expect(add).toBeVisible();
  await expect(page.getByRole('searchbox',{name:'Search blocks'})).toBeHidden();
  await add.click();
  await expect(page.getByRole('region',{name:'Add Blocks'})).toBeVisible();
  await page.getByRole('button',{name:'Add move forward',exact:true}).click();
  await page.getByRole('button',{name:'Add move backward',exact:true}).click();
  expect((await saved(page)).map(b=>b.type)).toEqual(['move_forward','move_backward']);
  await page.getByRole('button',{name:'Close Add Blocks'}).click();
  await expect(add).toBeFocused();
  await expect(page.locator('.se-cats')).toBeHidden();
  expect(errors).toEqual([]);
});

const recordingStatus={robotOnline:true,mqttConnected:true,capabilities:['recorded_audio_v1']};
test('Guided mobile reporter chooser fills primitive and empty wrapped fields without overwriting occupied expressions',async({page})=>{
  await page.setViewportSize({width:370,height:900});
  const original=[
    {type:'wait',_id:'primitive',params:{duration:2,extra:'preserved'}},
    {type:'if_predicate',_id:'empty',params:{},then:[{type:'display_text',_id:'text',params:{text:'Keep me',size:16}}]},
    {type:'wait',_id:'occupied',params:{duration:{type:'sensor_timer',_id:'timer'}}},
    {type:'set_led',_id:'literal',color:'green'}
  ];
  const errors=await mount(page,original);
  await page.getByRole('button',{name:'Add Blocks',exact:true}).click();
  await page.getByTitle('Sensing',{exact:true}).click();
  const distance=page.getByRole('button',{name:'Choose field for distance',exact:true});
  await expect(distance).toBeVisible();
  const box=await distance.boundingBox(),cdp=await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+box.width/2,y:box.y+box.height/2}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  const chooser=page.getByRole('region',{name:'Choose reporter field'});
  await expect(chooser).toBeVisible();
  const fields=chooser.getByRole('combobox',{name:'Compatible field'});
  await expect(fields).toBeFocused();
  const options=await fields.locator('option').allTextContents();
  expect(options.some(s=>s.includes('1. wait')&&s.includes('duration'))).toBe(true);
  expect(options.some(s=>s.includes('3. wait'))).toBe(false);
  expect(options.some(s=>s.includes('cond')||s.includes('color'))).toBe(false);
  expect(await saved(page)).toEqual(original); // Choosing a reporter is not an implicit insert.
  await fields.selectOption({label:options.find(s=>s.includes('1. wait')&&s.includes('duration'))});
  await chooser.getByRole('button',{name:'Insert reporter',exact:true}).click();
  const inserted=await saved(page);
  expect(inserted[0].params.duration).toMatchObject({type:'sensor_distance'});
  expect(inserted[0].params.extra).toBe('preserved');expect(inserted[0]).not.toHaveProperty('duration');
  expect(inserted.slice(1)).toEqual(original.slice(1));
  await expect(page.getByRole('button',{name:'Add Blocks',exact:true})).toBeFocused();
  await page.getByRole('button',{name:'Add Blocks',exact:true}).click();
  await page.getByTitle('Operators',{exact:true}).click();
  const less=page.getByRole('button',{name:'Choose field for <',exact:true});
  await less.focus();await page.keyboard.press('Enter');
  const boolOptions=await fields.locator('option').allTextContents();
  expect(boolOptions.filter(s=>s.includes('cond'))).toHaveLength(1);
  expect(boolOptions.some(s=>s.includes('duration'))).toBe(false);
  await fields.selectOption({label:boolOptions.find(s=>s.includes('cond'))});
  await chooser.getByRole('button',{name:'Insert reporter',exact:true}).focus();await page.keyboard.press('Space');
  const final=await saved(page);
  expect(final[0]).toEqual(inserted[0]);
  expect(final[1].params.cond).toMatchObject({type:'op_lt',a:0,b:50});
  expect(final[1]).not.toHaveProperty('cond');expect(final[1].then).toEqual(original[1].then);
  expect(final.slice(2)).toEqual(original.slice(2));expect(errors).toEqual([]);
});
test('Guided chooser shares runtime gates and edits nested wrapped reporter arguments without replacing their parent',async({page})=>{
  const blocks=[{type:'repeat',_id:'repeat',params:{times:3},do:[
    {type:'wait',_id:'wait',params:{duration:{type:'op_add',_id:'sum',params:{a:7,b:9}}}}
  ]},{type:'display_text',_id:'text',params:{text:'Keep text',size:16}}];
  const errors=await mount(page,blocks);
  await page.getByRole('button',{name:'Add Blocks',exact:true}).click();
  await page.getByTitle('Sensing',{exact:true}).click();
  await page.getByRole('button',{name:'Choose field for distance',exact:true}).click();
  const fields=page.getByRole('combobox',{name:'Compatible field'});
  const before=await fields.locator('option').allTextContents();
  await fields.selectOption({label:before.find(s=>s.includes('› a (currently 7)'))});
  // A status update while the chooser is open cannot retain a stale eligible
  // destination for a now-unsupported live sensor.
  const robotStatus={build:'mbot-av-control-v1',robotOnline:true,capabilities:['wait','display_text']};
  await page.evaluate(({blocks,robotStatus})=>window.mount(blocks,true,{robotStatus}),{blocks,robotStatus});
  await expect(fields.locator('option')).toHaveCount(1);
  await expect(page.getByRole('button',{name:'Insert reporter',exact:true})).toBeDisabled();
  expect(await saved(page)).toEqual(blocks);
  await page.getByTitle('Operators',{exact:true}).click();
  await page.getByRole('button',{name:'Choose field for +',exact:true}).click();
  const options=await fields.locator('option').allTextContents();
  expect(options.some(s=>s.includes('› times')||s.includes('› text (')||s.includes('› duration ('))).toBe(false);
  await fields.selectOption({label:options.find(s=>s.includes('› a (currently 7)'))});
  await page.getByRole('button',{name:'Insert reporter',exact:true}).click();
  const expected=structuredClone(blocks);
  expected[0].do[0].params.duration.params.a={type:'op_add',a:0,b:0,_id:expect.any(String)};
  expect(await saved(page)).toEqual(expected);
  expect(errors).toEqual([]);
});

test('Guided reporter drops still reject moving an expression into its own argument',async({page})=>{
  const blocks=[{type:'wait',_id:'wait',params:{duration:{type:'op_add',_id:'sum',params:{a:7,b:9}}}}];
  const errors=await mount(page,blocks);
  const transfer=await page.evaluateHandle(()=>new DataTransfer());
  const source=page.getByRole('group',{name:'+ block',exact:true});
  await source.dispatchEvent('dragstart',{dataTransfer:transfer});
  const self=page.locator('[data-target-parent="sum"][data-target-key="a"]');
  await self.dispatchEvent('dragover',{dataTransfer:transfer});
  await expect(self).not.toHaveClass(/active|snap/);
  await self.dispatchEvent('drop',{dataTransfer:transfer});
  await source.dispatchEvent('dragend',{dataTransfer:transfer});
  expect(await saved(page)).toEqual(blocks);
  await expect(page.locator('.se-script.floating')).toHaveCount(0);expect(errors).toEqual([]);
});

test('Guided mobile My Robot actions add by tap and keyboard with configured values',async({page})=>{
  await page.setViewportSize({width:370,height:900});
  const original=[{type:'wait',_id:'original',params:{duration:2}}];
  const robotConfig={additions:[
    {type:'servo',port:'S1',label:'Arm',actions:[{name:'Lift',angle:0}]},
    {type:'dc_motor',port:'M1',label:'Claw',actions:[{name:'Open',speed:37,motorDirection:'reverse',duration:0.5}]},
    {type:'servo',port:'bad-port',label:'Broken',actions:[{name:'Invalid',angle:90}]}
  ]};
  const errors=await mount(page,original,true,[],{robotConfig});
  await page.getByRole('button',{name:'Add Blocks',exact:true}).click();
  await page.getByRole('button',{name:'My Robot',exact:false}).click();
  const lift=page.getByRole('button',{name:'Add Arm: Lift',exact:true});
  await expect(lift).toBeVisible();
  const box=await lift.boundingBox();
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+box.width/2,y:box.y+box.height/2}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await expect.poll(async()=>(await saved(page)).length).toBe(2);
  const open=page.getByRole('button',{name:'Add Claw: Open',exact:true});
  await open.focus();await page.keyboard.press('Enter');
  await lift.focus();await page.keyboard.press('Space');
  const added=await saved(page);
  expect(added[0]).toEqual(original[0]);
  expect(added[1]).toMatchObject({type:'servo',port:'S1',angle:0});
  expect(added[2]).toMatchObject({type:'dc_motor',port:'M1',speed:-37,duration:0.5});
  expect(added[3]).toMatchObject({type:'servo',port:'S1',angle:0});
  expect(new Set(added.map(b=>b._id)).size).toBe(4);
  const invalid=page.getByRole('button',{name:'Add Broken: Invalid',exact:true});
  await expect(invalid).toHaveAttribute('aria-disabled','true');
  await invalid.focus();await page.keyboard.press('Enter');await invalid.click({force:true});
  expect(await saved(page)).toEqual(added);
  expect(robotConfig.additions[0].actions[0].angle).toBe(0);expect(errors).toEqual([]);
});
async function fakeMicrophone(page) {
  await page.addInitScript(()=>{
    // Only the device/encoder are fake; cancellation exercises the real editor
    // and VoiceRecording lifecycle, including permission granted after unmount.
    Object.defineProperty(window,'isSecureContext',{value:true});
    window.mic={requests:0,starts:0,stops:0,tracksStopped:0};
    Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:()=>{
      window.mic.requests++;
      return new Promise(resolve=>{window.grantMicrophone=()=>resolve({getTracks:()=>[{
        stop:()=>window.mic.tracksStopped++,addEventListener:()=>{}
      }]});});
    }}});
    window.MediaRecorder=class {
      static isTypeSupported(){return true;}
      constructor(stream,options){this.mimeType=options.mimeType;this.state='inactive';}
      start(){this.state='recording';window.mic.starts++;}
      stop(){this.state='inactive';window.mic.stops++;
        this.ondataavailable?.({data:new Blob(['fixture audio'],{type:this.mimeType})});this.onstop?.();}
    };
  });
}
async function openVoice(page) {
  await page.getByRole('button',{name:'Add Blocks',exact:true}).click();
  await page.getByTitle('Sound',{exact:true}).click();
  await expect(page.getByRole('button',{name:'Record',exact:true})).toBeEnabled();
}
async function cancelVoice(page,via) {
  if(via==='close') await page.getByRole('button',{name:'Close Add Blocks'}).click();
  else if(via==='category') await page.getByTitle('Control',{exact:true}).click();
  else await page.evaluate(()=>window.dispatchEvent(new Event('mbot-global-stop')));
}
for(const operation of ['upload','sync']) for(const via of ['close','global Stop','category'])
test(`Guided ${via} aborts ${operation} and fences a late response across intentional reopening`,async({page})=>{
  await fakeMicrophone(page);
  const clip={id:'saved-clip',name:'Saved voice',ready:false,durationMs:500,bytes:100};
  const errors=await mount(page,[],true,[clip],{robotStatus:recordingStatus});
  await page.evaluate(()=>{
    const fetch=window.fetch;window.operationRequests=0;
    window.fetch=(url,options)=>{
      if(options?.method==='POST' && String(url).includes('/recordings')) {
        window.operationRequests++;
        window.operationSignal=options.signal;
        // Hold the parsed-body continuation independently of abort. This is
        // the late server response case, not just a rejected fetch mock.
        return Promise.resolve({ok:true,status:200,json:()=>new Promise(resolve=>{window.finishOperation=resolve;})});
      }
      return fetch(url,options);
    };
  });
  await openVoice(page);
  if(operation==='upload') {
    await page.getByRole('button',{name:'Record',exact:true}).click();
    await page.evaluate(()=>window.grantMicrophone());
    await page.getByRole('button',{name:'Stop',exact:true}).click();
    await page.getByRole('button',{name:'Save clip',exact:true}).click();
  } else {
    await page.getByRole('combobox',{name:'Saved clip',exact:true}).selectOption(clip.id);
    await page.getByRole('button',{name:'Sync to robot',exact:true}).click();
  }
  await expect.poll(()=>page.evaluate(()=>typeof window.finishOperation)).toBe('function');
  await cancelVoice(page,via);
  await expect(page.locator('.voice-recording')).toHaveCount(0);
  expect(await page.evaluate(()=>window.operationSignal.aborted)).toBe(true);
  if(via==='category') await page.getByTitle('Sound',{exact:true}).click();else await openVoice(page);
  await page.evaluate(clip=>window.finishOperation({...clip,ready:true,name:'LATE RESULT'}),clip);
  await expect(page.getByRole('button',{name:'Record',exact:true})).toBeEnabled();
  await expect(page.getByRole('button',{name:'Use clip',exact:true})).toBeDisabled();
  await expect(page.getByRole('button',{name:'Save clip',exact:true})).toHaveCount(0);
  await expect(page.getByText(/Clip verified|Clip saved|LATE RESULT/)).toHaveCount(0);
  expect(await page.evaluate(()=>window.operationRequests)).toBe(1);
  expect(await saved(page)).toEqual([]);
  // A new, explicit sync works after cancellation; no old request resumes it.
  await page.getByRole('combobox',{name:'Saved clip',exact:true}).selectOption(clip.id);
  await page.getByRole('button',{name:'Sync to robot',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.operationRequests)).toBe(2);
  await page.evaluate(clip=>window.finishOperation({...clip,ready:true}),clip);
  await expect(page.getByRole('button',{name:'Use clip',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Use clip',exact:true}).click();
  expect(await saved(page)).toEqual([{type:'play_recording',recording:clip.id,_id:expect.any(String)}]);
  expect(errors).toEqual([]);
});

test('Legacy editor keeps its existing recording and native-only palette behavior by default',async({page})=>{
  await fakeMicrophone(page);
  await mount(page,[],null,[],{robotStatus:recordingStatus});
  await expect(page.getByRole('button',{name:'Add Blocks',exact:true})).toHaveCount(0);
  await page.getByTitle('Sound',{exact:true}).click();
  await page.getByRole('button',{name:'Record',exact:true}).click();
  await page.evaluate(()=>window.dispatchEvent(new Event('mbot-global-stop')));
  await expect(page.getByText('Waiting for microphone permission…')).toBeVisible();
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.evaluate(()=>window.grantMicrophone());
  await expect.poll(()=>page.evaluate(()=>window.mic.tracksStopped)).toBe(1);
  await page.getByTitle('Sensing',{exact:true}).click();
  await expect(page.getByRole('button',{name:'Choose field for distance',exact:true})).toHaveCount(0);
  await expect(page.locator('.se-palette .reporter.palette').first()).toHaveAttribute('draggable','true');
});

for(const via of ['close','global Stop','category']) test(`Guided ${via} cancels pending microphone and requires fresh Record`,async({page})=>{
  await fakeMicrophone(page);
  const errors=await mount(page,[],true,[],{robotStatus:recordingStatus});
  await openVoice(page);
  await page.getByRole('button',{name:'Record',exact:true}).click();
  await expect(page.getByText('Waiting for microphone permission…')).toBeVisible();
  await cancelVoice(page,via);
  await expect(page.locator('.voice-recording')).toHaveCount(0);
  await page.evaluate(()=>window.grantMicrophone());
  await expect.poll(()=>page.evaluate(()=>window.mic.tracksStopped)).toBe(1);
  expect(await page.evaluate(()=>window.mic.starts)).toBe(0);
  if(via==='category') await page.getByTitle('Sound',{exact:true}).click();
  else await openVoice(page);
  await expect(page.getByRole('button',{name:'Record',exact:true})).toBeEnabled();
  expect(await page.evaluate(()=>window.mic.requests)).toBe(1);
  await page.getByRole('button',{name:'Record',exact:true}).click();
  await page.evaluate(()=>window.grantMicrophone());
  await expect.poll(()=>page.evaluate(()=>window.mic.starts)).toBe(1);
  await cancelVoice(page,via);
  await expect.poll(()=>page.evaluate(()=>window.mic.stops)).toBe(1);
  expect(await page.evaluate(()=>window.mic.tracksStopped)).toBe(2);
  expect(await saved(page)).toEqual([]);expect(errors).toEqual([]);
});
