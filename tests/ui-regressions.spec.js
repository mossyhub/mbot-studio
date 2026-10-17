import { test, expect } from '@playwright/test';
import { openHelper, closeHelper } from './guided-navigation.js';

const forward = { type: 'move_forward', speed: 50, duration: 1, _id: 'block-a' };
const backward = { type: 'move_backward', speed: 50, duration: 1, _id: 'block-b' };
const stop = { type: 'stop', _id: 'block-c' };

async function seedFloating(page, scripts) {
  await page.goto('/');
  await page.evaluate(value => localStorage.setItem('mbot.floatingScripts', JSON.stringify(value)), scripts);
  await page.reload();
  await expect(page.locator('.se-script.floating')).toHaveCount(scripts.length);
}

async function readFloating(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('mbot.floatingScripts')));
}

async function dragBlockToSlot(page, source, target) {
  await source.scrollIntoViewIfNeeded();
  // Zero-height connection slots need room for the grabbed label below them.
  // Scrolling only the slot into view can leave the release point off-canvas.
  await target.evaluate(element => {
    const canvas = element.closest('.se-canvas');
    const r = element.getBoundingClientRect(), view = canvas.getBoundingClientRect();
    if (r.bottom + 48 > view.bottom) canvas.scrollTop += r.bottom + 48 - view.bottom;
  });
  await expect(source).toBeInViewport();
  const from = await source.boundingBox();
  const block = await source.evaluate(element => {
    const r = element.closest('.se-block-shape').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  const start = { x: from.x + 12, y: from.y + 5 };
  const reporter = await target.getAttribute('data-reporter-slot') !== null;
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 18, start.y + 1, { steps: 5 });
  // Guided statements snap their physical top connector, not the grabbed label.
  // Reporters still target the compatible input socket's center.
  const point = box => reporter
    ? { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    : { x: box.x + start.x - block.x, y: box.y + start.y - block.y };
  let end = point(await target.boundingBox());
  await page.mouse.move(end.x, end.y, { steps: 15 });
  await page.waitForTimeout(200);
  end = point(await target.boundingBox());
  await page.mouse.move(end.x + 0.1, end.y);
  try {
    await expect(target).toHaveClass(reporter ? /\b(active|snap-grow)\b/ : /snap-active/);
  } catch (error) {
    console.log('DRAG_GEOMETRY', JSON.stringify(await target.evaluate((element, start) => {
      const rect = el => { const r=el.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}; };
      const moving=document.querySelector('.se-moving-original');
      const canvas=element.closest('.se-canvas');
      return {start,target:rect(element),moving:moving?rect(moving):null,canvas:rect(canvas),scroll:[canvas.scrollLeft,canvas.scrollTop],viewport:[innerWidth,innerHeight],hit:document.elementFromPoint(start.end.x,start.end.y)?.outerHTML.slice(0,400)};
    }, {start,end})));
    throw error;
  }
  await page.mouse.up();
}

for (const withThirdScript of [false, true]) {
  test(`U3 joining floating stacks preserves destination after source deletion (third=${withThirdScript})`, async ({ page }) => {
    const scripts = [
      { id: 'source', x: 24, y: 160, blocks: [forward] },
      { id: 'destination', x: 370, y: 160, blocks: [backward] },
      ...(withThirdScript ? [{ id: 'untouched', x: 24, y: 350, blocks: [stop] }] : []),
    ];
    await seedFloating(page, scripts);
    await dragBlockToSlot(page,
      page.locator('.se-script.floating').nth(0).locator('.se-block-text').first(),
      page.locator('[data-target-script="float:1"][data-target-index="1"][data-arr-slot]'));
    const expected = [
      { ...scripts[1], blocks: [backward, forward] },
      ...scripts.slice(2),
    ];
    await expect.poll(() => readFloating(page)).toEqual(expected);
    await page.reload();
    await expect(page.locator('.se-script.floating')).toHaveCount(expected.length);
    expect(await readFloating(page)).toEqual(expected);
  });
}

test('U3 reordering within a floating stack adjusts the insertion index', async ({ page }) => {
  const script = { id: 'same-stack', x: 24, y: 160, blocks: [forward, backward, stop] };
  await seedFloating(page, [script]);
  await dragBlockToSlot(page,
    page.locator('.se-script.floating .se-block-text').first(),
    page.locator('[data-target-script="float:0"][data-target-index="2"][data-arr-slot]'));
  await expect.poll(() => readFloating(page)).toEqual([
    { ...script, blocks: [backward, forward, stop] },
  ]);
});

test('U3 moving a floating reporter preserves it when its source script disappears', async ({ page }) => {
  const reporter = { type: 'sensor_distance', _id: 'distance-reporter' };
  const destination = { id: 'destination', x: 370, y: 160, blocks: [backward] };
  await seedFloating(page, [
    { id: 'source', x: 24, y: 160, blocks: [reporter] }, destination,
  ]);
  await dragBlockToSlot(page,
    page.locator('.se-script.floating').nth(0).locator('.se-block-text').first(),
    page.locator('[data-reporter-slot][data-target-parent="block-b"][data-target-key="speed"]'));
  const expected = [{ ...destination, blocks: [{ ...backward, speed: reporter }] }];
  await expect.poll(() => readFloating(page)).toEqual(expected);
  await page.reload();
  await expect(page.locator('.se-script.floating')).toHaveCount(1);
  expect(await readFloating(page)).toEqual(expected);
});

test('U3 moving a stack through main and back preserves blocks and run state', async ({ page }) => {
  const destination = { id: 'destination', x: 370, y: 160, blocks: [backward] };
  await seedFloating(page, [
    { id: 'source', x: 24, y: 160, blocks: [forward] }, destination,
  ]);
  const run = page.getByRole('button', { name: 'Run Program' });
  await expect(run).toBeDisabled();
  await dragBlockToSlot(page,
    page.locator('.se-script.floating').nth(0).locator('.se-block-text').first(),
    page.locator('[data-target-script="main"][data-target-index="0"][data-arr-slot]'));
  await expect.poll(() => readFloating(page)).toEqual([destination]);
  await expect(run).toBeEnabled();
  const sent = page.waitForResponse(r => r.url().endsWith('/api/robot/program'));
  await run.click();
  const response = await sent;
  expect(response.ok()).toBeTruthy();
  expect(response.request().postDataJSON().program).toEqual([forward]);
  // The legacy simulator returns no correlated run ID; await its final,
  // correctly unverified UI state before measuring the next native drag.
  // A late lifecycle-row insertion would otherwise invalidate grab offsets.
  await expect(page.getByTestId('program-lifecycle')).toContainText('Unverified — transport acknowledgement only');
  await dragBlockToSlot(page,
    page.locator('.se-script.main .se-block-shape.stack .se-block-text').first(),
    page.locator('[data-target-script="float:0"][data-target-index="1"][data-arr-slot]'));
  await expect.poll(() => readFloating(page)).toEqual([
    { ...destination, blocks: [backward, forward] },
  ]);
  await expect(run).toBeDisabled();
});

async function generateDraft(page, message) {
  await openHelper(page);
  await page.locator('.chat-input').fill(message);
  await page.locator('.chat-send-btn').click();
  await expect(page.locator('.suggestion-bar')).toBeVisible();
}

async function applyDraft(page) {
  const generated = page.waitForResponse(r => r.url().endsWith('/api/ai/blocks-to-code'));
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  const result = await generated;
  expect(result.ok()).toBeTruthy();
  await closeHelper(page);
  return result.json();
}

test('U2 dismissed draft cannot change current preview, saved code or run blocks', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'AI helper', exact: true }).click();
  await generateDraft(page, 'go forward for 2 seconds');
  const applied = await applyDraft(page);
  await page.getByRole('button', { name: 'Show Python' }).click();
  const preview = page.locator('.code-block code');
  await expect(preview).toHaveText(applied.code);
  await generateDraft(page, 'draw a square');
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await closeHelper(page);
  await expect(preview).toHaveText(applied.code);
  await page.getByTitle('Save project', { exact: true }).click();
  const saved = await page.evaluate(() => {
    const profile = localStorage.getItem('mbot-studio-current-profile');
    const id = localStorage.getItem(`mbot-studio-current-project:${profile}`);
    return JSON.parse(localStorage.getItem(`mbot-studio-projects:${profile}`)).find(p => p.id === id);
  });
  expect(saved.pythonCode).toBe(applied.code);
  expect(saved.blocks).toEqual([
    { type: 'move_forward', speed: 50, duration: 2 }, { type: 'stop' },
  ]);
  const sent = page.waitForResponse(r => r.url().endsWith('/api/robot/program'));
  await page.getByRole('button', { name: 'Run Program' }).click();
  const response = await sent;
  expect(response.ok()).toBeTruthy();
  expect(response.request().postDataJSON().program).toEqual(saved.blocks);

  // Positive control: an applied append draft really does replace the preview
  // with code generated from the merged current program, not the draft alone.
  await generateDraft(page, 'draw a square');
  await page.locator('.suggestion-mode').selectOption('append');
  const appended = await applyDraft(page);
  expect(appended.code).not.toBe(applied.code);
  await expect(preview).toHaveText(appended.code);
});

