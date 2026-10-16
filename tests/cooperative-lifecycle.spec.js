import { test, expect } from '@playwright/test';
import { lowerProgram } from '../server/src/services/program-lowering.js';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

let js, css;
test.beforeAll(async () => {
  const result = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import App from './web/src/App.jsx';import './web/src/index.css';createRoot(document.getElementById('root')).render(<App/>);`, resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'jsx' }, bundle: true, write: false, outdir: '/virtual', format: 'iife', logLevel: 'silent' });
  js = result.outputFiles.find(file => file.path.endsWith('.js')).text;
  css = result.outputFiles.find(file => file.path.endsWith('.css')).text;
});

async function setup(page, beforeResponse) {
  // Bundle the real App in memory: no app server, broker, or device required.
  await page.route('**/*', route => route.request().url() === 'http://lifecycle.test/'
    ? route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }) : route.abort());
  // All unneeded API reads/previews stay isolated from the running service.
  await page.route('**/api/**', r => r.fulfill({json:{}}));
  await page.addInitScript(() => {
    localStorage.setItem('mbot-studio-current-profile', 'profile_default');
    localStorage.setItem('mbot-studio-current-project:profile_default', 'lifecycle');
    localStorage.setItem('mbot-studio-projects:profile_default', JSON.stringify([{id:'lifecycle',name:'Lifecycle',savedAt:new Date().toISOString(),blocks:[{type:'wait',duration:1}]}]));
  });
  let socket;
  await page.routeWebSocket('**/ws', ws => { socket = ws; });
  await page.route('**/api/robot/status', r => r.fulfill({json:{robotOnline:true,mqttConnected:true,application:'cooperative-v1',motion_enabled:false,armed:false}}));
  const emit = async (event, run_id = 'run-current', type = 'program') => {
    await expect.poll(() => Boolean(socket), {timeout:2000}).toBe(true);
    socket.send(JSON.stringify({type:'mqtt',topic:'robot/execution',data:{run_id,event,type,details:'device detail'}}));
  };
  let submissions = 0;
  await page.route('**/api/robot/program', async r => {
    const run_id = ++submissions === 1 ? 'run-current' : `run-${submissions}`;
    if (beforeResponse) {
      await beforeResponse(emit);
      await page.waitForTimeout(100); // Deliver WS frames while HTTP is still held.
    }
    // Completion credit now requires the real admission source-map contract.
    await r.fulfill({json:{sent:true,run_id,...lowerProgram(r.request().postDataJSON().program)}});
  });
  await page.goto('http://lifecycle.test/');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: js });
  await page.getByRole('button',{name:'Run Program'}).click();
  return emit;
}

test('publish is not success; correlated device failure is terminal', async ({page}) => {
  const emit = await setup(page);
  const status = page.getByTestId('program-lifecycle');
  await expect(status).toContainText('Submitted');
  expect(await page.evaluate(() => localStorage.getItem('mbot-studio-achievements:profile_default') || '')).not.toContain('first_program');
  await emit('completed','unrelated');
  await emit('completed','run-current','wait');
  await expect(status).toContainText('Submitted');
  await expect(page.getByRole('button',{name:'Run Program'})).toBeDisabled();
  await emit('failed');
  await expect(status).toContainText('Failed');
  await emit('completed');
  await expect(status).toContainText('Failed');
  await expect(page.getByRole('button',{name:'Run Program'})).toBeEnabled();
});

test('correlated completion before HTTP response is retained', async ({page}) => {
  await setup(page, async emit => { await emit('accepted'); await emit('started'); await emit('completed'); });
  await expect(page.getByTestId('program-lifecycle')).toContainText('Completed');
  expect(await page.evaluate(() => localStorage.getItem('mbot-studio-achievements:profile_default'))).toContain('first_program');
  await expect(page.getByRole('button',{name:'Run Program'})).toBeEnabled();
});

for (const stopOutcome of ['ack', 'http-error', 'network-error']) test(`STOP ${stopOutcome} is not cancellation; device canceled is terminal and a fresh Run works`, async ({page}) => {
  const emit = await setup(page);
  const status = page.getByTestId('program-lifecycle');
  const run = page.getByRole('button',{name:'Run Program'});
  await expect(status).toContainText('Submitted');
  let stops = 0;
  await page.route('**/api/robot/stop', r => {
    stops++;
    return stopOutcome === 'network-error' ? r.abort('failed') : r.fulfill({
      status: stopOutcome === 'ack' ? 200 : 503,
      json: stopOutcome === 'ack' ? {sent:true} : {error:'Stop unavailable'},
    });
  });
  await page.getByRole('button',{name:'🛑 STOP',exact:true}).click();
  await expect.poll(() => stops).toBe(1);
  await expect(status).toContainText('device stop is not confirmed');
  await expect(status).not.toContainText('device confirmed');
  // A known submitted run still owns bounded observation, not submission/award rights.
  await expect(run).toBeDisabled();
  for (const [event, id, type] of [
    ['started', 'run-current', 'program'], ['accepted', 'run-current', 'program'],
    ['canceled', 'unrelated', 'program'], ['canceled', 'run-current', 'wait'],
  ]) await emit(event, id, type);
  await expect(status).toContainText('device stop is not confirmed');
  await page.getByRole('button',{name:'🛑 STOP',exact:true}).click();
  await expect.poll(() => stops).toBe(2);
  await emit('canceled');
  await expect(status).toContainText('Canceled — device confirmed (run-current)');
  await emit('completed');
  await expect(status).toContainText('Canceled — device confirmed (run-current)');
  expect(await page.evaluate(() => localStorage.getItem('mbot-studio-achievements:profile_default') || '')).not.toContain('first_program');
  await expect(run).toBeEnabled();
  await run.click();
  await expect(status).toContainText('Submitted — awaiting device confirmation (run-2)');
  await emit('canceled');
  await emit('completed');
  await expect(status).toContainText('Submitted — awaiting device confirmation (run-2)');
  await emit('completed', 'run-2');
  await expect(status).toContainText('Completed — device confirmed (run-2)');
  expect(await page.evaluate(() => localStorage.getItem('mbot-studio-achievements:profile_default'))).toContain('first_program');
});

test('repeated Stop retains the original observation deadline; timeout is unverified and recovery is intentional', async ({page}) => {
  const time = new Date('2026-01-01T00:00:00Z');
  await page.clock.install({time});await page.clock.pauseAt(time);
  const emit = await setup(page);
  const status = page.getByTestId('program-lifecycle');
  const run = page.getByRole('button',{name:'Run Program'});
  await expect(status).toContainText('Submitted');
  await page.clock.runFor(119000);
  await page.getByRole('button',{name:'🛑 STOP',exact:true}).click();
  await page.getByRole('button',{name:'🛑 STOP',exact:true}).click();
  await expect(status).toContainText('device stop is not confirmed');
  await expect(run).toBeDisabled();
  await page.clock.runFor(1001);
  await expect(status).toContainText('Unverified — timed out');
  await expect(status).toContainText('the robot may still be running');
  await emit('canceled');await emit('completed');
  await expect(status).toContainText('Unverified — timed out');
  await expect(run).toBeEnabled();await run.click();
  await expect(status).toContainText('Submitted — awaiting device confirmation (run-2)');
  await emit('completed','run-2');
  await expect(status).toContainText('Completed — device confirmed (run-2)');
});

test('device failure after Stop remains a failure, not confirmation of successful cancellation', async ({page}) => {
  const emit = await setup(page);
  const status = page.getByTestId('program-lifecycle');
  await expect(status).toContainText('Submitted');
  await page.getByRole('button',{name:'🛑 STOP',exact:true}).click();
  await expect(status).toContainText('device stop is not confirmed');
  await emit('failed');
  await expect(status).toContainText('Failed — device confirmed (run-current)');
  await emit('canceled');await emit('completed');
  await expect(status).toContainText('Failed — device confirmed (run-current)');
  expect(await page.evaluate(() => localStorage.getItem('mbot-studio-achievements:profile_default') || '')).not.toContain('first_program');
  await expect(page.getByRole('button',{name:'Run Program'})).toBeEnabled();
});

test('missing terminal event times out unverified, never success', async ({page}) => {
  await page.clock.install();
  const emit = await setup(page);
  const status = page.getByTestId('program-lifecycle');
  await expect(status).toContainText('Submitted');
  await page.clock.fastForward(120001);
  await expect(status).toContainText('Unverified');
  await expect(status).toContainText('may still be running');
  await emit('completed');
  await expect(status).toContainText('Unverified');
  expect(await page.evaluate(() => localStorage.getItem('mbot-studio-achievements:profile_default') || '')).not.toContain('first_program');
  await expect(page.getByRole('button',{name:'Run Program'})).toBeEnabled();
});
