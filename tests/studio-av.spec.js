import { test, expect } from '@playwright/test';

const capabilities = ['display_text', 'play_tone', 'play_sound', 'set_volume', 'display_animation', 'stop_sound'];
const status = { robotOnline: true, mqttConnected: true, state: 'ready', build: 'mbot-av-control-v1', capabilities };

// Real Studio React tree. Every API and socket is intercepted, never a robot.
async function setup(page, initial = status, beforeLive = async () => {}) {
  const sockets = [], messages = [], errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.routeWebSocket('**/ws', ws => {
    sockets.push(ws);
    ws.onMessage(message => messages.push(JSON.parse(message)));
  });
  await page.route('**/api/**', route => {
    requests.push({ url: route.request().url(), method: route.request().method() });
    return route.fulfill({ json: {} });
  });
  await page.route('**/api/robot/status', typeof initial === 'function' ? initial : route => route.fulfill({ json: initial }));
  await page.addInitScript(() => localStorage.setItem('mbot-studio-current-profile', 'profile_default'));
  await page.goto('/');
  await expect(page.locator('.header-status .status-text')).toHaveText(initial.robotOnline ? 'Robot Online' : 'Waiting for Robot');
  await beforeLive();
  await page.getByRole('button', { name: 'Live Control' }).click();
  await expect(page.locator('.live-log')).toContainText('Connected to server');
  const panel = page.locator('#mbot-av-control-v1');
  return { panel, sockets, messages, errors, requests,
    emit: data => sockets.at(-1).send(JSON.stringify({ type: 'mqtt', topic: 'robot/status', data })),
  };
}

test('initial capabilities enable explicit display without autoplay or fake completion', async ({ page }) => {
  const f = await setup(page);
  await expect(f.panel).toBeVisible();
  await expect(f.panel.getByRole('heading', { name: 'Sound & Screen' })).toBeVisible();
  await expect(f.panel.getByRole('button', { name: 'Show text', exact: true })).toBeEnabled();
  await f.panel.getByLabel('Screen text', { exact: true }).fill('Hello Studio');
  await f.panel.getByLabel('Text size').fill('24');
  await page.waitForTimeout(200);
  expect(f.messages).toEqual([]);
  await f.panel.getByRole('button', { name: 'Show text', exact: true }).click();
  await expect.poll(() => f.messages).toEqual([{ type: 'command', command: { type: 'display_text', text: 'Hello Studio', size: 24 } }]);
  await expect(page.locator('.live-log')).not.toContainText('completed');
  f.sockets.at(-1).send(JSON.stringify({ type: 'ack', command: 'display_text', run_id: 'av-test' }));
  await expect(page.locator('.live-log')).toContainText('submission only; see device execution events');
  f.sockets.at(-1).send(JSON.stringify({ type: 'mqtt', topic: 'robot/execution', data: { type: 'display_text', event: 'failed', run_id: 'av-test', details: 'fixture failure' } }));
  await expect(page.locator('.live-log')).toContainText('Block display_text failed [run_id=av-test]: fixture failure');
  expect(f.requests.filter(r => r.method !== 'GET')).toEqual([]);
  expect(f.errors).toEqual([]);
});

test('sound, volume and text-frame controls send one bounded command per click; edits never play', async ({ page }) => {
  const f = await setup(page);
  await f.panel.getByLabel('Frequency').fill('880');
  await f.panel.getByLabel('Tone duration').fill('0.2');
  await f.panel.getByLabel('Volume', { exact: false }).fill('35');
  await f.panel.getByLabel('Animation frames').fill('Ready\nSet\nGo');
  await f.panel.getByLabel('Frame interval').fill('0.5');
  await page.waitForTimeout(200);
  expect(f.messages).toEqual([]);
  const expected = [];
  const click = async (label, command) => {
    await f.panel.getByRole('button', { name: label, exact: true }).click();
    expected.push({ type: 'command', command });
    await expect.poll(() => f.messages).toEqual(expected);
  };
  await click('Play tone', { type: 'play_tone', frequency: 880, duration: 0.2 });
  await click('Set volume', { type: 'set_volume', volume: 35 });
  for (const sound of ['hello', 'beeps', 'laugh', 'score']) {
    await f.panel.getByLabel('Sound preset').selectOption(sound);
    await click('Play preset', { type: 'play_sound', sound });
  }
  await click('Play text frames', { type: 'display_animation', frames: ['Ready', 'Set', 'Go'], interval: 0.5 });
  await f.panel.getByLabel('Tone duration').fill('0');
  await click('Play tone', { type: 'play_tone', frequency: 880, duration: 0 });
  expect(f.errors).toEqual([]);
});

