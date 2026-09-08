// Real React editor + Chromium interactions; no API, MQTT, or robot.
// Run: node node_modules/@playwright/test/cli.js test --config=tests program-interactions.spec.js --workers=1
import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

test.use({
  viewport: { width: 1280, height: 800 },
  launchOptions: {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  },
});
const pageErrors = new WeakMap();
test.beforeEach(async ({ page }) => {
  pageErrors.set(page, []);
  page.on('pageerror', error => pageErrors.get(page).push(error.message));
});
test.afterEach(async ({ page }) => expect(pageErrors.get(page)).toEqual([]));
let bundle;
test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `import React from 'react';
        import { createRoot } from 'react-dom/client';
        import BlocklyEditor from './web/src/components/BlocklyEditor.jsx';
        const root = createRoot(document.getElementById('root'));
        window.mountBlocks = blocks => {
          window.editedBlocks = blocks;
          root.render(React.createElement(BlocklyEditor, {
            blocks, onBlocksChange: next => { window.editedBlocks = next; }
          }));
        };`,
      resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'jsx',
    },
    bundle: true, write: false, format: 'iife', loader: { '.css': 'empty' }, logLevel: 'silent',
  });
  bundle = result.outputFiles[0].text;
});
async function mount(page, blocks = [], floating = []) {
  await page.route('**/*', route => route.request().url() === 'http://program-interactions.test/'
    ? route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' })
    : route.abort());
  await page.goto('http://program-interactions.test/');
  await page.addStyleTag({ content: '#root { display: flex; height: 760px; }'
    + readFileSync(new URL('../web/src/components/BlocklyEditor.css', import.meta.url), 'utf8') });
  await page.evaluate(value => localStorage.setItem('mbot.floatingScripts', JSON.stringify(value)), floating);
  await page.addScriptTag({ content: bundle });
  await page.evaluate(value => window.mountBlocks(value), blocks);
  await expect(page.locator('.scratch-editor')).toBeVisible();
}
const saved = page => page.evaluate(() => window.editedBlocks);
const floatingScripts = page => page.evaluate(() => JSON.parse(localStorage.getItem('mbot.floatingScripts')));
async function startMouseDrag(page, source) {
  const box = await source.boundingBox();
  await page.mouse.move(box.x + 12, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 30, box.y + box.height / 2, { steps: 5 });
}

for (const zoom of [0.5, 1.5]) {
  test(`palette drop lands under the pointer at ${zoom * 100}% zoom after scrolling`, async ({ page }) => {
    await mount(page);
    for (let i = 0; i < 5; i++) await page.getByTitle(zoom < 1 ? 'Zoom out' : 'Zoom in', { exact: true }).click();
    await page.waitForTimeout(150);
    await page.locator('.se-canvas').evaluate(el => { el.scrollLeft = 120; el.scrollTop = 80; });
    await startMouseDrag(page, page.locator('.se-palette .palette').filter({ hasText: 'move forward' }));
    await page.mouse.move(900, 400, { steps: 12 });
    await page.mouse.up();
    await expect(page.locator('.se-script.floating')).toHaveCount(1);
    const box = await page.locator('.se-script.floating').boundingBox();
    expect(box.x).toBeCloseTo(900 - 12 * zoom, 0);
    expect(box.y).toBeCloseTo(400 - 8 * zoom, 0);
    expect(await saved(page)).toEqual([]);
  });

  test(`script handle follows the pointer at ${zoom * 100}% zoom`, async ({ page }) => {
    await mount(page, [{ type: 'wait', duration: 1, _id: 'wait' }]);
    for (let i = 0; i < 5; i++) await page.getByTitle(zoom < 1 ? 'Zoom out' : 'Zoom in', { exact: true }).click();
    await expect(page.locator('.se-zoom-pct')).toHaveText(`${zoom * 100}%`);
    // Wait for the editor's documented 100ms zoom transition before measuring.
    await page.waitForTimeout(150);
    const hat = page.locator('.se-script.main > .hat');
    const before = await hat.boundingBox();
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x + before.width / 2 + 100, before.y + before.height / 2 + 60, { steps: 8 });
    await page.mouse.up();
    const after = await hat.boundingBox();
    expect(after.x - before.x).toBeCloseTo(100, 0);
    expect(after.y - before.y).toBeCloseTo(60, 0);
    expect(await saved(page)).toEqual([{ type: 'wait', duration: 1, _id: 'wait' }]);
  });
}

