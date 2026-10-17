import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { EventEmitter, once } from 'node:events';
import { createHash } from 'node:crypto';
import express from 'express';
import { MqttService } from '../server/src/services/mqtt-service.js';
import { robotRoutes } from '../server/src/routes/robot.js';

// Real HTTP router, lowerer, admission and asset preparation; in-memory MQTT only.
async function recordingServer() {
  const audio = Buffer.alloc(600, 21);
  const id = createHash('sha256').update(audio).digest('hex');
  const metadata = { id, sha256: id, size: audio.length, duration_ms: 700 };
  const client = new EventEmitter(), packets = [], responses = [];
  client.connected = true;
  client.subscribe = () => {};
  const incoming = (topic, data) => client.emit('message', `mbot-studio/${topic}`, Buffer.from(JSON.stringify(data)));
  client.publish = (topic, raw, options, callback) => {
    const data = JSON.parse(raw); packets.push({ topic, data }); callback?.();
    if (topic.endsWith('/asset') && data.op !== 'abort') queueMicrotask(() => incoming('robot/asset_status', {
      transfer_id: data.transfer_id, boot: data.boot, id, op: data.op, ok: true,
      offset: data.op === 'chunk' ? data.offset + data.data.length / 2 : data.op === 'finish' ? audio.length : 0,
    }));
  };
  const mqtt = new MqttService({ mqttConnect: () => client,
    recordingRegistry: { get: key => key === id ? metadata : null, read: async () => audio } });
  // Do not persist test diagnostics into the shared checkout's data directory.
  const diagnostics = mqtt.diagnostics;
  mqtt.diagnostics = { persist: true, record: (...args) => diagnostics.record(...args), get lastKnown() { return diagnostics.lastKnown; } };
  const connecting = mqtt.connect(); client.emit('connect'); await connecting;
  incoming('robot/status', { ...ready, status: 'ready', application: 'cooperative-v1', device: 'robot1' });
  const previous = MqttService.instance; MqttService.instance = mqtt;
  const app = express(); app.use(express.json()); app.use('/api/robot', robotRoutes);
  app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message, code: error.code }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { id, mqtt, packets, responses, incoming,
    clip: { id, name: 'Workshop hello', durationMs: 700, bytes: audio.length, ready: true },
    handle: async route => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/robot/program`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: route.request().postData(),
      });
      const body = await response.json(); responses.push({ status: response.status, body });
      await route.fulfill({ status: response.status, json: body });
    },
    close: async () => {
      mqtt.recordingTransfer?.invalidate('test teardown'); clearInterval(mqtt.diagnosticTimer);
      MqttService.instance = previous;
      await new Promise(resolve => server.close(resolve));
    },
  };
}

const config = { name: 'Workshop rover', additions: [
  { port: 'S1', type: 'servo', label: 'Elbow', partOf: 'Arm', purpose: 'Lift', orientation: 'vertical', states: ['up'], homeState: 'up', actions: [{ name: 'lift', targetState: 'up', angle: 90 }] },
  { port: 'M1', type: 'dc_motor', label: 'Claw', partOf: 'Arm', purpose: 'Grip', states: ['open'], homeState: 'open', actions: [{ name: 'open', targetState: 'open', motorDirection: 'reverse', speed: 0, duration: 0 }] },
] };
const ready = { build: 'mbot-av-control-v1', boot: 'guided-test', armed: true, motion_enabled: true, robotOnline: true,
  capabilities: ['drive_hold', 'drive_tap', 'motor_power_100', 'display_text', 'play_tone', 'play_sound', 'set_volume', 'display_animation', 'stop_sound', 'recorded_audio_v1', 'play_recording'] };
let js, css;
test.beforeAll(async () => {
  const result = await build({ stdin: { contents: `import React from 'react';
    import { createRoot } from 'react-dom/client'; import { flushSync } from 'react-dom';
    import LiveControl from './web/src/components/LiveControl.jsx';
    import RobotConfig from './web/src/components/RobotConfig.jsx';
    import './web/src/index.css';
    import './web/src/App.css';
    import './web/src/GuidedTheme.css';
    document.getElementById('root').classList.add('guided-app');
    const root = createRoot(document.getElementById('root'));
    window.stops = 0;
    window.mount = (view = 'live', connected = true) => flushSync(() => root.render(view === 'none' ? null : view === 'robot' ?
      <RobotConfig config={${JSON.stringify(config)}} robotConnected onConfigUpdate={c => window.saved = c} /> :
      <LiveControl robotConfig={${JSON.stringify(config)}} robotConnected={connected} onStop={() => { window.stops++; window.dispatchEvent(new CustomEvent('mbot-global-stop')); }} />));
    window.mount();`, resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'jsx' },
    bundle: true, write: false, outdir: '/virtual', format: 'iife', logLevel: 'silent' });
  js = result.outputFiles.find(f => f.path.endsWith('.js')).text;
  css = result.outputFiles.find(f => f.path.endsWith('.css')).text;
});
async function mount(page, { width = 820, homeStatus = 200 } = {}) {
  const sent = [], requests = [], sockets = [], errors = [], unexpected = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width, height: 1000 });
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T00:00:00Z'));
  await page.route('**/*', route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div>' });
    requests.push({ path, method: req.method(), data: req.postDataJSON() });
    if (path === '/api/robot/status') return route.fulfill({ json: ready });
    if (path === '/api/robot/telemetry') return route.fulfill({ json: {} });
    if (path === '/api/robot/recordings') return route.fulfill({ json: { recordings: [] } });
    if (path === '/api/robot/hardware-state/home') return route.fulfill({ status: homeStatus, json: homeStatus === 200 ? { success: true } : { error: 'Home rejected' } });
    if (path === '/api/robot/test-action') return route.fulfill({ json: { sent: true } });
    if (path === '/api/config' && req.method() === 'POST') return route.fulfill({ json: { success: true, config: req.postDataJSON() } });
    unexpected.push(path); return route.abort();
  });
  await page.routeWebSocket('**/*', socket => {
    sockets.push(socket);
    socket.onMessage(data => {
      const msg = JSON.parse(data); sent.push(msg);
      if (['drive_start', 'drive_renew', 'drive_tap'].includes(msg.type)) socket.send(JSON.stringify({ type: 'drive_ack', hold_id: msg.hold_id, op: msg.type.slice(6) }));
    });
  });
  await page.goto('https://guided.test/');
  await page.addStyleTag({ content: css + '\nbody{overflow:auto}#root{height:auto;min-height:100vh;padding:16px}.live-control,.robot-config{height:auto}' });
  await page.addScriptTag({ content: js });
  await expect(page.locator('#drive-power')).toBeEnabled();
  return { sent, requests, sockets, check: () => { expect(errors).toEqual([]); expect(unexpected).toEqual([]); } };
}

for (const width of [390, 820, 1440]) {
  test(`Live keeps drive primary and every secondary control reachable at ${width}`, async ({ page }) => {
    const f = await mount(page, { width });
    await expect(page.getByRole('heading', { name: 'Drive', exact: true })).toBeVisible();
    await expect(page.locator('#drive-power')).toHaveAttribute('max', '100');
    await expect(page.locator('#drive-power')).toHaveValue('50');
    const elbow = page.getByRole('group', { name: 'Elbow · S1' });
    const claw = page.getByRole('group', { name: 'Claw · M1' });
    await expect(elbow).toBeVisible(); await expect(claw).toBeVisible();
    await elbow.getByRole('button', { name: '90°', exact: true }).click();
    await page.clock.runFor(120);
    await expect.poll(() => f.sent.filter(m => m.type === 'command').length).toBe(1);
    expect(f.sent.find(m => m.type === 'command').command).toEqual({ type: 'servo', port: 'S1', angle: 90 });
    await page.getByText('Advanced port controls', { exact: true }).click();
    await expect(page.locator('.advanced-ports .hw-port-row')).toHaveCount(8);
    await page.getByRole('button', { name: 'Show text', exact: true }).click();
    await page.clock.runFor(120);
    expect(f.sent.filter(m => m.type === 'command').at(-1).command).toEqual({ type: 'display_text', text: 'Hello!', size: 16 });
    await page.getByText('Voice recordings', { exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Voice clips', exact: true })).toBeVisible();
    await page.getByText('Activity log & replay', { exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
    const bad = await page.locator('.live-control button, .live-control input, .live-control select, .live-control textarea').evaluateAll(els => els.filter(el => {
      if (!el.checkVisibility()) return false;
      const r = el.getBoundingClientRect(); return r.width < 10 || r.left < 0 || r.right > innerWidth + 1;
    }).map(el => el.outerHTML));
    expect(bad).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/guided-live/live-${width}.png`, fullPage: true, animations: 'disabled' });
    f.check();
  });
}