for (const initial of [
  { ...status, build: 'mbot-motor-control-v1' },
  { ...status, capabilities: [] },
  { ...status, capabilities: undefined },
  { ...status, robotOnline: false },
]) {
  test(`unsupported/offline status disables all AV actions: ${JSON.stringify(initial)}`, async ({ page }) => {
    const f = await setup(page, initial);
    for (const button of await f.panel.getByRole('button').all()) await expect(button).toBeDisabled();
    expect(f.messages).toEqual([]);
  });
}

test('actual robot/status WS changes capability availability and offline disables immediately', async ({ page }) => {
  const f = await setup(page);
  f.emit({ ...status, capabilities: ['display_text'] });
  await expect(f.panel.getByRole('button', { name: 'Show text' })).toBeEnabled();
  await expect(f.panel.getByRole('button', { name: 'Play tone' })).toBeDisabled();
  f.emit({ ...status, build: 'unknown-candidate' });
  await expect(f.panel.getByRole('button', { name: 'Show text' })).toBeDisabled();
  f.emit(status);
  await expect(f.panel.getByRole('button', { name: 'Play tone' })).toBeEnabled();
  f.emit({ status: 'offline' });
  for (const button of await f.panel.getByRole('button').all()) await expect(button).toBeDisabled();
  expect(f.messages).toEqual([]);
});

test('socket disconnect disables AV, reconnect fetches new capabilities without autoplay', async ({ page }) => {
  const f = await setup(page);
  await expect(f.panel.getByRole('button', { name: 'Play tone' })).toBeEnabled();
  f.sockets.at(-1).close();
  await expect(f.panel.getByRole('button', { name: 'Play tone' })).toBeDisabled();
  await expect.poll(() => f.sockets.length).toBe(2);
  await expect(f.panel.getByRole('button', { name: 'Play tone' })).toBeEnabled();
  expect(f.messages).toEqual([]);
});

test('late initial HTTP status cannot overwrite a newer WS capability update', async ({ page }) => {
  let release;
  const f = await setup(page, status, async () => {
    await page.route('**/api/robot/status', async route => {
      await new Promise(resolve => { release = resolve; });
      await route.fulfill({ json: status });
    });
  });

  await expect.poll(() => Boolean(release)).toBe(true);
  f.emit({ ...status, capabilities: [] });
  await expect(f.panel.getByRole('button', { name: 'Show text' })).toBeDisabled();
  release();
  await page.waitForTimeout(200);
  await expect(f.panel.getByRole('button', { name: 'Show text' })).toBeDisabled();
  expect(f.messages).toEqual([]);
});