// Uses the configured local harness and genuine deterministic AI responses.
// No robot or cloud AI endpoint should be used to run this suite.
async function openLive(page) {
  await page.goto('/');
  await page.locator('.header-tabs button').filter({ hasText: 'Live Control' }).click();
  await expect(page.locator('.live-input-row input')).toBeEnabled();
}

async function sendLive(page, trigger = 'click') {
  const input = page.locator('.live-input-row input');
  await input.fill('go forward for 2 seconds');
  const sent = page.waitForResponse(r => r.url().endsWith('/api/robot/program'));
  if (trigger === 'click') await page.getByRole('button', { name: 'Go!' }).click();
  else await input.press('Enter');
  const response = await sent;
  expect(response.ok()).toBeTruthy();
  expect(response.request().postDataJSON().program).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'move_forward', duration: 2 }),
  ]));
  await expect(page.locator('.live-control')).toContainText('Program sent to robot!');
  return response;
}

test('U1 Go click sends the typed live command just like Enter', async ({ page }) => {
  await openLive(page);
  const prompts = [];
  page.on('request', r => {
    if (r.url().endsWith('/api/ai/generate')) prompts.push(r.postDataJSON());
  });
  await sendLive(page);
  await sendLive(page, 'enter');
  expect(prompts).toEqual([
    { message: 'go forward for 2 seconds' },
    { message: 'go forward for 2 seconds' },
  ]);
  await expect(page.locator('.live-control')).not.toContainText('circular');
});

