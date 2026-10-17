import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
const liveCss = readFileSync(new URL('../web/src/components/LiveControl.css', import.meta.url), 'utf8');

let bundle;
const ready = { capabilities: ['drive_hold', 'drive_tap', 'motor_power_100'], armed: true, motion_enabled: true, boot: 'boot-a', robotOnline: true };
test.beforeAll(async () => {
  const result = await build({ stdin: {
    contents: `import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      import LiveControl from './web/src/components/LiveControl.jsx';
      const root = createRoot(document.getElementById('root'));
      window.stopCalls = 0;
      window.renderLive = (connected = true, mounted = true) => flushSync(() => root.render(mounted ?
        <React.StrictMode><LiveControl robotConfig={{}} robotConnected={connected}
        onStop={() => window.stopCalls++} /></React.StrictMode> : null));
      window.renderLive();`,
    resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'jsx',
  }, bundle: true, write: false, format: 'iife', loader: { '.css': 'empty' },
  define: { 'process.env.NODE_ENV': '"development"' } });
  bundle = result.outputFiles[0].text;
});

async function setup(page, status = ready, origin = 'http://127.0.0.1:15190/') {
  const sockets = [], errors = [], unexpected = [], requests = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
    if (pathname === '/api/robot/status') return route.fulfill({ json: status });
    if (pathname === '/api/robot/telemetry') return route.fulfill({ json: {} });
    requests.push(pathname);
    unexpected.push(pathname);
    return route.abort();
  });
  await page.routeWebSocket('**/*', socket => sockets.push(socket));
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  // Pause at a future instant before mounting; installation-to-pause latency
  // must not turn the same timestamp into a past time on a busy CI worker.
  await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
  await page.goto(origin);
  await page.evaluate(() => {
    window.sent = []; window.ack = true; window.callbacks = []; window.sockets = [];
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(...args) { super(...args); window.sockets.push(this); }
      send(data) {
        const msg = JSON.parse(data);
        window.sent.push({ ...msg, at: performance.now() });
        super.send(data);
        // Server submission ACK only; robot drive_status is separately injected.
        if (window.ack && ['drive_start', 'drive_renew', 'drive_tap'].includes(msg.type)) this.dispatchEvent(new MessageEvent('message', {
          data: JSON.stringify({ type: 'drive_ack', hold_id: msg.hold_id, op: msg.type.slice(6) }),
        }));
      }
    };
    const timeout = window.setTimeout, interval = window.setInterval;
    window.setTimeout = (fn, delay, ...args) => { window.callbacks.push(fn); return timeout(fn, delay, ...args); };
    window.setInterval = (fn, delay, ...args) => { window.callbacks.push(fn); return interval(fn, delay, ...args); };
    window.receive = msg => window.sockets.at(-1).dispatchEvent(new MessageEvent('message', { data: JSON.stringify(msg) }));
  });
  await page.addStyleTag({ content: liveCss });
  await page.addScriptTag({ content: bundle });
  await expect(page.getByRole('button', { name: 'Refresh sensors', exact: true })).toBeEnabled();
  await expect.poll(() => page.locator('.direction-pad').innerText()).toContain('Quick Controls');
  // Wait for bootstrap separately from socket readiness.
  await expect(page.locator('.direction-pad')).toContainText(status.capabilities?.includes('drive_hold') ? 'Hold' : 'Firmware update required');
  // Guided groups are collapsed by default. Open the controls this safety
  // fixture intentionally exercises, including the replay input used for blur.
  await page.getByText('Advanced port controls', { exact: true }).click();
  await page.getByText('Activity log & replay', { exact: true }).click();
  // The raw mouse-coordinate cases below deliberately do not auto-scroll.
  await page.locator('.dpad').scrollIntoViewIfNeeded();
  return {
    sockets, requests,
    messages: () => page.evaluate(() => window.sent),
    drive: () => page.evaluate(() => window.sent.filter(m => m.type.startsWith('drive_'))),
    receive: msg => page.evaluate(msg => window.receive(msg), msg),
    check: () => { expect(errors).toEqual([]); expect(unexpected).toEqual([]); },
  };
}
async function rawPress(page, direction = 'up', pointerId = 1) {
  await page.locator(`.dpad-${direction}`).dispatchEvent('pointerdown', { pointerId, pointerType: 'mouse', button: 0, isPrimary: true });
}
async function press(page, direction = 'up', pointerId = 1) {
  await rawPress(page, direction, pointerId);
  await page.clock.runFor(180);
}
async function release(page, direction = 'up', pointerId = 1, type = 'pointerup') {
  const target = page.locator(`.dpad-${direction}`);
  const box = await target.boundingBox();
  await target.dispatchEvent(type, { pointerId, pointerType: 'mouse', clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 });
}