for (const invalid of ['statement into value', 'number into boolean', 'reporter into itself']) {
  test(`invalid connection is not highlighted: ${invalid}`, async ({ page }) => {
    const blocks = [
      { type: 'set_variable', _id: 'variable', name: 'sum', value: { type: 'op_add', _id: 'add', a: 2, b: 3 } },
      { type: 'if_predicate', _id: 'if', then: [] },
      { type: 'wait', _id: 'wait', duration: 1 },
    ];
    await mount(page, blocks);
    let source = page.locator('.se-palette .palette').filter({ hasText: 'move forward' });
    let target = page.locator('[data-target-parent="wait"][data-target-key="duration"]');
    if (invalid === 'number into boolean') {
      await page.getByTitle('Sensing', { exact: true }).click();
      source = page.locator('.se-palette .reporter.palette').filter({ has: page.getByText('distance', { exact: true }) });
      target = page.locator('[data-target-parent="if"][data-target-key="cond"]');
    } else if (invalid === 'reporter into itself') {
      source = page.locator('.se-script.main .reporter');
      target = page.locator('[data-target-parent="add"][data-target-key="a"]');
    }
    const transfer = await page.evaluateHandle(() => new DataTransfer());
    await source.dispatchEvent('dragstart', { dataTransfer: transfer });
    await target.dispatchEvent('dragover', { dataTransfer: transfer });
    await expect(target).not.toHaveClass(/active|snap-grow/);
    await target.dispatchEvent('drop', { dataTransfer: transfer });
    expect(await saved(page)).toEqual(blocks);
    await transfer.dispose();
  });
}

test('occupied reporter connections reject a drop without deleting either expression', async ({ page }) => {
  const blocks = [
    { type: 'wait', _id: 'wait', duration: { type: 'op_add', _id: 'add', a: 2, b: 3 } },
    { type: 'set_variable', _id: 'variable', name: 'distance', value: { type: 'sensor_distance', _id: 'distance' } },
  ];
  await mount(page, blocks);
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  const source = page.locator('[data-target-parent="variable"][data-target-key="value"] > .reporter');
  const target = page.locator('[data-target-parent="wait"][data-target-key="duration"]');
  await source.dispatchEvent('dragstart', { dataTransfer: transfer });
  await target.dispatchEvent('dragover', { dataTransfer: transfer });
  await expect(target).not.toHaveClass(/active|snap-grow/);
  await target.dispatchEvent('drop', { dataTransfer: transfer });
  expect(await saved(page)).toEqual(blocks);
  // Positive control: the same reporter still fits an unoccupied operand.
  await source.dispatchEvent('dragstart', { dataTransfer: transfer });
  const operand = page.locator('[data-target-parent="add"][data-target-key="a"]');
  await operand.dispatchEvent('dragover', { dataTransfer: transfer });
  await expect(operand).toHaveClass(/active/);
  await operand.dispatchEvent('drop', { dataTransfer: transfer });
  await expect.poll(() => saved(page)).toEqual([
    { ...blocks[0], duration: { ...blocks[0].duration, a: blocks[1].value } },
    { type: 'set_variable', _id: 'variable', name: 'distance' },
  ]);
  await transfer.dispose();
});

test('nested operators keep their infix symbols visible after connecting and reloading', async ({ page }) => {
  const blocks = [{ type: 'if_predicate', _id: 'if', then: [], cond: {
    type: 'op_lt', _id: 'less', a: { type: 'op_add', _id: 'add', a: 2, b: 3 }, b: 10,
  } }];
  await mount(page, blocks);
  await expect(page.locator('.se-script.main .se-rep-infix')).toHaveText(['+', '<']);
  await page.locator('[data-target-parent="add"][data-target-key="a"] input').fill('4');
  const edited = await saved(page);
  expect(edited[0].cond.a.a).toBe(4);
  await page.evaluate(value => window.mountBlocks(value), edited);
  await expect(page.locator('.se-script.main .se-rep-infix')).toHaveText(['+', '<']);
  await page.screenshot({ path: test.info().outputPath('nested-operators.png') });
});

test('Tab can select a nested reporter for keyboard deletion without selecting its parent', async ({ page }) => {
  await mount(page, [{ type: 'wait', _id: 'wait', duration: { type: 'sensor_distance', _id: 'distance' } }]);
  const reporter = page.getByRole('group', { name: 'distance block', exact: true });
  await expect(reporter).toHaveAttribute('tabindex', '0');
  await page.getByTitle('Motion', { exact: true }).focus();
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    if (await reporter.evaluate(el => el === document.activeElement)) break;
  }
  await expect(reporter).toBeFocused();
  await expect(reporter).toHaveClass(/editing/);
  await expect(page.locator('.se-script.main .editing')).toHaveCount(1);
  const focusStyle = await reporter.locator(':scope > .se-block-row').evaluate(el => getComputedStyle(el).outlineStyle);
  expect(focusStyle).not.toBe('none');
  await page.keyboard.press('Delete');
  await expect.poll(() => saved(page)).toEqual([{ type: 'wait', _id: 'wait' }]);
});

