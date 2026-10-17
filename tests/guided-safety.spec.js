import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { lowerProgram } from '../server/src/services/program-lowering.js';
import { INDEXED_PROGRAM_PROFILE as profile } from '../server/src/services/program-encoding.js';

let script, stylesheet;
test.beforeAll(async () => {
  const result = await build({ stdin: {
    contents: `import React from 'react';import {createRoot} from 'react-dom/client';import App from './web/src/App.jsx';import RobotConfig from './web/src/components/RobotConfig.jsx';import './web/src/index.css';createRoot(document.getElementById('root')).render(window.standaloneConfig ? <RobotConfig config={{additions:[]}} robotConnected/> : <App/>);`,
    resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'jsx',
  }, bundle: true, write: false, outdir: '/virtual', format: 'iife', logLevel: 'silent' });
  script = result.outputFiles.find(file => file.path.endsWith('.js')).text;
  stylesheet = result.outputFiles.find(file => file.path.endsWith('.css')).text;
});

async function mount(page, { standalone = false, program = null } = {}) {
  const requests = [], messages = [], errors = [], unexpected = [], sockets = [];
  const proof = blocks => ({ runnable: true, ...lowerProgram(blocks, { profile }), encoding: profile.encoding, limits: profile.limits, uniqueCommandCount: 1, wireBytes: 200 });
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T00:00:00Z'));
  page.on('pageerror', error => errors.push(error.message));
  // Includes Setup's local mLink probes: nothing reaches hardware or a broker.
  await page.routeWebSocket('**/*', socket => {
    sockets.push(socket);
    socket.onMessage(data => messages.push({ url: socket.url(), data: JSON.parse(data) }));
  });
  await page.route('**/*', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.isNavigationRequest() && path === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div>' });
    requests.push({ method: request.method(), path, body: request.postData() });
    const fixtures = {
      '/api/config': { additions: [] }, '/api/config/firmware': { files: [], suggested: {} },
      '/api/config/calibrations': { calibrations: {} }, '/api/ai/model': { model: 'isolated-fixture' },
      '/api/robot/status': { robotOnline: true, mqttConnected: true, robotState: 'idle', application: 'cooperative-v1', build: 'mbot-av-control-v1', boot: 'boot-1', armed: true, motion_enabled: true, capabilities: ['move_forward', 'wait', 'program_indexed_v1'] },
      '/api/robot/telemetry': { robotOnline: true, sensors: {}, sampling: false },
      '/api/recordings': { assets: [] },
    };
    if (request.method() === 'GET' && path in fixtures) return route.fulfill({ json: fixtures[path] });
    if (request.method() === 'POST' && path === '/api/robot/stop') return route.fulfill({ json: { success: true } });
    if (request.method() === 'POST' && path === '/api/ai/blocks-to-code') return route.fulfill({ json: { code: '# fixture preview' } });
    if (request.method() === 'POST' && path === '/api/robot/program/validate') return route.fulfill({ json: proof(request.postDataJSON().program) });
    if (request.method() === 'POST' && path === '/api/robot/program') return route.fulfill({ json: { ...proof(request.postDataJSON().program), sent: true, run_id: `run-${requests.filter(r => r.path === path).length}` } });
    unexpected.push(`${request.method()} ${path}`); return route.abort();
  });
  await page.addInitScript(({ standalone, program }) => {
    window.standaloneConfig = standalone;
    localStorage.setItem('mbot-studio-profiles', JSON.stringify([{ id: 'guided', name: 'Alex' }]));
    localStorage.setItem('mbot-studio-current-profile', 'guided');
    localStorage.setItem('mbot-sound-muted', '1');
    window.globalStops = 0;
    window.addEventListener('mbot-global-stop', () => window.globalStops++);
    if (program) {
      localStorage.setItem('mbot-studio-projects:guided', JSON.stringify([{ id: 'p', name: 'Safety fixture', blocks: program, pythonCode: '# preview' }]));
      localStorage.setItem('mbot-studio-current-project:guided', 'p');
    }
  }, { standalone, program });
  await page.goto('http://guided-safety.test/');
  await page.addStyleTag({ content: stylesheet }); await page.addScriptTag({ content: script });
  await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });
  await expect(page.locator(standalone ? '.robot-config' : '.scratch-editor')).toBeVisible();
  if (program) await page.clock.runFor(300);
  return { requests, messages, errors, unexpected, sockets };
}

async function openWizard(page) {
  await page.locator('header.header').getByRole('button', { name: 'Robot', exact: true }).click();
  await page.getByRole('button', { name: '+ Add Hardware', exact: true }).click();
  await expect(page.locator('.hw-wizard')).toBeVisible();
  return page.locator('.hw-wizard');
}

