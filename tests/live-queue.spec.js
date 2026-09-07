import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Bundle the real component into an entirely intercepted page: no app server,
// MQTT broker, AI service, or robot connection is involved in these tests.
let bundle;
test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { flushSync } from 'react-dom';
        import LiveControl from './web/src/components/LiveControl.jsx';
        const root = createRoot(document.getElementById('root'));
        window.renderLive = (connected = true, mounted = true) => flushSync(() =>
          root.render(mounted ? <React.StrictMode><LiveControl
            robotConnected={connected} robotConfig={{}} currentProfileId="queue-fixture"
            onStop={() => window.stopCalls++}
          /></React.StrictMode> : null));
        window.stopCalls = 0;
        window.renderLive();
      `,
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
      loader: 'jsx',
    },
    bundle: true, write: false, format: 'iife', loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"development"' },
  });
  bundle = result.outputFiles[0].text;
});

async function setup(page) {
  const sockets = [], errors = [], unexpected = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/queue-fixture') {
      return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
    }
    if (url.pathname === '/api/robot/telemetry') return route.fulfill({ json: {} });
    unexpected.push(url.href);
    return route.abort();
  });
  await page.routeWebSocket('**/*', socket => { sockets.push(socket); });
  await page.goto('http://127.0.0.1:15190/queue-fixture');
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T00:00:00Z'));
  await page.evaluate(() => {
    window.sent = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function(data) {
      window.sent.push({ data: JSON.parse(data), at: Date.now() });
      return send.call(this, data);
    };
    // Observe only queue pacing timers, preserving the real timer semantics.
    // Retain callbacks to exercise a canceled callback already ready to run.
    const schedule = window.setTimeout, cancel = window.clearTimeout;
    window.queueTimers = new Map();
    window.queueCallbacks = [];
    window.queueTimerFirings = 0;
    window.setTimeout = (callback, delay, ...args) => {
      if (delay !== 120) return schedule(callback, delay, ...args);
      const id = schedule(() => {
        window.queueTimers.delete(id);
        window.queueTimerFirings++;
        callback(...args);
      }, delay);
      window.queueTimers.set(id, callback);
      window.queueCallbacks.push(callback);
      return id;
    };
    window.clearTimeout = id => {
      window.queueTimers.delete(id);
      cancel(id);
    };
  });
  await page.addScriptTag({ content: bundle });
  await expect(page.getByRole('button', { name: 'Refresh sensors', exact: true })).toBeEnabled();
  return {
    sockets,
    commands: () => page.evaluate(() => window.sent.filter(entry => entry.data.type === 'command').map(entry => entry.data.command.type)),
    timers: () => page.evaluate(() => window.queueTimers.size),
    checkErrors: () => { expect(errors).toEqual([]); expect(unexpected).toEqual([]); },
  };
}

async function enqueue(page, ...directions) {
  for (const direction of directions) {
    await page.locator(`.dpad-${direction}`).dispatchEvent('mousedown');
  }
}

async function stop(page) {
  await page.locator('.live-controls-panel .btn-danger').dispatchEvent('click');
}

test('repeated Stop leaves no delayed command or timer and still permits a fresh command', async ({ page }) => {
  const fixture = await setup(page);
  await enqueue(page, 'up', 'left', 'right');
  await stop(page);
  await stop(page);
  expect(await fixture.timers()).toBe(0);
  await page.clock.runFor(600);
  expect(await fixture.commands()).toEqual(['move_forward']);
  expect(await page.evaluate(() => window.queueTimerFirings)).toBe(0);
  await enqueue(page, 'down');
  expect(await fixture.commands()).toEqual(['move_forward', 'move_backward']);
  await page.clock.runFor(240);
  expect(await fixture.timers()).toBe(0);
  fixture.checkErrors();
});

test('the normal drain preserves the newest-40 bound, FIFO order, and 120ms spacing', async ({ page }) => {
  const fixture = await setup(page);
  await enqueue(page, 'up', 'left', 'left', ...Array(39).fill('right'), 'down');
  expect(await fixture.commands()).toEqual(['move_forward']);
  await page.clock.runFor(120 * 41);
  expect(await fixture.commands()).toEqual(['move_forward', ...Array(39).fill('turn_right'), 'move_backward']);
  const timestamps = await page.evaluate(() => window.sent.filter(entry => entry.data.type === 'command').map(entry => entry.at));
  expect(timestamps.slice(1).map((time, index) => time - timestamps[index])).toEqual(Array(40).fill(120));
  expect(await fixture.timers()).toBe(0);
  await enqueue(page, 'left');
  expect((await fixture.commands()).at(-1)).toBe('turn_left');
  await page.clock.runFor(240);
  expect(await fixture.timers()).toBe(0);
  fixture.checkErrors();
});

test('unmount cancels pending timers and remount accepts a fresh queue', async ({ page }) => {
  const fixture = await setup(page);
  await enqueue(page, 'up', 'left', 'right');
  await page.evaluate(() => window.renderLive(true, false));
  expect(await fixture.timers()).toBe(0);
  await page.clock.runFor(480);
  expect(await fixture.commands()).toEqual(['move_forward']);
  expect(await page.evaluate(() => window.queueTimerFirings)).toBe(0);
  await page.evaluate(() => window.renderLive());
  await expect(page.getByRole('button', { name: 'Refresh sensors', exact: true })).toBeEnabled();
  // A ready callback from the removed instance must stay inert, too.
  await page.evaluate(() => window.queueCallbacks[0]());
  await enqueue(page, 'down', 'right');
  await page.clock.runFor(120);
  expect(await fixture.commands()).toEqual(['move_forward', 'move_backward', 'turn_right']);
  await page.clock.runFor(240);
  expect(await fixture.timers()).toBe(0);
  fixture.checkErrors();
});

test('robot disconnect drops pending commands and reconnect starts fresh', async ({ page }) => {
  const fixture = await setup(page);
  await enqueue(page, 'up', 'left', 'right');
  await page.evaluate(() => window.renderLive(false));
  await page.clock.runFor(120);
  expect(await fixture.commands()).toEqual(['move_forward']);
  expect(await fixture.timers()).toBe(0);
  await enqueue(page, 'down');
  await page.clock.runFor(240);
  expect(await fixture.commands()).toEqual(['move_forward']);
  await page.evaluate(() => window.renderLive(true));
  await enqueue(page, 'down', 'right');
  await page.evaluate(() => window.queueCallbacks[0]());
  expect(await fixture.commands()).toEqual(['move_forward', 'move_backward']);
  await page.clock.runFor(120);
  expect(await fixture.commands()).toEqual(['move_forward', 'move_backward', 'turn_right']);
  await page.clock.runFor(240);
  expect(await fixture.timers()).toBe(0);
  fixture.checkErrors();
});

test('WebSocket disconnect cancels the queue instead of replaying it on reconnect', async ({ page }) => {
  const fixture = await setup(page);
  await enqueue(page, 'up', ...Array(12).fill('left'));
  const previousSockets = fixture.sockets.length;
  fixture.sockets.at(-1).close();
  await expect(page.getByRole('button', { name: 'Refresh sensors', exact: true })).toBeDisabled();
  expect(await fixture.timers()).toBe(0);
  // A robot status can lag behind socket loss; do not retain clicks meanwhile.
  await enqueue(page, 'right', 'right');
  await page.clock.runFor(1000);
  await expect.poll(() => fixture.sockets.length).toBe(previousSockets + 1);
  await expect(page.getByRole('button', { name: 'Refresh sensors', exact: true })).toBeEnabled();
  await page.clock.runFor(480);
  expect(await fixture.commands()).toEqual(['move_forward']);
  await enqueue(page, 'down', 'right');
  await page.evaluate(() => window.queueCallbacks[0]());
  expect(await fixture.commands()).toEqual(['move_forward', 'move_backward']);
  await page.clock.runFor(120);
  expect(await fixture.commands()).toEqual(['move_forward', 'move_backward', 'turn_right']);
  await page.clock.runFor(240);
  expect(await fixture.timers()).toBe(0);
  fixture.checkErrors();
});

test('an already-ready old callback cannot consume or unlock a new queue', async ({ page }) => {
  const fixture = await setup(page);
  await enqueue(page, 'up', 'left');
  await stop(page);
  await enqueue(page, 'down', 'right');
  await page.evaluate(() => window.queueCallbacks[0]());
  expect(await fixture.commands()).toEqual(['move_forward', 'move_backward']);
  expect(await fixture.timers()).toBe(1);
  await page.clock.runFor(120);
  expect(await fixture.commands()).toEqual(['move_forward', 'move_backward', 'turn_right']);
  // Old empty drains must not reset the new generation's running flag either.
  await page.evaluate(() => window.queueCallbacks[0]());
  await enqueue(page, 'left');
  expect(await fixture.commands()).toEqual(['move_forward', 'move_backward', 'turn_right']);
  await page.clock.runFor(120);
  expect(await fixture.commands()).toEqual(['move_forward', 'move_backward', 'turn_right', 'turn_left']);
  await page.clock.runFor(240);
  expect(await fixture.timers()).toBe(0);
  fixture.checkErrors();
});

test('Stop cancels the old drain before a new queue starts', async ({ page }) => {
  const fixture = await setup(page);
  await enqueue(page, 'up', 'left');
  expect(await fixture.commands()).toEqual(['move_forward']);
  await page.clock.runFor(60);
  await stop(page);
  await enqueue(page, 'down', 'right', 'left');
  expect(await fixture.commands()).toEqual(['move_forward', 'move_backward']);
  // The old timer would fire here, only 60ms into the new queue's 120ms gap.
  await page.clock.runFor(60);
  expect(await fixture.commands()).toEqual(['move_forward', 'move_backward']);
  await page.clock.runFor(60);
  expect(await fixture.commands()).toEqual(['move_forward', 'move_backward', 'turn_right']);
  await page.clock.runFor(120);
  expect(await fixture.commands()).toEqual(['move_forward', 'move_backward', 'turn_right', 'turn_left']);
  await page.clock.runFor(240);
  expect(await fixture.timers()).toBe(0);
  expect(await page.evaluate(() => window.sent.filter(e => e.data.type === 'emergency_stop').length)).toBe(1);
  expect(await page.evaluate(() => window.stopCalls)).toBe(1);
  fixture.checkErrors();
});