test('clicking a nested reporter selects only that reporter before Delete', async ({ page }) => {
  const blocks = [{ type: 'wait', duration: { type: 'sensor_distance', _id: 'distance' }, _id: 'wait' }];
  await mount(page, blocks);
  const reporter = page.locator('.se-script.main .reporter');
  await reporter.locator('.se-block-text').click();
  await expect(reporter).toHaveClass(/editing/);
  await expect(page.locator('.se-script.main .editing')).toHaveCount(1);
  await page.keyboard.press('Delete');
  await expect.poll(() => saved(page)).toEqual([{ type: 'wait', _id: 'wait' }]);
  await expect(page.locator('.se-script.main input')).toHaveValue('1');
});

test('Escape cancels a highlighted connection without changing either script', async ({ page }) => {
  const blocks = [{ type: 'wait', duration: 1, _id: 'wait' }];
  const floating = [{ id: 'loose', x: 24, y: 260, blocks: [{ type: 'stop_sound', _id: 'sound' }] }];
  await mount(page, blocks, floating);
  await startMouseDrag(page, page.locator('.se-script.floating .se-block-text'));
  const target = page.locator('.se-script.main > [data-arr-slot][data-target-index="1"]');
  const box = await target.boundingBox();
  await page.mouse.move(box.x + box.width + 35, box.y, { steps: 12 });
  await expect(target).toHaveClass(/snap-active/);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('.snap-active, .snap-grow')).toHaveCount(0);
  expect(await saved(page)).toEqual(blocks);
  expect(await floatingScripts(page)).toEqual(floating);
});

test('nested insertion and same-mouth reorder preserve siblings and stable identities', async ({ page }) => {
  const a = { type: 'wait', _id: 'a', duration: 1 };
  const b = { type: 'stop_sound', _id: 'b' };
  await mount(page, [{ type: 'repeat', _id: 'loop', times: 2, do: [a, b] }]);
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  const slot = index => page.locator(`[data-arr-slot][data-target-parent="loop"][data-target-index="${index}"]`);
  await page.locator('.se-palette .palette').filter({ hasText: 'move forward' }).dispatchEvent('dragstart', { dataTransfer: transfer });
  await slot(1).dispatchEvent('drop', { dataTransfer: transfer });
  const inserted = (await saved(page))[0].do[1];
  expect(inserted.type).toBe('move_forward');
  await page.locator('.se-script.main .se-mouth .se-block-text').filter({ hasText: /^wait$/ }).dispatchEvent('dragstart', { dataTransfer: transfer });
  await slot(2).dispatchEvent('drop', { dataTransfer: transfer });
  await expect.poll(() => saved(page)).toEqual([{ type: 'repeat', _id: 'loop', times: 2, do: [inserted, a, b] }]);
  expect(await floatingScripts(page)).toEqual([]);
  await transfer.dispose();
});

test('Delete inside a literal edits text instead of deleting the selected block', async ({ page }) => {
  await mount(page, [{ type: 'say', _id: 'say', text: 'hello' }]);
  await page.locator('.se-script.main .se-block-text').filter({ hasText: /^say$/ }).click();
  const input = page.locator('.se-script.main input');
  await input.focus();
  await input.press('Home');
  await input.press('Delete');
  await expect.poll(() => saved(page)).toEqual([{ type: 'say', _id: 'say', text: 'ello' }]);
});

test('near-connection release inserts the block instead of silently losing the drop', async ({ page }) => {
  await mount(page, [{ type: 'wait', duration: 1, _id: 'wait' }]);
  const source = page.locator('.se-palette .palette').filter({ hasText: 'move forward' });
  const target = page.locator('.se-script.main > [data-arr-slot][data-target-index="1"]');
  await startMouseDrag(page, source);
  const box = await target.boundingBox();
  // Within the connection's horizontal snap buffer, outside its native hit area.
  await page.mouse.move(box.x + box.width + 35, box.y, { steps: 15 });
  await expect(target).toHaveClass(/snap-active/);
  await page.mouse.up();
  await expect.poll(async () => (await saved(page)).map(b => b.type)).toEqual(['wait', 'move_forward']);
  expect(await floatingScripts(page)).toEqual([]);
  await expect(page.locator('.snap-active, .snap-grow')).toHaveCount(0);
});