async function expectHitTarget(locator) {
  await expect(locator).toBeInViewport({ ratio: 1 });
  expect(await locator.evaluate(element => {
    const r = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  })).toBe(true);
}
const stopRequests = fixture => fixture.requests.filter(r => r.path === '/api/robot/stop');
const commands = fixture => fixture.messages.filter(m => m.data.type === 'command').map(m => m.data.command);

test('Standalone RobotConfig Stop uses one server Stop and one cancellation event, not a native command', async ({ page }) => {
  const fixture = await mount(page, { standalone: true });
  await page.getByRole('button', { name: '+ Add Hardware', exact: true }).click();
  await page.getByRole('dialog', { name: 'Add Hardware' }).getByRole('button', { name: 'Emergency Stop', exact: true }).click();
  await expect.poll(() => stopRequests(fixture)).toEqual([{ method: 'POST', path: '/api/robot/stop', body: null }]);
  expect(await page.evaluate(() => window.globalStops)).toBe(1);
  expect(commands(fixture)).toEqual([]);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.hw-wizard')).toHaveCount(0);
  expect(fixture.unexpected).toEqual([]); expect(fixture.errors).toEqual([]);
});

test('Wizard Stop revokes real App Program completion credit and permits an intentional fresh Run', async ({ page }) => {
  const program = [{ type: 'move_forward', duration: 2, speed: 20, _id: 'move' }];
  const fixture = await mount(page, { program });
  await page.getByRole('button', { name: 'Run Program', exact: true }).click();
  await expect(page.getByTestId('program-lifecycle')).toContainText('Submitted');
  const observer = fixture.sockets.at(-1);
  const wizard = await openWizard(page);
  await wizard.getByRole('button', { name: 'Emergency Stop', exact: true }).click();
  await expect.poll(() => stopRequests(fixture).length).toBe(1);
  observer.send(JSON.stringify({ type: 'mqtt', topic: 'robot/execution', data: { event: 'completed', type: 'program', run_id: 'run-1' } }));
  await wizard.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator('header.header').getByRole('button', { name: 'Program', exact: true }).click();
  await expect(page.getByTestId('program-lifecycle')).toContainText('completion after Stop');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('mbot-studio-challenges:guided') || '{}'))).toEqual({});
  await page.getByRole('button', { name: 'Run Program', exact: true }).click();
  await expect(page.getByTestId('program-lifecycle')).toContainText('Submitted');
  fixture.sockets.at(-1).send(JSON.stringify({ type: 'mqtt', topic: 'robot/execution', data: { event: 'completed', type: 'program', run_id: 'run-2' } }));
  await expect(page.getByTestId('program-lifecycle')).toContainText('Completed');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('mbot-studio-challenges:guided') || '{}').ch_forward?.verification)).toBe('device-completed');
  expect(fixture.requests.filter(r => r.path === '/api/robot/program').map(r => JSON.parse(r.body).program)).toEqual([program, program]);
  expect(commands(fixture)).toEqual([]);
  expect(fixture.unexpected).toEqual([]); expect(fixture.errors).toEqual([]);
});

for (const source of ['wizard', 'shell event', 'close']) {
  test(`Hardware wizard cancels queued servo work on ${source} and permits a fresh explicit move`, async ({ page }) => {
    const fixture = await mount(page);
    let wizard = await openWizard(page);
    await wizard.getByRole('button', { name: 'S1', exact: true }).click();
    await wizard.getByRole('button', { name: 'Next', exact: true }).click();
    await wizard.getByRole('slider').fill('45');
    expect(commands(fixture)).toEqual([]);
    if (source === 'wizard') await wizard.getByRole('button', { name: 'Emergency Stop', exact: true }).click();
    else if (source === 'shell event') await page.evaluate(() => window.dispatchEvent(new CustomEvent('mbot-global-stop')));
    else await wizard.locator('.hw-wizard-close').click();
    await page.clock.runFor(200);
    expect(commands(fixture), 'A queued servo move must not restart motion after cancellation').toEqual([]);
    if (source === 'close') {
      await expect(wizard).toHaveCount(0);
      wizard = await openWizard(page);
      await wizard.getByRole('button', { name: 'S1', exact: true }).click();
      await wizard.getByRole('button', { name: 'Next', exact: true }).click();
    }
    await wizard.getByRole('slider').fill('60');
    await page.clock.runFor(101);
    await expect.poll(() => commands(fixture)).toEqual([{ type: 'servo', port: 'S1', angle: 60 }]);
    expect(stopRequests(fixture)).toHaveLength(source === 'wizard' ? 1 : 0);
    expect(fixture.unexpected).toEqual([]); expect(fixture.errors).toEqual([]);
  });
}

