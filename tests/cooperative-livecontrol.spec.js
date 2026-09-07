import { test, expect } from '@playwright/test';

// Render the real component; all robot HTTP/WS traffic terminates in fixtures.
async function setup(page, response = { sent: true, run_id: 'live-run' }) {
  page.on('pageerror', error => console.error('fixture page error:', error.message));
  let socket;
  await page.routeWebSocket('**/ws', ws => { socket = ws; });
  await page.route('**/api/**', r => r.fulfill({ json: {} }));
  await page.route('**/api/ai/generate', r => r.fulfill({ json: {
    program: [{ type: 'display', text: 'fixture only' }],
  } }));
  await page.route('**/api/robot/program', r => r.fulfill({ json: response }));
  await page.addInitScript(() => localStorage.setItem('mbot-studio-current-profile', 'profile_default'));
  await page.route('**/api/robot/status', r => r.fulfill({ json: {
    robotOnline: true, mqttConnected: true, application: 'cooperative-v1', motion_enabled: false, armed: false,
  } }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Live Control' }).click();
  await expect(page.locator('.live-log')).toContainText('Connected to server');
  return {
    emit: msg => socket.send(JSON.stringify(msg)),
    send: async () => {
      await page.locator('.live-input-row input').fill('Display fixture only');
      await page.getByRole('button', { name: 'Go!' }).click();
    },
    execution: (event, run_id = 'live-run', type = 'program', details = 'device detail') => {
      const data = { run_id, event, type, details, boot: 'fixture-boot', build: 'fixture-build' };
      socket.send(JSON.stringify({ type: 'mqtt', topic: 'robot/execution', data }));
      return data;
    },
    savedEvents: async () => {
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      return page.evaluate(() => JSON.parse(localStorage.getItem('mbot-studio-missions:profile_default'))[0].events);
    },
  };
}

test('sent is correlated, not completion; firmware rejection is visible and saved', async ({ page }) => {
  const fixture = await setup(page);
  await fixture.send();
  await expect(page.locator('.live-log')).toContainText('Program sent [run_id=live-run]');
  await expect(page.locator('.live-log')).toContainText('submission only; see device execution events');
  const failure = fixture.execution('failed', 'live-run', 'program', 'unsupported LED color');
  await expect(page.locator('.live-log .log-error')).toContainText('Program failed [run_id=live-run]');
  await expect(page.locator('.live-log')).toContainText('unsupported LED color');
  const events = await fixture.savedEvents();
  expect(events).toContainEqual(expect.objectContaining({ type: 'program_sent', payload: { blockCount: 1, run_id: 'live-run' } }));
  expect(events).toContainEqual(expect.objectContaining({ type: 'program_failed', payload: failure }));
});

test('block completion is not program completion; interleaved runs retain their IDs', async ({ page }) => {
  const fixture = await setup(page);
  fixture.execution('accepted');
  fixture.execution('started');
  fixture.execution('completed', 'other-run');
  const block = fixture.execution('completed', 'live-run', 'display');
  await expect(page.locator('.live-log')).toContainText('Block display completed [run_id=live-run]');
  await expect(page.locator('.live-log')).not.toContainText('Program completed [run_id=live-run]');
  const canceled = fixture.execution('canceled', 'live-run', 'program', { reason: 'stop requested' });
  const completed = fixture.execution('completed', 'next-run');
  await expect(page.locator('.live-log')).toContainText('Program canceled [run_id=live-run]');
  await expect(page.locator('.live-log')).toContainText('stop requested');
  await expect(page.locator('.live-log')).toContainText('Program completed [run_id=next-run]');
  const events = await fixture.savedEvents();
  expect(events).toContainEqual(expect.objectContaining({ type: 'execution_block', payload: block }));
  expect(events).toContainEqual(expect.objectContaining({ type: 'program_canceled', payload: canceled }));
  expect(events).toContainEqual(expect.objectContaining({ type: 'program_completed', payload: completed }));
  expect(events.filter(e => e.type === 'program_completed').map(e => e.payload.run_id)).toEqual(['other-run', 'next-run']);
  expect(events.filter(e => ['program_accepted', 'program_started'].includes(e.type))).toHaveLength(2);
});

test('command acknowledgement retains run_id without implying execution; legacy log and sensors survive', async ({ page }) => {
  const fixture = await setup(page);
  fixture.emit({ type: 'ack', command: 'display', run_id: 'command-run' });
  await expect(page.locator('.live-log')).toContainText('Command sent: display [run_id=command-run]');
  await expect(page.locator('.live-log')).not.toContainText('completed');
  fixture.emit({ type: 'ack', command: 'legacy-display' });
  fixture.emit({ type: 'mqtt', topic: 'robot/log', data: 'legacy log text' });
  fixture.emit({ type: 'mqtt', topic: 'robot/status', data: { state: 'ready' } });
  fixture.emit({ type: 'mqtt', topic: 'robot/sensors', data: { battery: 81 } });
  await expect(page.locator('.live-log')).toContainText('legacy log text');
  await expect(page.locator('.live-log')).toContainText('Robot: {"state":"ready"}');
  const events = await fixture.savedEvents();
  expect(events).toContainEqual(expect.objectContaining({ type: 'ack', payload: { command: 'display', run_id: 'command-run' } }));
  expect(events).toContainEqual(expect.objectContaining({ type: 'ack', payload: { command: 'legacy-display' } }));
  expect(events).toContainEqual(expect.objectContaining({ type: 'robot_log', payload: 'legacy log text' }));
  expect(events).toContainEqual(expect.objectContaining({ type: 'telemetry', payload: { battery: 81 } }));
});

for (const status of [200, 503]) {
  test(`HTTP ${status} with sent:false never records a successful send`, async ({ page }) => {
    const fixture = await setup(page);
    await page.route('**/api/robot/program', r => r.fulfill({ status, json: { sent: false, run_id: 'rejected-run' } }));
    await fixture.send();
    await expect(page.locator('.live-log .log-error')).toContainText('Program was not sent');
    const events = await fixture.savedEvents();
    expect(events.some(e => e.type === 'program_sent')).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ type: 'program_send_error', payload: { error: 'Program was not sent', run_id: 'rejected-run' } }));
  });
}

test('execution arriving before HTTP response is not lost; missing IDs remain uncorrelated', async ({ page }) => {
  const fixture = await setup(page);
  let release;
  await page.route('**/api/robot/program', async r => {
    await new Promise(resolve => { release = resolve; });
    await r.fulfill({ json: { sent: true, run_id: 'live-run' } });
  });
  await fixture.send();
  await expect.poll(() => Boolean(release)).toBe(true);
  fixture.execution('completed');
  await expect(page.locator('.live-log')).toContainText('Program completed [run_id=live-run]');
  release();
  await expect(page.locator('.live-log')).toContainText('Program sent [run_id=live-run]');
  fixture.execution('failed', null);
  await expect(page.locator('.live-log')).toContainText('Program failed [uncorrelated]');
  const events = await fixture.savedEvents();
  expect(events.findIndex(e => e.type === 'program_completed')).toBeLessThan(events.findIndex(e => e.type === 'program_sent'));
  expect(events.find(e => e.type === 'program_failed').payload.run_id).toBeNull();
  // A delayed send receipt must not claim we are still awaiting an event already observed.
  await expect(page.locator('.live-log')).not.toContainText('awaiting device execution');
});
