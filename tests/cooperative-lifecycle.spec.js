import { test, expect } from '@playwright/test';

async function setup(page, beforeResponse) {
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
  await page.route('**/api/robot/program', async r => {
    if (beforeResponse) {
      await beforeResponse(emit);
      await page.waitForTimeout(100); // Deliver WS frames while HTTP is still held.
    }
    await r.fulfill({json:{sent:true,run_id:'run-current'}});
  });
  await page.goto('/');
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

test('STOP acknowledgement is not cancellation; device canceled is terminal', async ({page}) => {
  const emit = await setup(page);
  const status = page.getByTestId('program-lifecycle');
  await expect(status).toContainText('Submitted');
  await page.route('**/api/robot/stop', r => r.fulfill({json:{sent:true}}));
  await page.getByRole('button',{name:'🛑 STOP',exact:true}).click();
  await expect(status).toContainText('Submitted');
  await emit('started');
  await expect(status).toContainText('Started');
  await emit('accepted');
  await expect(status).toContainText('Started');
  await emit('canceled');
  await expect(status).toContainText('Canceled');
  expect(await page.evaluate(() => localStorage.getItem('mbot-studio-achievements:profile_default') || '')).not.toContain('first_program');
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