test('tap transport exception releases busy ownership and permits a fresh tap', async ({ page }) => {
  const f = await setup(page);
  await rawPress(page);
  await page.evaluate(() => {
    const socket = window.sockets.at(-1);
    window.restoreSend = socket.send;
    socket.send = () => { throw new Error('tap transport failure'); };
  });
  await release(page);
  await expect(powerSlider(page)).toBeEnabled();
  await page.evaluate(() => { window.sockets.at(-1).send = window.restoreSend; });
  await page.clock.runFor(3000);
  expect(await f.drive()).toEqual([]);
  await rawPress(page, 'left');
  await release(page, 'left');
  expect((await f.drive())[0]).toMatchObject({ type: 'drive_tap', direction: 'left' });
  f.check();
});

test('older held firmware exposes only supported 0–50 power and no native tap', async ({ page }) => {
  const f = await setup(page, { ...ready, capabilities: ['drive_hold'] });
  await expect(powerSlider(page)).toHaveAttribute('max', '50');
  await expect(page.locator('#drive-help')).toContainText('Firmware update required for bounded-power taps');
  await rawPress(page);
  expect((await f.drive())[0]).toMatchObject({ type: 'drive_start', speed: 50 });
  await release(page);
  expect((await f.drive()).map(m => m.type)).toEqual(['drive_start', 'drive_stop']);
  f.check();
});

test('loss of full-power capability cancels a 100 percent hold and requires fresh input', async ({ page }) => {
  const f = await setup(page);
  await setPower(page, 100);
  await press(page);
  await f.receive({ type: 'mqtt', topic: 'robot/status', data: { ...ready, capabilities: ['drive_hold', 'drive_tap'] } });
  expect((await f.drive()).at(-1).type).toBe('drive_stop');
  await expect(powerSlider(page)).toHaveAttribute('max', '50');
  await page.clock.runFor(1000);
  expect(await f.drive()).toHaveLength(2);
  await press(page, 'down');
  expect((await f.drive()).at(-1)).toMatchObject({ type: 'drive_start', direction: 'backward', speed: 50 });
  await release(page, 'down');
  f.check();
});

for (const terminal of ['rejected', 'drive_error']) {
  test(`tap ${terminal} releases busy state for a new intentional tap`, async ({ page }) => {
    const f = await setup(page);
    await rawPress(page);
    await release(page);
    const id = (await f.drive())[0].hold_id;
    await f.receive(terminal === 'drive_error' ? { type: 'drive_error', hold_id: id, message: 'rejected' }
      : { type: 'mqtt', topic: 'robot/drive_status', data: { boot: ready.boot, hold_id: id, event: terminal } });
    await expect(powerSlider(page)).toBeEnabled();
    await rawPress(page, 'right');
    await release(page, 'right');
    expect((await f.drive()).at(-1)).toMatchObject({ type: 'drive_tap', direction: 'right' });
    f.check();
  });
}

const pendingReasons = ['pointercancel', 'lostpointercapture', 'blur', 'pagehide', 'hidden', 'button-blur', 'unmount', 'offline', 'socket-error', 'socket-close', 'boot', 'disarmed', 'motion-disabled', 'capability', 'power-capability', 'server-error', 'Stop'];
async function cancelAndRestore(page, f, reason) {
  if (['pointercancel', 'lostpointercapture'].includes(reason)) await release(page, 'up', 1, reason);
  if (['blur', 'pagehide'].includes(reason)) await page.evaluate(reason => window.dispatchEvent(new Event(reason)), reason);
  if (reason === 'hidden') await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  if (reason === 'button-blur') await page.locator('.mission-name-input').focus();
  if (reason === 'unmount') await page.evaluate(() => window.renderLive(true, false));
  if (reason === 'offline') await page.evaluate(() => window.renderLive(false));
  if (reason === 'socket-error') await page.evaluate(() => window.sockets.at(-1).dispatchEvent(new Event('error')));
  if (reason === 'socket-close') {
    f.sockets.at(-1).close();
    await expect(page.getByRole('button', { name: 'Refresh sensors', exact: true })).toBeDisabled();
  }
  const changed = { boot: { boot: 'boot-b' }, disarmed: { armed: false }, 'motion-disabled': { motion_enabled: false },
    capability: { capabilities: ['drive_hold', 'motor_power_100'] }, 'power-capability': { capabilities: ['drive_hold', 'drive_tap'] } };
  if (changed[reason]) await f.receive({ type: 'mqtt', topic: 'robot/status', data: { ...ready, ...changed[reason] } });
  if (reason === 'server-error') await f.receive({ type: 'error', message: 'test rejection' });
  if (reason === 'Stop') await page.locator('.live-controls-panel .btn-danger').dispatchEvent('click');
  return async () => {
    if (reason === 'hidden') await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    if (['unmount', 'offline'].includes(reason)) await page.evaluate(() => window.renderLive(true));
    if (reason === 'socket-error') await page.evaluate(() => window.sockets.at(-1).onopen());
    if (reason === 'socket-close') await page.clock.runFor(1000);
    await expect(page.getByRole('button', { name: 'Refresh sensors', exact: true })).toBeEnabled();
    await f.receive({ type: 'mqtt', topic: 'robot/status', data: ready });
    await expect(powerSlider(page)).toBeEnabled();
  };
}