for (const width of [390, 820, 1440]) {
  test(`Robot overview keeps advanced tools dormant and fields reachable at ${width}`, async ({ page }) => {
    const f = await mount(page, { width });
    await page.evaluate(() => window.mount('robot'));
    await expect(page.getByRole('heading', { name: 'Workshop rover', exact: true })).toBeVisible();
    await page.clock.runFor(1000);
    expect(f.sockets).toHaveLength(1); // Only the earlier Live socket, no mLink discovery.
    expect(f.requests.filter(r => r.path.includes('firmware') || r.path.includes('calibration'))).toEqual([]);
    await page.getByText('Elbow · S1 · Servo', { exact: true }).click();
    await page.getByText('Claw · M1 · DC Motor', { exact: true }).click();
    await expect(page.locator('.addition-card').last().locator('input[type=number]').first()).toHaveValue('0');
    await page.getByRole('button', { name: 'Save Robot Settings', exact: false }).click();
    await expect.poll(() => f.requests.filter(r => r.path === '/api/config').length).toBe(1);
    expect(f.requests.find(r => r.path === '/api/config').data.additions).toEqual(config.additions);
    const bad = await page.locator('.robot-config input, .robot-config select, .robot-config textarea, .robot-config button').evaluateAll(els => els.filter(el => {
      if (!el.checkVisibility()) return false;
      const r = el.getBoundingClientRect(); return r.width < 10 || r.left < 0 || r.right > innerWidth + 1;
    }).map(el => el.outerHTML));
    expect(bad).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/guided-live/robot-${width}.png`, fullPage: true, animations: 'disabled' });
    f.check();
  });
}

test('home HTTP rejection never reports a physical home; fresh submission is labeled unverified', async ({ page }) => {
  const f = await mount(page, { homeStatus: 503 });
  await page.evaluate(() => window.mount('robot'));
  await page.getByText('Elbow · S1 · Servo', { exact: true }).click();
  await page.getByRole('button', { name: 'Home Now', exact: false }).click();
  await expect(page.locator('.save-status')).toContainText('Could not home hardware');
  await expect(page.locator('.save-status')).not.toContainText('homed');
  await page.route('**/api/robot/hardware-state/home', route => route.fulfill({ json: { success: true } }));
  await page.getByRole('button', { name: 'Home Now', exact: false }).click();
  await expect(page.locator('.save-status')).toContainText('position unverified');
  expect(f.requests.find(r => r.path.endsWith('/home')).data).toEqual({ port: 'S1', homeState: 'up', homeAction: { type: 'servo', port: 'S1', angle: 90 } });
  f.check();
});

test('hardware tests report submission only and reject HTTP errors', async ({ page }) => {
  const f = await mount(page);
  await page.evaluate(() => window.mount('robot'));
  await page.getByText('Elbow · S1 · Servo', { exact: true }).click();
  await page.locator('.addition-card').first().getByTitle('Test this action on the robot now').click();
  await expect(page.locator('.addition-card').first().locator('.btn-test')).toContainText('Submitted');
  expect(f.requests.find(r => r.path.endsWith('/test-action')).data).toEqual({ port: 'S1', action: config.additions[0].actions[0], type: 'servo' });
  await page.clock.runFor(2000);
  await page.route('**/api/robot/test-action', route => route.fulfill({ status: 503, json: { sent: true } }));
  await page.locator('.addition-card').first().getByTitle('Test this action on the robot now').click();
  await expect(page.locator('.addition-card').first().locator('.btn-test')).toContainText('Not sent');
  f.check();
});

test('Live recordings use real Program admission and report ACK separately from device completion', async ({ page }) => {
  const server = await recordingServer();
  try {
    // This is the real blocker: a direct command is not an admissible playback route.
    expect(() => server.mqtt.sendCommand({ type: 'play_recording', recording: server.id })).toThrow(/Program preparation/);
    const f = await mount(page);
    const submissions = [];
    await page.route('**/api/robot/program', route => { submissions.push(route.request().postDataJSON()); return server.handle(route); });
    await page.route('**/api/robot/recordings', route => route.fulfill({ json: { recordings: [server.clip] } }));
    await page.getByText('Voice recordings', { exact: true }).click();
    await page.getByLabel('Saved clip', { exact: true }).selectOption(server.id);
    await page.getByRole('button', { name: 'Use clip', exact: true }).click();
    await expect.poll(() => submissions.length).toBe(1);
    expect(submissions[0]).toEqual({ program: [{ type: 'play_recording', recording: server.id }] });
    await expect.poll(() => server.responses.length).toBe(1);
    expect(server.responses[0]).toMatchObject({ status: 200, body: { sent: true } });
    const published = server.packets.filter(p => p.topic.endsWith('/program'));
    expect(published).toHaveLength(1);
    expect(published[0].data.program).toEqual([{ type: 'play_recording', recording: server.id, duration: 0.7 }]);
    expect(server.packets.findIndex(p => p.data.op === 'finish')).toBeLessThan(server.packets.indexOf(published[0]));
    expect(f.sent.filter(m => m.type === 'command')).toEqual([]);
    await page.getByText('Activity log & replay', { exact: true }).click();
    await expect(page.locator('.live-log')).toContainText('submission only');
    await expect(page.locator('.live-log')).not.toContainText('Program completed');
    const completed = { type: 'program', event: 'completed', run_id: server.responses[0].body.run_id };
    f.sockets.at(-1).send(JSON.stringify({ type: 'mqtt', topic: 'robot/execution', data: completed }));
    await expect(page.locator('.live-log')).toContainText(`Program completed [run_id=${completed.run_id}]`);
    f.sockets.at(-1).send(JSON.stringify({ type: 'mqtt', topic: 'robot/status', data: { ...ready, robotOnline: undefined, status: 'offline' } }));
    await expect(page.getByRole('button', { name: 'Use clip', exact: true })).toBeDisabled();
    f.sockets.at(-1).send(JSON.stringify({ type: 'mqtt', topic: 'robot/status', data: ready }));
    await expect(page.getByRole('button', { name: 'Use clip', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Use clip', exact: true }).click();
    await expect.poll(() => server.responses.length).toBe(2);
    expect(server.responses[1]).toMatchObject({ status: 200, body: { sent: true } });
    f.check();
  } finally { await server.close(); }
});

test('recording admission rejection never claims playback and a fresh valid clip can be submitted', async ({ page }) => {
  const server = await recordingServer();
  try {
    const f = await mount(page);
    await page.route('**/api/robot/program', server.handle);
    await page.route('**/api/robot/recordings', route => route.fulfill({ json: { recordings: [
      { ...server.clip, id: 'f'.repeat(64), name: 'Stale browser receipt' }, server.clip,
    ] } }));
    await page.getByText('Voice recordings', { exact: true }).click();
    await page.getByLabel('Saved clip', { exact: true }).selectOption('f'.repeat(64));
    await page.getByRole('button', { name: 'Use clip', exact: true }).click();
    await page.getByText('Activity log & replay', { exact: true }).click();
    await expect(page.locator('.live-log')).toContainText('Recording not sent:');
    await expect(page.locator('.live-log')).not.toContainText('Recording submitted');
    expect(server.responses[0].status).toBeGreaterThanOrEqual(400);
    expect(server.packets).toEqual([]);
    await page.getByLabel('Saved clip', { exact: true }).selectOption(server.id);
    await page.getByRole('button', { name: 'Use clip', exact: true }).click();
    await expect(page.locator('.live-log')).toContainText('Recording submitted');
    await expect(page.locator('.live-log')).not.toContainText('Program completed');
    expect(server.responses[1]).toMatchObject({ status: 200, body: { sent: true } });
    f.check();
  } finally { await server.close(); }
});

async function readyClips(page) {
  const clips = ['a', 'b'].map((letter, i) => ({ id: letter.repeat(64), name: `Clip ${i + 1}`, durationMs: 700, bytes: 600, ready: true }));
  await page.route('**/api/robot/recordings', route => route.fulfill({ json: { recordings: clips } }));
  await page.locator('.live-recordings').evaluate(el => { el.open = true; });
  await page.getByLabel('Saved clip', { exact: true }).selectOption(clips[0].id);
  await expect(page.getByRole('button', { name: 'Use clip', exact: true })).toBeEnabled();
  return clips;
}

for (const cancellation of ['Stop', 'unmount', 'robot disconnect', 'socket disconnect', 'boot change', 'broker offline', 'capability withdrawal', 'drive']) {
  test(`recording ${cancellation} aborts preparation and fences late bodies without harming a fresh request`, async ({ page }) => {
    const f = await mount(page);
    const clips = await readyClips(page), submissions = [];
    await page.locator('.live-log-panel').evaluate(el => { el.open = true; });
    await page.route('**/api/robot/program', route => {
      submissions.push(route.request().postDataJSON());
      return route.fulfill({ json: { sent: true, run_id: `recording-${submissions.length}` } });
    });
    // Delay an already-read body: aborting HTTP alone cannot hide stale continuations.
    await page.evaluate(() => {
      const fetch = window.fetch;
      window.recordingResponses = [];
      window.fetch = async (url, options) => {
        const response = await fetch(url, options);
        if (url !== '/api/robot/program') return response;
        const data = await response.json();
        let release;
        const held = new Promise(resolve => { release = () => resolve(data); });
        window.recordingResponses.push({ signal: options.signal, release });
        return { ok: response.ok, json: () => held };
      };
    });
    await page.getByRole('button', { name: 'Use clip', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.recordingResponses.length)).toBe(1);
    await page.getByLabel('Saved clip', { exact: true }).selectOption(clips[1].id);
    expect(submissions).toEqual([{ program: [{ type: 'play_recording', recording: clips[0].id }] }]);
    if (cancellation === 'Stop') await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('mbot-global-stop'));
      window.dispatchEvent(new CustomEvent('mbot-global-stop'));
    });
    else if (cancellation === 'unmount') await page.evaluate(() => window.mount('none'));
    else if (cancellation === 'robot disconnect') await page.evaluate(() => window.mount('live', false));
    else if (cancellation === 'socket disconnect') f.sockets.at(-1).close();
    else if (cancellation === 'drive') {
      await page.getByRole('button', { name: 'forward', exact: true }).dispatchEvent('pointerdown', { pointerId: 1, button: 0, isPrimary: true });
    } else {
      const changed = cancellation === 'boot change' ? { boot: 'replacement-boot' }
        : cancellation === 'broker offline' ? { mqttConnected: false } : { capabilities: ['drive_hold', 'drive_tap'] };
      f.sockets.at(-1).send(JSON.stringify({ type: 'mqtt', topic: 'robot/status', data: { ...ready, ...changed } }));
    }
    await expect.poll(() => page.evaluate(() => window.recordingResponses[0].signal.aborted)).toBe(true);
    if (cancellation === 'socket disconnect') await page.clock.runFor(1000);
    else if (['unmount', 'robot disconnect'].includes(cancellation)) await page.evaluate(() => window.mount());
    else if (cancellation === 'drive') await page.getByRole('button', { name: 'forward', exact: true }).dispatchEvent('pointercancel', { pointerId: 1 });
    else f.sockets.at(-1).send(JSON.stringify({ type: 'mqtt', topic: 'robot/status', data: ready }));
    await expect(page.locator('#drive-power')).toBeEnabled();
    await readyClips(page);
    await page.getByLabel('Saved clip', { exact: true }).selectOption(clips[1].id);
    await page.locator('.live-log-panel').evaluate(el => { el.open = true; });
    expect(submissions).toHaveLength(1); // No reconnect/recovery auto-play.
    await page.getByRole('button', { name: 'Use clip', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.recordingResponses.length)).toBe(2);
    await page.evaluate(() => window.recordingResponses[0].release());
    await expect(page.locator('.live-log')).not.toContainText('recording-1');
    // Old finally must not clear the new controller (duplicate selection stays inert).
    await page.getByRole('button', { name: 'Use clip', exact: true }).click();
    await page.clock.runFor(120);
    expect(submissions).toHaveLength(2);
    expect(submissions[1]).toEqual({ program: [{ type: 'play_recording', recording: clips[1].id }] });
    await page.evaluate(() => window.recordingResponses[1].release());
    await expect(page.locator('.live-log')).toContainText('Recording submitted [run_id=recording-2] — submission only');
    expect(f.sent.filter(m => m.type === 'command')).toEqual([]);
    f.check();
  });
}

for (const phase of ['pending', 'held', 'tap']) {
  test(`recording controls cannot submit during ${phase} drive and recover after Stop`, async ({ page }) => {
    const f = await mount(page), clips = await readyClips(page), submissions = [];
    await page.route('**/api/robot/program', route => {
      submissions.push(route.request().postDataJSON());
      return route.fulfill({ json: { sent: true, run_id: 'after-drive' } });
    });
    const forward = page.getByRole('button', { name: 'forward', exact: true });
    await forward.dispatchEvent('pointerdown', { pointerId: 1, button: 0, isPrimary: true });
    if (phase === 'held') await page.clock.runFor(180);
    if (phase === 'tap') {
      const box = await forward.boundingBox();
      await forward.dispatchEvent('pointerup', { pointerId: 1, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 });
    }
    await expect(page.getByRole('button', { name: 'Use clip', exact: true })).toBeDisabled();
    await expect(page.getByLabel('Saved clip', { exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Use clip', exact: true }).evaluate(el => el.click());
    expect(submissions).toEqual([]);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('mbot-global-stop')));
    await page.getByLabel('Saved clip', { exact: true }).selectOption(clips[0].id);
    await page.getByRole('button', { name: 'Use clip', exact: true }).click();
    await expect.poll(() => submissions.length).toBe(1);
    expect(submissions[0]).toEqual({ program: [{ type: 'play_recording', recording: clips[0].id }] });
    f.check();
  });
}

test('advanced recovery and calibration mount only after their explicit disclosure', async ({ page }) => {
  const f = await mount(page, { width: 390 });
  await page.route('**/api/config/firmware', route => route.fulfill({ json: { files: [] } }));
  await page.route('**/api/config/calibrations', route => route.fulfill({ json: { calibrations: {} } }));
  await page.evaluate(() => window.mount('robot'));
  await page.getByText('Advanced setup & calibration', { exact: true }).click();
  expect(f.sockets).toHaveLength(1);
  await expect(page.locator('.firmware-flasher')).toHaveCount(0);
  await page.getByText('Upload Robot Software (for parents/grown-ups)', { exact: true }).click();
  await expect(page.locator('.firmware-flasher')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'OTA recovery loader — commissioning', exact: true })).toBeVisible();
  // FirmwareFlasher opens one discovery socket and one serial-port listing socket.
  await expect.poll(() => f.sockets.length).toBe(3);
  await page.getByText('Teach Your Robot', { exact: true }).click();
  await expect(page.locator('.calibration-chat')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByText('Advanced setup & calibration', { exact: true }).click();
  await expect(page.locator('.firmware-flasher')).toHaveCount(0);
  await expect(page.locator('.calibration-chat')).toHaveCount(0);
  f.check();
});

test('shell Stop clears paced AV queue and stale AI work, then permits fresh commands', async ({ page }) => {
  const f = await mount(page);
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button')];
    buttons.find(b => b.textContent === 'Show text').click();
    buttons.find(b => b.textContent === 'Play tone').click();
    buttons.find(b => b.textContent === 'Play preset').click();
  });
  await expect.poll(() => f.sent.filter(m => m.type === 'command').length).toBe(1);
  let releaseAI, aiRequested = false;
  const submissions = [];
  await page.route('**/api/ai/generate', async route => {
    aiRequested = true;
    await new Promise(resolve => { releaseAI = resolve; });
    await route.fulfill({ json: { program: [{ type: 'display_text', text: 'old', size: 16 }] } }).catch(() => {});
  });
  await page.route('**/api/robot/program', route => { submissions.push(route.request().postDataJSON()); return route.fulfill({ json: { sent: true, run_id: 'fresh-test' } }); });
  await page.getByLabel('Live command', { exact: true }).fill('Display old');
  await page.getByRole('button', { name: /Go!/ }).click();
  await expect.poll(() => aiRequested).toBe(true);
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('mbot-global-stop'));
    window.dispatchEvent(new CustomEvent('mbot-global-stop'));
  });
  releaseAI();
  await page.clock.runFor(1000);
  expect(f.sent.filter(m => m.type === 'command')).toHaveLength(1);
  expect(submissions).toEqual([]);
  await expect(page.getByLabel('Live command', { exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Play tone', exact: true }).click();
  await expect.poll(() => f.sent.filter(m => m.type === 'command').length).toBe(2);
  expect(f.sent.filter(m => m.type === 'command').at(-1).command).toEqual({ type: 'play_tone', frequency: 440, duration: 0.5 });
  await page.route('**/api/ai/generate', route => route.fulfill({ json: { program: [{ type: 'display_text', text: 'fresh', size: 16 }] } }));
  await page.getByLabel('Live command', { exact: true }).fill('Display fresh');
  await page.getByRole('button', { name: /Go!/ }).click();
  await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0]).toEqual({ program: [{ type: 'display_text', text: 'fresh', size: 16 }] });
  f.check();
});

test('unmount cancels held drive and removes its shell Stop listener; remount needs a fresh press', async ({ page }) => {
  const f = await mount(page);
  await page.getByRole('button', { name: 'forward', exact: true }).focus();
  await page.keyboard.down('Space'); await page.clock.runFor(180);
  await expect.poll(() => f.sent.filter(m => m.type === 'drive_start').length).toBe(1);
  await page.evaluate(() => window.mount('none'));
  await expect.poll(() => f.sent.filter(m => m.type === 'drive_stop').length).toBe(1);
  await page.keyboard.up('Space');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('mbot-global-stop')));
  await page.clock.runFor(1000);
  expect(f.sent.filter(m => m.type === 'emergency_stop')).toHaveLength(0);
  await page.evaluate(() => window.mount());
  await expect(page.locator('#drive-power')).toBeEnabled();
  expect(f.sent.filter(m => m.type === 'drive_start')).toHaveLength(1);
  await page.getByRole('button', { name: 'left', exact: true }).focus();
  await page.keyboard.press('Space');
  await expect.poll(() => f.sent.filter(m => m.type === 'drive_tap').length).toBe(1);
  await page.locator('.live-controls-panel .btn-danger').click();
  await expect.poll(() => f.sent.filter(m => m.type === 'emergency_stop').length).toBe(1);
  expect(await page.evaluate(() => window.stops)).toBe(1);
  f.check();
});

test('shell Stop cancels held drive without recursively calling onStop, then accepts fresh input', async ({ page }) => {
  const f = await mount(page);
  await page.getByRole('button', { name: 'forward', exact: true }).dispatchEvent('pointerdown', { pointerId: 1, button: 0, isPrimary: true });
  await page.clock.runFor(180);
  await expect.poll(() => f.sent.filter(m => m.type === 'drive_start').length).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('mbot-global-stop')));
  await expect.poll(() => f.sent.filter(m => m.type === 'drive_stop').length).toBe(1);
  await page.clock.runFor(1000);
  expect(f.sent.filter(m => m.type === 'drive_renew')).toHaveLength(0);
  expect(await page.evaluate(() => window.stops)).toBe(0);
  await page.getByRole('button', { name: 'backward', exact: true }).focus();
  await page.keyboard.press('Space');
  await expect.poll(() => f.sent.filter(m => m.type === 'drive_tap').length).toBe(1);
  expect(f.sent.at(-1)).toMatchObject({ type: 'drive_tap', direction: 'backward', speed: 50 });
  f.check();
});
