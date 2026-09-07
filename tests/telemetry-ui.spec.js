import { test, expect } from '@playwright/test';
import { TelemetryService } from '../server/src/services/telemetry-service.js';

// Real React components and telemetry shaping; no HTTP/WS traffic reaches a robot.
async function setup(page, { online = true, snapshot = {} } = {}) {
  const sockets = [], messages = [], errors = [], requests = [];
  page.on('request', request => requests.push(new URL(request.url()).pathname));
  page.on('pageerror', error => errors.push(error.message));
  await page.routeWebSocket('**/ws', ws => {
    sockets.push(ws);
    ws.onMessage(data => messages.push(JSON.parse(data)));
  });
  await page.route('**/api/**', r => r.fulfill({ json: {} }));
  await page.route('**/api/robot/status', r => r.fulfill({ json: {
    robotOnline: online, mqttConnected: true, state: 'running',
  } }));
  await page.route('**/api/robot/telemetry', typeof snapshot === 'function' ? snapshot : r => r.fulfill({ json: snapshot }));
  await page.addInitScript(() => localStorage.setItem('mbot-studio-current-profile', 'profile_default'));
  await page.goto('/');
  await page.getByRole('button', { name: 'Live Control' }).click();
  await expect(page.locator('.live-log')).toContainText('Connected to server');
  return { sockets, messages, errors, requests,
    emit: data => sockets.at(-1).send(JSON.stringify({ type: 'telemetry', data })),
  };
}

function telemetry(sensors) {
  const service = new TelemetryService();
  service.updateSensors(sensors);
  return service.getTelemetry();
}