for (const phase of ['pending', 'tap']) {
  for (const reason of pendingReasons.filter(r => phase === 'pending' || !['pointercancel', 'lostpointercapture', 'button-blur'].includes(r))) {
    test(`${reason} cancels ${phase} at 100 percent without later nudge; fresh press succeeds`, async ({ page }) => {
      const f = await setup(page);
      await setPower(page, 100);
      await page.evaluate(() => { window.callbacks = []; });
      await rawPress(page);
      if (phase === 'tap') await release(page);
      await page.evaluate(() => { window.oldCallbacks = [...window.callbacks]; });
      const restore = await cancelAndRestore(page, f, reason);
      if (phase === 'pending') expect(await f.drive()).toEqual([]);
      else if (reason !== 'socket-close') expect((await f.drive()).at(-1).type).toBe('drive_stop');
      const count = (await f.drive()).length;
      await page.clock.runFor(200);
      expect(await f.drive()).toHaveLength(count);
      await restore();
      // A delayed release and reconnect must not submit any pending intent.
      await release(page);
      expect(await f.drive()).toHaveLength(count);
      await rawPress(page, 'right');
      await page.evaluate(() => window.oldCallbacks.forEach(fn => fn()));
      expect(await f.drive()).toHaveLength(count);
      await page.clock.runFor(180);
      expect((await f.drive()).at(-1)).toMatchObject({ type: 'drive_start', direction: 'right' });
      await release(page, 'right');
      f.check();
    });
  }
}

for (const ms of [179, 180]) {
  test(`release at ${ms} ms chooses exactly one tap or hold`, async ({ page }) => {
    const f = await setup(page);
    await rawPress(page);
    await page.clock.runFor(ms);
    await release(page);
    expect((await f.drive()).map(m => m.type)).toEqual(ms === 179 ? ['drive_tap'] : ['drive_start', 'drive_stop']);
    f.check();
  });
}

for (const key of ['Space', 'Enter']) {
  test(`quick ${key} release sends only one tap and no synthetic duplicate`, async ({ page }) => {
    const f = await setup(page);
    await page.locator('.dpad-left').focus();
    await page.keyboard.down(key);
    await page.keyboard.down(key);
    expect(await f.drive()).toEqual([]);
    await page.keyboard.up(key);
    expect((await f.drive()).map(m => m.type)).toEqual(['drive_tap']);
    await page.clock.runFor(600);
    expect(await f.drive()).toHaveLength(1);
    f.check();
  });
}

test('short captured release outside is cancellation, not a nudge', async ({ page }) => {
  const f = await setup(page);
  const box = await page.locator('.dpad-up').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(2, 2);
  await page.mouse.up();
  await page.clock.runFor(1000);
  expect(await f.messages()).toEqual([]);
  await press(page);
  expect((await f.drive())[0].type).toBe('drive_start');
  await release(page);
  f.check();
});