for (const cancelVia of ['tab unmount', 'tab unmount then STOP', 'live STOP']) {
  test(`U5 pending live AI cannot send after ${cancelVia}`, async ({ page }) => {
    await openLive(page);
    const programs = [];
    page.on('request', r => {
      if (r.url().endsWith('/api/robot/program')) programs.push(r.postDataJSON());
    });
    let release;
    let received;
    let delivered;
    const gate = new Promise(resolve => { release = resolve; });
    const held = new Promise(resolve => { received = resolve; });
    const finished = new Promise(resolve => { delivered = resolve; });
    await page.route('**/api/ai/generate', async route => {
      // Hold a REAL local-debug response until the user abandons the work.
      const response = await route.fetch();
      expect(response.ok()).toBeTruthy();
      received();
      await gate;
      try { await route.fulfill({ response }); }
      finally { delivered(); }
    });
    await page.locator('.live-input-row input').fill('go forward for 2 seconds');
    await page.locator('.live-input-row input').press('Enter');
    await held;
    if (cancelVia.startsWith('tab')) {
      await page.locator('.header-tabs button').filter({ hasText: 'Program' }).click();
      await expect(page.locator('.live-control')).toHaveCount(0);
    }
    if (cancelVia.includes('STOP')) {
      const stopped = page.waitForResponse(r => r.url().endsWith('/api/robot/stop'));
      await page.getByRole('button', { name: 'Emergency Stop', exact: true }).click();
      expect((await stopped).ok()).toBeTruthy();
    }
    release();
    await finished;
    // Bounded observation after response delivery; a new successful request below
    // prevents a disabled/broken send path from falsely satisfying this guard.
    await page.waitForTimeout(400);
    expect(programs).toEqual([]);
    await page.unroute('**/api/ai/generate');
    if (cancelVia.startsWith('tab')) {
      await page.locator('.header-tabs button').filter({ hasText: 'Live Control' }).click();
    }
    await expect(page.locator('.live-input-row input')).toBeEnabled();
    await sendLive(page);
    expect(programs).toHaveLength(1);
  });
}
