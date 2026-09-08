// Isolated real-editor tests; no app server, API, MQTT, or robot.
// Run: npx playwright test --config=tests av-blocks.spec.js --workers=1
import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { blocksToMicroPython } from '../server/src/services/code-generator.js';

let bundle;
test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `import React from 'react';
        import { createRoot } from 'react-dom/client';
        import BlocklyEditor from './web/src/components/BlocklyEditor.jsx';
        const root = createRoot(document.getElementById('root'));
        let revision = 0;
        window.mountBlocks = blocks => root.render(React.createElement(BlocklyEditor, {
          key: ++revision, blocks, onBlocksChange: next => { window.editedBlocks = next; }
        }));`,
      resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'jsx',
    },
    bundle: true, write: false, format: 'iife', loader: { '.css': 'empty' },
    logLevel: 'silent',
  });
  bundle = result.outputFiles[0].text;
});

async function mount(page, blocks = []) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // Fulfill the only navigation in memory. Block every other network request.
  await page.route('**/*', route => route.request().url() === 'http://av-blocks.test/'
    ? route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' })
    : route.abort());
  await page.goto('http://av-blocks.test/');
  await page.addStyleTag({ content: '#root { display: flex; height: 700px; }'
    + readFileSync(new URL('../web/src/components/BlocklyEditor.css', import.meta.url), 'utf8') });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(value => window.mountBlocks(value), blocks);
  await expect(page.locator('.scratch-editor')).toBeVisible();
  return errors;
}
async function addBlock(page, category, label) {
  await page.getByTitle(category, { exact: true }).click();
  const palette = page.locator('.se-palette .palette').filter({ has: page.getByText(label, { exact: true }) });
  await expect(palette).toHaveCount(1);
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await palette.dispatchEvent('dragstart', { dataTransfer: transfer });
  await page.locator('.se-script.main > [data-arr-slot]').last().dispatchEvent('drop', { dataTransfer: transfer });
  await transfer.dispose();
}
function row(page, label) {
  return page.locator('.se-script.main .se-block-row').filter({ has: page.getByText(label, { exact: true }) });
}
async function saved(page) {
  return page.evaluate(() => JSON.parse(JSON.stringify(window.editedBlocks)));
}

test('volume and stop sound are usable palette blocks and survive editor hydration', async ({ page }) => {
  const errors = await mount(page);
  await addBlock(page, 'Sound', 'set volume');
  await addBlock(page, 'Sound', 'stop sound');
  const volume = row(page, 'set volume').locator('input');
  await expect(volume).toHaveAttribute('min', '0');
  await expect(volume).toHaveAttribute('max', '60');
  await volume.fill('0');
  const blocks = await saved(page);
  expect(blocks).toEqual([
    { type: 'set_volume', volume: 0, _id: expect.any(String) },
    { type: 'stop_sound', _id: expect.any(String) },
  ]);
  await page.evaluate(value => window.mountBlocks(value), blocks);
  await expect(row(page, 'set volume').locator('input')).toHaveValue('0');
  expect(blocksToMicroPython(blocks)).toContain('cyberpi.audio.set_vol(0)\ncyberpi.audio.stop()');
  expect(errors).toEqual([]);
});

test('text animation edits a real frame array, preserves multiline literals and reloads', async ({ page }) => {
  const errors = await mount(page);
  await addBlock(page, 'Display', 'animate text');
  const animation = row(page, 'animate text');
  await expect(animation.getByRole('textbox', { name: 'Frame 1', exact: true })).toHaveValue('Hello!');
  const frames = ['quote" slash\\\n雪', '', '001'];
  await animation.getByRole('textbox', { name: 'Frame 1', exact: true }).fill(frames[0]);
  await animation.getByRole('textbox', { name: 'Frame 2', exact: true }).fill(frames[1]);
  await animation.getByRole('button', { name: 'Add frame', exact: true }).click();
  await animation.getByRole('textbox', { name: 'Frame 3', exact: true }).fill(frames[2]);
  await animation.locator('input[type="number"]').fill('0.15');
  const blocks = await saved(page);
  expect(blocks).toEqual([{ type: 'display_animation', frames, interval: 0.15, _id: expect.any(String) }]);
  await expect(animation.locator('[data-reporter-slot][data-target-key="frames"]')).toHaveCount(0);
  await page.evaluate(value => window.mountBlocks(value), blocks);
  for (let i = 0; i < frames.length; i++) {
    await expect(animation.getByRole('textbox', { name: `Frame ${i + 1}`, exact: true })).toHaveValue(frames[i]);
  }
  await animation.getByRole('button', { name: 'Remove frame 3', exact: true }).click();
  expect((await saved(page))[0].frames).toEqual(frames.slice(0, 2));
  const code = blocksToMicroPython(blocks);
  for (const frame of frames) expect(code).toContain(`cyberpi.display.show_label(${JSON.stringify(frame)}, 24, "center", index=0)\ntime.sleep(0.15)`);
  expect(errors).toEqual([]);
});

test('frame controls bound list size and duplication keeps frame arrays independent', async ({ page }) => {
  const errors = await mount(page, [{ type: 'repeat', times: 2, do: [
    { type: 'display_animation', frames: Array.from({ length: 12 }, (_, i) => `frame ${i}`), interval: 0.5 },
  ] }]);
  const animation = row(page, 'animate text');
  await expect(animation.getByRole('button', { name: 'Add frame', exact: true })).toBeDisabled();
  await animation.getByText('animate text', { exact: true }).click();
  await animation.getByTitle('Duplicate', { exact: true }).click();
  const duplicated = await saved(page);
  expect(duplicated[0].do).toHaveLength(2);
  expect(duplicated[0].do[0]._id).not.toBe(duplicated[0].do[1]._id);
  await animation.nth(0).getByRole('textbox', { name: 'Frame 1', exact: true }).fill('changed');
  const edited = await saved(page);
  expect(edited[0].do[0].frames[0]).toBe('changed');
  expect(edited[0].do[1].frames[0]).toBe('frame 0');
  await page.evaluate(() => window.mountBlocks([{ type: 'display_animation', frames: ['only'], interval: 0.5 }]));
  await expect(animation.getByRole('button', { name: 'Remove frame 1', exact: true })).toBeDisabled();
  await addBlock(page, 'Display', 'animate text');
  expect((await saved(page))[1].frames).toEqual(['Hello!', 'mBot']);
  expect(errors).toEqual([]);
});