test('tap stays exclusively busy through ACK and started; rapid taps never queue; terminal permits fresh input', async ({ page }) => {
  const f = await setup(page);
  await page.evaluate(() => { window.callbacks = []; });
  await rawPress(page);
  await release(page);
  const first = (await f.drive())[0];
  await page.evaluate(() => { window.oldCallbacks = [...window.callbacks]; });
  await f.receive({ type: 'mqtt', topic: 'robot/drive_status', data: { boot: ready.boot, hold_id: first.hold_id, event: 'started' } });
  // Blur due to deliberate input release must not truncate a tap.
  await page.locator('.mission-name-input').focus();
  for (let i = 0; i < 12; i++) { await rawPress(page, 'down'); await release(page, 'down'); }
  await page.locator('.hw-port-row').first().getByRole('button', { name: '45°', exact: true }).dispatchEvent('click');
  await page.clock.runFor(1000);
  expect(await f.messages()).toHaveLength(1);
  await expect(powerSlider(page)).toBeDisabled();
  await f.receive({ type: 'mqtt', topic: 'robot/drive_status', data: { boot: ready.boot, hold_id: first.hold_id, event: 'stopped' } });
  await expect(powerSlider(page)).toBeEnabled();
  await rawPress(page, 'right');
  await release(page, 'right');
  const second = (await f.drive()).at(-1);
  expect(second).toMatchObject({ type: 'drive_tap', direction: 'right' });
  expect(second.hold_id).not.toBe(first.hold_id);
  await f.receive({ type: 'drive_error', hold_id: first.hold_id, message: 'old failure' });
  await f.receive({ type: 'mqtt', topic: 'robot/drive_status', data: { boot: ready.boot, hold_id: first.hold_id, event: 'stopped' } });
  await page.evaluate(() => window.oldCallbacks.forEach(fn => fn()));
  expect(await f.drive()).toHaveLength(2);
  await expect(powerSlider(page)).toBeDisabled();
  await page.locator('.dpad-stop').click();
  expect((await f.drive()).at(-1)).toMatchObject({ type: 'drive_stop', hold_id: second.hold_id });
  expect((await f.messages()).at(-1).type).toBe('emergency_stop');
  f.check();
});

for (const ack of [true, false]) {
  test(`missing tap terminal cancels at 3000ms with ack=${ack}, never renews`, async ({ page }) => {
    const f = await setup(page);
    await page.evaluate(ack => { window.ack = ack; }, ack);
    await rawPress(page);
    await release(page);
    await page.clock.runFor(2999);
    expect((await f.drive()).map(m => m.type)).toEqual(['drive_tap']);
    await page.clock.runFor(1);
    expect((await f.drive()).map(m => m.type)).toEqual(['drive_tap', 'drive_stop']);
    await expect(powerSlider(page)).toBeEnabled();
    await page.clock.runFor(1000);
    expect(await f.drive()).toHaveLength(2);
    await press(page, 'down');
    expect((await f.drive()).at(-1).type).toBe('drive_start');
    await release(page, 'down');
    f.check();
  });
}

const powerSlider = page => page.getByRole('slider', { name: 'Motor power (%)', exact: true });
async function setPower(page, power) {
  await powerSlider(page).evaluate((el, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(value));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, power);
}

for (const power of [0, 50, 100]) {
  for (const [button, direction] of [['up','forward'],['down','backward'],['left','left'],['right','right']]) {
    for (const held of [false, true]) {
      test(`${held ? 'hold' : 'tap'} ${direction} snapshots selected ${power} percent power`, async ({ page }) => {
        const f = await setup(page);
        await expect(powerSlider(page)).toHaveValue('50');
        await expect(powerSlider(page)).toHaveAttribute('min', '0');
        await expect(powerSlider(page)).toHaveAttribute('max', '100');
        await setPower(page, power);
        await expect(powerSlider(page)).toHaveValue(String(power));
        const target = page.locator(`.dpad-${button}`);
        await target.focus();
        await page.keyboard.down('Space');
        await expect(powerSlider(page)).toBeDisabled();
        await setPower(page, power === 100 ? 0 : 100); // Cannot alter the captured command.
        if (held) await page.clock.runFor(180);
        else expect(await f.drive()).toEqual([]);
        await page.keyboard.up('Space');
        expect((await f.drive())[0]).toMatchObject({ type: held ? 'drive_start' : 'drive_tap', direction, speed: power });
        if (!held) {
          await expect(powerSlider(page)).toBeDisabled();
          await f.receive({ type: 'mqtt', topic: 'robot/drive_status', data: {
            boot: ready.boot, hold_id: (await f.drive())[0].hold_id, event: 'stopped',
          } });
        }
        await expect(powerSlider(page)).toBeEnabled();
        f.check();
      });
    }
  }
}