test('Wizard Stop abandons active calibration without saving a false duration; fresh calibration still works', async ({ page }) => {
  const fixture = await mount(page);
  const wizard = await openWizard(page);
  await wizard.getByRole('button', { name: 'M1', exact: true }).click();
  await wizard.getByRole('button', { name: 'Next', exact: true }).click();
  await wizard.getByRole('button', { name: /Gripper \/ Claw \/ Gate/ }).click();
  await wizard.getByRole('button', { name: 'Next', exact: true }).click();
  const forward = wizard.locator('.hw-cal-btn').first();
  await forward.dispatchEvent('touchstart');
  await expect.poll(() => commands(fixture)).toEqual([{ type: 'dc_motor', port: 'M1', speed: 70, duration: 0 }]);
  await page.clock.runFor(1000);
  // Keyboard activation does not incidentally end calibration by mouseleave.
  await wizard.getByRole('button', { name: 'Emergency Stop', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => stopRequests(fixture).length).toBe(1);
  await expect(forward).not.toHaveClass(/active/);
  await forward.dispatchEvent('touchend');
  await expect(wizard.locator('.hw-cal-time')).toHaveCount(0);
  expect(commands(fixture)).toHaveLength(1);
  await forward.dispatchEvent('touchstart');
  await page.clock.runFor(1000);
  await forward.dispatchEvent('touchend');
  await expect.poll(() => commands(fixture)).toEqual([
    { type: 'dc_motor', port: 'M1', speed: 70, duration: 0 },
    { type: 'dc_motor', port: 'M1', speed: 70, duration: 0 },
    { type: 'dc_motor', port: 'M1', speed: 0, duration: 0 },
  ]);
  await expect(wizard.locator('.hw-cal-time')).toHaveText('1.2s');
  expect(fixture.unexpected).toEqual([]); expect(fixture.errors).toEqual([]);
});

for (const width of [1440, 820, 390]) {
  test(`Hardware wizard exposes full Emergency Stop above its scrolled body at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 540 });
    const fixture = await mount(page);
    const wizard = await openWizard(page);
    // The existing full-screen modal covers the header's Stop, regardless of visibility.
    const obstruction = await page.getByTestId('global-stop').evaluate(element => {
      const r = element.getBoundingClientRect();
      return {
        headerZ: getComputedStyle(document.querySelector('header.header')).zIndex,
        overlayZ: getComputedStyle(document.querySelector('.hw-wizard-overlay')).zIndex,
        covered: !element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)),
      };
    });
    expect(obstruction.covered).toBe(true);
    expect(Number(obstruction.overlayZ)).toBeGreaterThan(Number(obstruction.headerZ));
    await testInfo.attach('header-stop-obstruction', { body: JSON.stringify(obstruction), contentType: 'application/json' });
    const stop = wizard.getByRole('button', { name: 'Emergency Stop', exact: true });
    await expectHitTarget(stop);
    await wizard.getByRole('button', { name: 'M1', exact: true }).click();
    await wizard.getByRole('button', { name: 'Next', exact: true }).click();
    await wizard.getByRole('button', { name: /Gripper \/ Claw \/ Gate/ }).click();
    await wizard.getByRole('button', { name: 'Next', exact: true }).click();
    const body = wizard.locator('.hw-wizard-body');
    await body.evaluate(element => { element.scrollTop = element.scrollHeight; });
    expect(await body.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    await expectHitTarget(stop);
    await page.screenshot({ path: testInfo.outputPath(`wizard-stop-${width}.png`) });
    await stop.click();
    await expect.poll(() => stopRequests(fixture)).toEqual([{ method: 'POST', path: '/api/robot/stop', body: null }]);
    expect(await page.evaluate(() => window.globalStops)).toBe(1);
    await page.clock.runFor(1000);
    expect(commands(fixture)).toEqual([]);
    expect(fixture.requests.filter(r => r.method === 'POST' && r.path.startsWith('/api/robot/'))).toEqual([
      { method: 'POST', path: '/api/robot/stop', body: null },
    ]);
    await expect(wizard).toBeVisible();
    await expect(wizard.getByRole('heading', { name: 'Calibrate the limits' })).toBeVisible();
    expect(fixture.unexpected).toEqual([]); expect(fixture.errors).toEqual([]);
  });
}