test('cached snapshot age ticks to stale without WS updates or automatic sensor requests', async ({ page }) => {
  // Deliberately unrelated browser/server wall clocks: only server age matters.
  const browserTime = new Date('2040-01-01T00:00:00Z');
  await page.clock.install({ time: browserTime });
  await page.clock.pauseAt(browserTime);
  const fixture = await setup(page, { snapshot: {
    ...telemetry({ battery: 73 }), timestamp: 1, age: 2000, stale: false,
  } });
  const panel = page.locator('.telemetry-panel');
  await expect(panel).toContainText('73%');
  await expect.soft(panel.locator('.telemetry-age')).toHaveText('Age: 2s');
  await expect.soft(panel.locator('.telemetry-live')).toHaveText('● Snapshot');
  await page.clock.setSystemTime(new Date('2050-01-01T00:00:00Z'));
  await page.clock.runFor(8000);
  await expect.soft(panel.locator('.telemetry-age')).toHaveText('Age: 10s');
  await expect(panel.locator('.telemetry-stale-badge')).toHaveCount(0);
  await page.clock.setSystemTime(new Date('2000-01-01T00:00:00Z'));
  await page.clock.runFor(1000);
  await expect.soft(panel.locator('.telemetry-age')).toHaveText('Age: 11s');
  await expect.soft(panel.locator('.telemetry-stale-badge')).toHaveText('Stale');
  await expect.soft(panel.locator('.telemetry-live')).toHaveCount(0);
  // A suspended/throttled tab must catch up by elapsed time, not tick count.
  await page.clock.fastForward(60000);
  await expect(panel.locator('.telemetry-age')).toHaveText('Age: 71s');
  expect(fixture.requests.filter(path => path === '/api/robot/telemetry')).toHaveLength(1);
  expect(fixture.messages).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('offline refresh is disabled and no sensor request is sent', async ({ page }) => {
  const fixture = await setup(page, { online: false, snapshot: telemetry({ battery: 73 }) });
  const panel = page.locator('.telemetry-panel');
  await expect(panel).toContainText('73%');
  await expect(panel.locator('.telemetry-offline')).toHaveText('Offline');
  await expect(panel.locator('.telemetry-live')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Refresh sensors', exact: true })).toBeDisabled();
  expect(fixture.messages).toEqual([]);
});

test('sampling updates are labelled Sampling until a completed snapshot arrives', async ({ page }) => {
  const browserTime = new Date('2040-01-01T00:00:00Z');
  await page.clock.install({ time: browserTime });
  await page.clock.pauseAt(browserTime);
  const fixture = await setup(page, { snapshot: {
    ...telemetry({ battery: 73, sampling: true }), age: 0,
  } });
  const panel = page.locator('.telemetry-panel');
  await expect(panel.locator('.telemetry-sampling')).toHaveText('Sampling');
  await expect(panel.locator('.telemetry-live')).toHaveCount(0);
  await expect(panel).not.toContainText('complete');
  await page.clock.runFor(11000);
  await expect(panel.locator('.telemetry-sampling')).toHaveText('Sampling');
  await expect(panel.locator('.telemetry-stale-badge')).toHaveText('Stale');
  fixture.emit({ ...telemetry({ battery: 74, sampling: false }), age: 0 });
  await expect(panel).toContainText('74%');
  await expect(panel.locator('.telemetry-live')).toHaveText('● Snapshot');
  await expect(panel.locator('.telemetry-sampling')).toHaveCount(0);
  await expect(panel.locator('.telemetry-age')).toHaveText('Age: 0s');
  await expect(panel.locator('.telemetry-stale-badge')).toHaveCount(0);
  await page.clock.runFor(11000);
  await expect(panel.locator('.telemetry-age')).toHaveText('Age: 11s');
  await expect(panel.locator('.telemetry-stale-badge')).toHaveText('Stale');
  await expect(panel.locator('.telemetry-live')).toHaveCount(0);
  expect(fixture.messages).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

for (const { label, age, stale, ageText } of [
  { label: 'server stale flag', age: 0, stale: true, ageText: 'Age: 0s' },
  { label: 'already aged cache', age: 15000, stale: false, ageText: 'Age: 15s' },
  { label: 'unknown age', age: null, stale: false, ageText: 'Age: unknown' },
  { label: 'missing age', age: undefined, stale: false, ageText: 'Age: unknown' },
]) {
  test(`${label} never receives a fresh snapshot badge`, async ({ page }) => {
    const fixture = await setup(page, { snapshot: {
      ...telemetry({ battery: 73 }), age, stale,
    } });
    await expect(page.locator('.telemetry-age')).toHaveText(ageText);
    await expect(page.locator('.telemetry-stale-badge')).toHaveText('Stale');
    await expect(page.locator('.telemetry-live')).toHaveCount(0);
    expect(fixture.messages).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });
}

for (const cacheTimestamp of [1, 2]) {
  test(`late cached response (${cacheTimestamp === 1 ? 'older' : 'same'} timestamp) never overwrites a WebSocket snapshot or resets age`, async ({ page }) => {
    const browserTime = new Date('2040-01-01T00:00:00Z');
    await page.clock.install({ time: browserTime });
    await page.clock.pauseAt(browserTime);
    let release;
    const fixture = await setup(page, { snapshot: async route => {
      await new Promise(resolve => { release = resolve; });
      await route.fulfill({ json: { ...telemetry({ battery: 11 }), timestamp: cacheTimestamp, age: 0 } });
    } });
    await expect.poll(() => Boolean(release)).toBe(true);
    fixture.emit({ ...telemetry({ battery: 86 }), timestamp: 2, age: 0 });
    await expect(page.locator('.telemetry-panel')).toContainText('86%');
    await page.clock.runFor(11000);
    const response = page.waitForResponse('**/api/robot/telemetry');
    release();
    await (await response).finished();
    // Cross render frames so the resolved fetch has had a chance to update React.
    await page.clock.runFor(50);
    await expect(page.locator('.telemetry-panel')).toContainText('86%');
    await expect(page.locator('.telemetry-panel')).not.toContainText('11%');
    await expect(page.locator('.telemetry-age')).toHaveText('Age: 11s');
    await expect(page.locator('.telemetry-stale-badge')).toHaveText('Stale');
    await page.clock.runFor(1000);
    await expect(page.locator('.telemetry-age')).toHaveText('Age: 12s');
    expect(fixture.errors).toEqual([]);
  });
}

test('legacy string color still renders and a subsequent sparse scan clears orientation and errors', async ({ page }) => {
  const fixture = await setup(page, { snapshot: telemetry({ yaw: 25, color: 'red', errors: { distance: 'failed' } }) });
  await expect(page.locator('.telemetry-panel')).toContainText('Yaw: 25°');
  await expect(page.locator('.color-swatch')).toHaveCSS('background-color', 'rgb(255, 0, 0)');
  fixture.emit(telemetry({ battery: 67 }));
  await expect(page.locator('.telemetry-panel')).toContainText('67%');
  await expect(page.locator('.telemetry-panel')).not.toContainText('Yaw:');
  await expect(page.locator('.telemetry-panel')).not.toContainText('failed');
  expect(fixture.errors).toEqual([]);
});

test('flat quad fields and partial legacy gyro show only received readings', async ({ page }) => {
  const fixture = await setup(page);
  fixture.emit(telemetry({ color_L1: 'red', color_L2: 0, color_R1: 'white', color_R2: 'black', gyro_z: 19 }));
  const panel = page.locator('.telemetry-panel');
  await expect(panel).toContainText('L1: red');
  await expect(panel).toContainText('L2: 0');
  await expect(panel).toContainText('R1: white');
  await expect(panel).toContainText('R2: black');
  await expect(panel).toContainText('X:— Y:— Z:19°');
  await expect(panel).not.toContainText('flat');
  expect(fixture.errors).toEqual([]);
});

test('actual yaw pitch roll and quad color object render with raw sensor errors', async ({ page }, testInfo) => {
  const fixture = await setup(page);
  fixture.emit(telemetry({
    yaw: -5, pitch: 0, roll: -7, line_status: 1,
    color: { L1: 'red', L2: 'black', R1: 'white', R2: 'unknown' },
    errors: { distance: 'vendor read failed', line_status: { code: 'unsupported' } },
  }));
  const panel = page.locator('.telemetry-panel');
  await expect(panel).toContainText('Yaw: -5°');
  await expect(panel).toContainText('Pitch: 0°');
  await expect(panel).toContainText('Roll: -7°');
  await expect(panel).toContainText('L1: red');
  await expect(panel).toContainText('R2: unknown');
  await expect(panel).toContainText('Line status');
  await expect(panel).toContainText('vendor read failed');
  await expect(panel).toContainText('"code":"unsupported"');
  await expect(panel).not.toContainText('Gyroscope');
  expect(fixture.errors).toEqual([]);
  // All sensor cards must fit the panel rather than being clipped by flex shrink.
  expect(await panel.evaluate(el => el.scrollHeight <= el.clientHeight)).toBe(true);
  await panel.screenshot({ path: testInfo.outputPath('telemetry-render.png') });
});

test('reconnect reloads cached snapshot and receives new telemetry on the replacement socket', async ({ page }) => {
  const fixture = await setup(page);
  fixture.emit(telemetry({ battery: 71 }));
  await expect(page.locator('.telemetry-panel')).toContainText('71%');
  const reconnectSnapshot = telemetry({ battery: 72 });
  await page.route('**/api/robot/telemetry', r => r.fulfill({ json: reconnectSnapshot }));
  fixture.sockets.at(-1).close();
  await expect(page.getByRole('button', { name: 'Refresh sensors', exact: true })).toBeDisabled();
  await expect(page.locator('.telemetry-offline')).toHaveText('Offline');
  await expect(page.locator('.telemetry-live')).toHaveCount(0);
  await expect.poll(() => fixture.sockets.length).toBe(2);
  await expect(page.locator('.telemetry-panel')).toContainText('72%');
  fixture.emit(telemetry({ battery: 74 }));
  await expect(page.locator('.telemetry-panel')).toContainText('74%');
  expect(fixture.messages).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('explicit refresh bootstraps nonperiodic sensors without automatic robot commands', async ({ page }) => {
  const fixture = await setup(page);
  expect(fixture.messages).toEqual([]);
  const refresh = page.getByRole('button', { name: 'Refresh sensors', exact: true });
  await expect(refresh).toBeEnabled();
  await refresh.click();
  await expect.poll(() => fixture.messages).toEqual([{ type: 'request_sensors' }]);
  fixture.emit(telemetry({ battery: 73, distance: 25 }));
  await expect(page.locator('.telemetry-panel')).toContainText('73%');
  await expect(page.locator('.telemetry-panel')).toContainText('25cm');
  await refresh.click();
  await expect.poll(() => fixture.messages.length).toBe(2);
  expect(fixture.messages).toEqual([{ type: 'request_sensors' }, { type: 'request_sensors' }]);
  expect(fixture.errors).toEqual([]);
});