for (const [button, direction] of [['up','forward'],['down','backward'],['left','left'],['right','right']]) {
  test(`quick real click ${direction} sends one bounded native power tap only on release`, async ({ page }) => {
    const f = await setup(page);
    const target = page.locator(`.dpad-${button}`);
    const box = await target.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.clock.runFor(179);
    expect(await f.messages()).toEqual([]);
    await page.mouse.up();
    expect(await f.drive()).toHaveLength(1);
    expect((await f.drive())[0]).toMatchObject({ type: 'drive_tap', direction, speed: 50 });
    expect((await f.drive())[0].hold_id).toMatch(/^[0-9a-f-]{36}$/);
    await page.clock.runFor(600);
    expect(await f.drive()).toHaveLength(1); // No synthetic-click duplicate or renew.
    await f.receive({ type: 'mqtt', topic: 'robot/drive_status', data: {
      boot: ready.boot, hold_id: (await f.drive())[0].hold_id, event: 'stopped',
    } });
    f.check();
  });
}

for (const [button, direction] of [['up','forward'],['down','backward'],['left','left'],['right','right']]) {
  test(`held ${direction} uses default 50 percent power and stops on release`, async ({ page }) => {
    const f = await setup(page);
    await press(page, button);
    expect((await f.drive())[0]).toMatchObject({type:'drive_start',direction,speed:50});
    await page.clock.runFor(600);
    await release(page, button);
    expect((await f.drive()).at(-1).type).toBe('drive_stop');
    const count=(await f.drive()).length;
    await page.clock.runFor(1000);
    expect(await f.drive()).toHaveLength(count);
    f.check();
  });
}

for (const reason of ['pointercancel', 'lostpointercapture', 'blur', 'pagehide', 'hidden', 'button-blur', 'unmount', 'offline', 'socket-error', 'socket-close', 'boot', 'disarmed', 'motion-disabled', 'Stop']) {
  test(`${reason} cancels held movement without restarting`, async ({ page }) => {
    const f = await setup(page);
    await press(page);
    await page.clock.runFor(200);
    if (['pointercancel', 'lostpointercapture'].includes(reason)) await release(page, 'up', 1, reason);
    if (['blur', 'pagehide'].includes(reason)) await page.evaluate(reason => window.dispatchEvent(new Event(reason)), reason);
    if (reason === 'hidden') await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    if (reason === 'button-blur') await page.locator('.mission-name-input').focus();
    if (reason === 'unmount') await page.evaluate(() => window.renderLive(true, false));
    if (reason === 'offline') await page.evaluate(() => window.renderLive(false));
    if (reason === 'socket-error') await page.evaluate(() => window.sockets.at(-1).dispatchEvent(new Event('error')));
    if (reason === 'socket-close') {
      f.sockets.at(-1).close();
      await expect(page.getByRole('button', { name: 'Refresh sensors', exact: true })).toBeDisabled();
    }
    if (reason === 'boot') await f.receive({ type: 'mqtt', topic: 'robot/status', data: { ...ready, boot: 'boot-b' } });
    if (reason === 'disarmed') await f.receive({ type: 'mqtt', topic: 'robot/status', data: { ...ready, armed: false } });
    if (reason === 'motion-disabled') await f.receive({ type: 'mqtt', topic: 'robot/status', data: { ...ready, motion_enabled: false } });
    if (reason === 'Stop') await page.locator('.live-controls-panel .btn-danger').dispatchEvent('click');
    if (reason !== 'socket-close') expect((await f.drive()).at(-1).type).toBe('drive_stop');
    const count = (await f.drive()).length;
    await page.clock.runFor(1600);
    expect(await f.drive()).toHaveLength(count);
    if (reason === 'Stop') {
      expect((await f.messages()).filter(m => m.type === 'emergency_stop')).toHaveLength(1);
      expect(await page.evaluate(() => window.stopCalls)).toBe(1);
    }
    f.check();
  });
}

test('unsupported runtime retains explicit bounded tap fallback, never a hold or renew', async ({ page }) => {
  const f = await setup(page, { ...ready, capabilities: ['turn_left', 'turn_right'] });
  await expect(page.locator('#drive-help')).toContainText('Tap-only fallback');
  await page.locator('.dpad-left').dispatchEvent('mousedown');
  await page.clock.runFor(1200);
  await release(page, 'left');
  expect((await f.messages()).filter(m => m.type === 'command').map(m => m.command)).toEqual([{ type: 'turn_left', angle: 30 }]);
  expect(await f.drive()).toEqual([]);
  f.check();
});

for (const gate of [{ armed: false }, { motion_enabled: false }, { robotOnline: false }, { robotState: 'offline' }]) {
  test(`advertised runtime refuses movement when ${JSON.stringify(gate)}`, async ({ page }) => {
    const f = await setup(page, { ...ready, ...gate });
    await expect(page.locator('.dpad-up')).toBeDisabled();
    await press(page);
    await page.locator('.dpad-up').dispatchEvent('mousedown');
    expect(await f.drive()).toEqual([]);
    expect((await f.messages()).filter(m => m.type === 'command')).toEqual([]);
    f.check();
  });
}