test('invalid numeric values and animation bounds are blocked; exact limits are accepted', async ({ page }) => {
  const f = await setup(page);
  for (const [label, action, invalid, valid] of [
    ['Text size', 'Show text', ['', '7', '33'], ['8', '32']],
    ['Frequency', 'Play tone', ['', '99', '2001'], ['100', '2000']],
    ['Tone duration', 'Play tone', ['', '-0.1', '2.1'], ['0', '2']],
    ['Volume', 'Set volume', ['', '-1', '61', '30.5'], ['0', '60']],
    ['Frame interval', 'Play text frames', ['', '0.14', '2.01'], ['0.15', '2']],
  ]) {
    for (const value of invalid) {
      await f.panel.getByLabel(label).fill(value);
      await expect(f.panel.getByRole('button', { name: action, exact: true })).toBeDisabled();
    }
    for (const value of valid) {
      await f.panel.getByLabel(label).fill(value);
      await expect(f.panel.getByRole('button', { name: action, exact: true })).toBeEnabled();
    }
  }
  const text = f.panel.getByLabel('Screen text', { exact: true });
  await text.fill('x'.repeat(129));
  await expect(text).toHaveValue('x'.repeat(128));
  const frames = f.panel.getByLabel('Animation frames');
  const play = f.panel.getByRole('button', { name: 'Play text frames', exact: true });
  for (const value of ['', 'x'.repeat(129), Array(13).fill('x').join('\n'), Array(7).fill('x').join('\n')]) {
    await frames.fill(value);
    await expect(play).toBeDisabled();
  }
  await frames.fill(Array(6).fill('x').join('\n'));
  await expect(play).toBeEnabled(); // 6 * 2 = 12 seconds
  await frames.fill(Array(12).fill('x'.repeat(128)).join('\n'));
  await f.panel.getByLabel('Frame interval').fill('1');
  await expect(play).toBeEnabled(); // 12 frames, 128 chars each, 12 seconds
  await f.panel.getByLabel('Frame interval').fill('1.01');
  await expect(play).toBeDisabled();
  expect(f.messages).toEqual([]);
});

test('Stop output bypasses and clears the direct queue, using the full emergency stop', async ({ page }) => {
  const clockStart = new Date('2026-01-01T00:00:00Z');
  await page.clock.install({ time: clockStart });
  await page.clock.pauseAt(clockStart);
  const f = await setup(page);
  await expect(f.panel.getByRole('button', { name: 'Stop output' })).toBeEnabled();
  // One synchronous UI burst leaves commands pending behind the animation.
  await f.panel.evaluate(panel => {
    const click = name => [...panel.querySelectorAll('button')].find(b => b.textContent === name).click();
    click('Play text frames');
    click('Play tone');
    click('Play preset');
    click('Stop output');
  });
  await expect.poll(() => f.messages.map(m => m.type)).toEqual(['command', 'emergency_stop']);
  expect(f.messages[0].command.type).toBe('display_animation');
  await expect.poll(() => f.requests.some(r => r.method === 'POST' && r.url.endsWith('/api/robot/stop'))).toBe(true);
  await page.clock.runFor(1000);
  expect(f.messages).toHaveLength(2);
  await f.panel.getByRole('button', { name: 'Play tone' }).click();
  await expect.poll(() => f.messages.length).toBe(3);
  expect(f.messages[2]).toEqual({ type: 'command', command: { type: 'play_tone', frequency: 440, duration: 0.5 } });
});

test('unknown HTTP status stays disabled until a complete live capability status arrives', async ({ page }) => {
  const f = await setup(page, status, async () => {
    await page.route('**/api/robot/status', route => route.fulfill({ status: 503, json: { error: 'offline' } }));
  });
  await expect(f.panel.getByRole('button', { name: 'Play tone' })).toBeDisabled();
  f.emit(status);
  await expect(f.panel.getByRole('button', { name: 'Play tone' })).toBeEnabled();
  await f.panel.getByLabel('Screen text', { exact: true }).press('Enter');
  expect(f.messages).toEqual([]);
});

test('Sound & Screen fits the existing hardware column and has accessible labels', async ({ page }, testInfo) => {
  const f = await setup(page);
  await f.panel.getByRole('button', { name: 'Stop output' }).scrollIntoViewIfNeeded();
  await expect(f.panel.getByRole('button', { name: 'Stop output' })).toBeInViewport();
  expect(await f.panel.evaluate(panel => panel.scrollWidth <= panel.clientWidth)).toBe(true);
  for (const input of await f.panel.locator('input, textarea, select').all()) {
    await expect(input).toHaveAccessibleName(/.+/);
  }
  await page.screenshot({ path: testInfo.outputPath('sound-screen.png'), fullPage: true });
  expect(f.errors).toEqual([]);
});