test('reconnect never resumes; old socket handlers cannot stop a freshly pressed hold', async ({ page }) => {
  const f = await setup(page);
  await press(page);
  await page.evaluate(() => {
    const socket = window.sockets.at(-1);
    window.oldHandlers = [socket.onclose, socket.onerror, socket.onopen];
  });
  const previous = f.sockets.length;
  f.sockets.at(-1).close();
  await expect(page.locator('.dpad-up')).toHaveAttribute('aria-pressed', 'false');
  await page.clock.runFor(1000);
  await expect.poll(() => f.sockets.length).toBe(previous + 1);
  await expect(page.locator('#drive-help')).toContainText('Hold');
  expect((await f.drive()).filter(m => m.type === 'drive_start')).toHaveLength(1);
  await press(page, 'down');
  const id = (await f.drive()).at(-1).hold_id;
  await page.evaluate(() => window.oldHandlers.forEach(fn => fn()));
  await page.clock.runFor(400);
  expect((await f.drive()).at(-1)).toMatchObject({ type: 'drive_renew', hold_id: id });
  await release(page, 'down');
  f.check();
});

for (const op of ['start', 'renew']) {
  test(`transport exception during ${op} cancels safely and allows a later fresh press`, async ({ page }) => {
    const f = await setup(page);
    if (op === 'renew') await press(page);
    await page.evaluate(() => {
      const socket = window.sockets.at(-1);
      window.restoreSend = socket.send;
      socket.send = () => { throw new Error('transport failure'); };
    });
    if (op === 'start') await press(page);
    else await page.clock.runFor(200);
    await expect(page.locator('.dpad-up')).toHaveAttribute('aria-pressed', 'false');
    await page.evaluate(() => { window.sockets.at(-1).send = window.restoreSend; });
    const before = (await f.drive()).length;
    await page.clock.runFor(600);
    expect(await f.drive()).toHaveLength(before);
    await press(page, 'right');
    expect((await f.drive()).at(-1)).toMatchObject({ type: 'drive_start', direction: 'right' });
    await release(page, 'right');
    f.check();
  });
}

test('hold cancels pending direct work and blocks every command until release; new work then succeeds', async ({ page }) => {
  const f = await setup(page);
  const servo = page.locator('.hw-port-row').first().getByRole('button', { name: '45°', exact: true });
  await servo.dispatchEvent('click');
  await servo.dispatchEvent('click');
  await press(page);
  await servo.dispatchEvent('click');
  await page.locator('.live-input-row input').dispatchEvent('input');
  await page.clock.runFor(600);
  expect((await f.messages()).filter(m => m.type === 'command')).toHaveLength(1);
  await expect(servo).toBeDisabled();
  await expect(page.locator('.live-input-row input')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Refresh sensors', exact: true })).toBeDisabled();
  await release(page);
  await servo.dispatchEvent('click');
  await page.clock.runFor(600);
  expect((await f.messages()).filter(m => m.type === 'command')).toHaveLength(2);
  f.check();
});

test('starting a hold aborts AI generation and fences an already resolved stale response', async ({ page }) => {
  const f = await setup(page);
  await page.evaluate(() => {
    const fetch = window.fetch;
    window.aiAborted = false;
    window.fetch = (url, options) => {
      if (url !== '/api/ai/generate') return fetch(url, options);
      options.signal.addEventListener('abort', () => { window.aiAborted = true; });
      // Deliberately resolve even after abort to simulate already-arrived data.
      return new Promise(resolve => { window.resolveAi = () => resolve({ json: async () => ({ program: [{ type: 'move_forward', speed: 30, duration: 1 }] }) }); });
    };
  });
  await page.locator('.live-input-row input').fill('forward');
  await page.locator('.live-input-row .btn-primary').dispatchEvent('click');
  await expect.poll(() => page.evaluate(() => !!window.resolveAi)).toBe(true);
  await press(page);
  expect(await page.evaluate(() => window.aiAborted)).toBe(true);
  await page.evaluate(() => window.resolveAi());
  await page.clock.runFor(400);
  await release(page);
  await expect(page.locator('.live-input-row input')).toBeEnabled();
  expect(f.requests).toEqual([]);
  f.check();
});

for (const key of ['Space', 'Enter']) {
  test(`focused ${key} holds without repeat, ignores secondary key and pointer, and keyup stops`, async ({ page }) => {
    const f = await setup(page);
    await page.locator('.dpad-left').focus();
    await page.keyboard.down(key);
    await page.clock.runFor(180);
    await page.keyboard.down(key);
    await page.keyboard.down(key === 'Space' ? 'Enter' : 'Space');
    await page.keyboard.up(key === 'Space' ? 'Enter' : 'Space');
    // Real secondary pointer down must not move focus and cancel the keyboard owner.
    const box = await page.locator('.dpad-right').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    await page.clock.runFor(600);
    expect((await f.drive()).map(m => m.type)).toEqual(['drive_start', 'drive_renew', 'drive_renew', 'drive_renew']);
    expect((await f.drive())[0].direction).toBe('left');
    await expect(page.locator('.dpad-left')).toBeFocused();
    await page.keyboard.up(key);
    expect((await f.drive()).at(-1).type).toBe('drive_stop');
    const count = (await f.drive()).length;
    await page.clock.runFor(600);
    expect(await f.drive()).toHaveLength(count);
    await page.keyboard.down(key);
    await page.clock.runFor(180);
    expect((await f.drive()).at(-1).type).toBe('drive_start');
    await page.keyboard.up(key);
    f.check();
  });
}

test('secondary pointer releases do not cancel the owner; CSS disables touch gestures and exposes active state', async ({ page }) => {
  const f = await setup(page);
  await press(page, 'up', 7);
  await rawPress(page, 'down', 8);
  await release(page, 'down', 8);
  await page.clock.runFor(200);
  expect((await f.drive()).map(m => m.type)).toEqual(['drive_start', 'drive_renew']);
  await expect(page.locator('.dpad-up')).toHaveCSS('touch-action', 'none');
  await expect(page.locator('.dpad-up')).toHaveCSS('outline-style', 'solid');
  await expect(page.locator('.dpad-up')).toHaveAttribute('aria-pressed', 'true');
  await release(page, 'up', 7);
  await expect(page.locator('.dpad-up')).toHaveAttribute('aria-pressed', 'false');
  f.check();
});

test('arrows and typing in an input do not start movement', async ({ page }) => {
  const f = await setup(page);
  const input = page.locator('.live-input-row input');
  await input.fill('abc');
  await input.press('ArrowLeft');
  await input.press('Space');
  expect(await input.inputValue()).toBe('ab c');
  expect(await f.drive()).toEqual([]);
  f.check();
});

for (const missing of ['start', 'renew']) {
  test(`missing ${missing} submission acknowledgements cancel within the 500ms bound`, async ({ page }) => {
    const f = await setup(page);
    if (missing === 'start') await page.evaluate(() => { window.ack = false; });
    await press(page);
    const id = (await f.drive())[0].hold_id;
    await page.evaluate(() => { window.ack = false; });
    await page.clock.runFor(400);
    // Even renew ACKs must not mask a missing initial start ACK.
    if (missing === 'start') await f.receive({ type: 'drive_ack', hold_id: id, op: 'renew' });
    await page.clock.runFor(101);
    expect((await f.drive()).at(-1)).toMatchObject({ type: 'drive_stop', hold_id: id });
    expect((await f.drive()).at(-1).at - (await f.drive())[0].at).toBe(501);
    const count = (await f.drive()).length;
    await f.receive({ type: 'drive_ack', hold_id: id, op: 'start' });
    await page.clock.runFor(1000);
    expect(await f.drive()).toHaveLength(count);
    f.check();
  });
}

for (const event of ['stopped', 'rejected', 'drive_error']) {
  test(`current ${event} cancels but stale terminal replies and timer callbacks cannot affect a newer hold`, async ({ page }) => {
    const f = await setup(page);
    await page.evaluate(() => { window.callbacks = []; });
    await press(page);
    const oldId = (await f.drive())[0].hold_id;
    await page.evaluate(() => { window.oldCallbacks = [...window.callbacks]; });
    const reply = id => event === 'drive_error'
      ? { type: 'drive_error', hold_id: id, message: 'rejected by server' }
      : { type: 'mqtt', topic: 'robot/drive_status', data: { hold_id: id, boot: ready.boot, event, reason: 'test stop' } };
    await f.receive(reply(oldId));
    expect((await f.drive()).at(-1).type).toBe('drive_stop');
    await press(page, 'down');
    const currentId = (await f.drive()).at(-1).hold_id;
    await f.receive(reply(oldId));
    await page.evaluate(() => window.oldCallbacks.forEach(fn => fn()));
    await page.clock.runFor(400);
    await expect(page.locator('.dpad-down')).toHaveAttribute('aria-pressed', 'true');
    expect((await f.drive()).at(-1)).toMatchObject({ type: 'drive_renew', hold_id: currentId });
    await release(page, 'down');
    f.check();
  });
}

test('pointer capture stops a real mouse hold released outside the button', async ({ page }) => {
  const f = await setup(page);
  const button = page.locator('.dpad-up');
  await button.scrollIntoViewIfNeeded();
  const box = await button.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.clock.runFor(180);
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  expect(await button.evaluate(el => el.hasPointerCapture(1))).toBe(true);
  await page.mouse.move(2, 2);
  await page.mouse.up();
  expect((await f.drive()).map(m => m.type)).toEqual(['drive_start', 'drive_stop']);
  f.check();
});

test('active direction describes a request, not movement, before device confirmation', async ({ page }) => {
  const f = await setup(page);
  await page.evaluate(() => { window.ack = false; });
  await press(page);
  await expect(page.locator('#drive-help')).toContainText('Requesting forward.');
  await expect(page.locator('#drive-help')).not.toContainText('Driving forward.');
  const id = (await f.drive())[0].hold_id;
  await f.receive({ type: 'drive_ack', hold_id: id, op: 'start' });
  await expect(page.locator('#drive-help')).toContainText('Requesting forward.');
  await expect(page.locator('.live-log')).toContainText('submission only, not confirmed movement');
  await release(page);
  await expect(page.locator('#drive-help')).not.toContainText('Requesting forward.');
  f.check();
});

test('nonlocalhost HTTP uses secure random UUIDs for start, renew, release and a fresh hold', async ({ page }) => {
  const f = await setup(page, ready, 'http://mbot.test:15190/');
  expect(await page.evaluate(() => ({ secure: isSecureContext, uuid: typeof crypto.randomUUID,
    random: typeof crypto.getRandomValues }))).toEqual({ secure: false, uuid: 'undefined', random: 'function' });
  await page.evaluate(() => {
    const getRandomValues = crypto.getRandomValues.bind(crypto);
    window.randomCalls = 0;
    crypto.getRandomValues = bytes => { window.randomCalls++; return getRandomValues(bytes); };
  });
  const button = page.locator('.dpad-up');
  await button.scrollIntoViewIfNeeded();
  const box = await button.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.clock.runFor(180);
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await page.clock.runFor(400);
  await page.mouse.move(2, 2);
  await page.mouse.up();
  const messages = await f.drive();
  expect(messages.map(m => m.type)).toEqual(['drive_start', 'drive_renew', 'drive_renew', 'drive_stop']);
  const id = messages[0].hold_id;
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(messages.every(m => m.hold_id === id)).toBe(true);
  await press(page, 'right');
  const fresh = (await f.drive()).at(-1);
  expect(fresh.type).toBe('drive_start');
  expect(fresh.hold_id).not.toBe(id);
  expect(fresh.hold_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(await page.evaluate(() => window.randomCalls)).toBe(2);
  await release(page, 'right');
  await page.clock.runFor(1000);
  expect(await f.drive()).toHaveLength(6);
  f.check();
});

test('long hold renews every 200ms, release stops immediately, and a new hold gets a new id', async ({ page }) => {
  const f = await setup(page);
  await press(page);
  await expect(page.locator('.dpad-up')).toHaveAttribute('aria-pressed', 'true');
  await page.clock.runFor(2400);
  const messages = await f.drive();
  expect(messages[0]).toMatchObject({ type: 'drive_start', direction: 'forward', speed: 50 });
  expect(messages[0].hold_id).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
  expect(messages.slice(1).map(m => m.type)).toEqual(Array(12).fill('drive_renew'));
  expect(messages.slice(1).map((m, i) => m.at - messages[i].at)).toEqual(Array(12).fill(200));
  await release(page);
  expect((await f.drive()).at(-1)).toMatchObject({ type: 'drive_stop', hold_id: messages[0].hold_id, at: messages.at(-1).at });
  await page.clock.runFor(1000);
  expect(await f.drive()).toHaveLength(14);
  expect((await f.messages()).filter(m => m.type === 'command')).toEqual([]);
  await press(page, 'right');
  expect((await f.drive()).at(-1)).toMatchObject({ type: 'drive_start', direction: 'right' });
  expect((await f.drive()).at(-1).hold_id).not.toBe(messages[0].hold_id);
  await release(page, 'right');
  f.check();
});
