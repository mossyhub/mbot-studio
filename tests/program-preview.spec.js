import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
let bundle;
test.beforeAll(async () => {
  const result = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import App from './web/src/App.jsx';createRoot(document.getElementById('root')).render(<App/>);`, resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'jsx' }, bundle: true, write: false, outdir: '/virtual', format: 'iife', logLevel: 'silent' });
  bundle = result.outputFiles.find(f => f.path.endsWith('.js')).text;
});
async function setup(page) {
  await page.route('**/*', r => r.fulfill(r.request().url() === 'http://preview.test/' ? { contentType: 'text/html', body: '<div id="root"></div>' } : { json: {} }));
  await page.addInitScript(() => {
    localStorage.setItem('mbot-studio-current-profile', 'profile_default');
    localStorage.setItem('mbot-studio-current-project:profile_default', 'a');
    localStorage.setItem('mbot-studio-projects:profile_default', JSON.stringify([
      { id: 'a', name: 'First', blocks: [{ type: 'wait', duration: 1 }], pythonCode: '# saved first' },
      { id: 'b', name: 'Second', blocks: [{ type: 'wait', duration: 8 }], pythonCode: '# saved second' },
    ]));
    // Deliberately ignore AbortSignal: fencing must also protect already-decoded responses.
    const original = window.fetch;
    window.previewRequests = [];
    window.fetch = (url, options) => url === '/api/ai/blocks-to-code' ? new Promise((resolve, reject) => {
      window.previewRequests.push({ blocks: JSON.parse(options.body).blocks, resolve: (body, ok = true) => resolve({ ok, status: ok ? 200 : 422, json: async () => body }), reject });
    }) : original(url, options);
  });
  await page.goto('http://preview.test/');
  await page.addScriptTag({ content: bundle });
  await expect(page.locator('.se-script.main input[type="number"]')).toHaveValue('1');
}
async function edit(page, value) {
  await page.locator('.se-script.main input[type="number"]').fill(String(value));
  await expect.poll(() => page.evaluate(value => window.previewRequests.some(r => r.blocks[0]?.duration === value), value)).toBe(true);
}
async function resolve(page, value, body, ok = true) {
  await page.evaluate(({ value, body, ok }) => window.previewRequests.filter(r => r.blocks[0]?.duration === value).at(-1).resolve(body, ok), { value, body, ok });
  await page.waitForTimeout(40);
}
test('AI drafts leave preview intact; Apply is fenced from later edits and Dismiss is inert', async ({ page }) => {
  await setup(page);
  await page.route('**/api/ai/generate', r => r.fulfill({ json: { program: [{ type: 'wait', duration: 4 }], pythonCode: '# draft only', explanation: 'Draft' } }));
  await page.getByRole('button', { name: 'AI helper', exact: true }).click();
  const prompt = page.getByPlaceholder('Tell your robot what to do...');
  await prompt.fill('wait');
  await prompt.press('Enter');
  await expect(page.getByRole('button', { name: 'Dismiss', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Show Python' }).click();
  await expect(page.locator('.code-block')).toHaveText('# saved first');
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(page.locator('.code-block')).toHaveText('# saved first');
  await prompt.fill('wait again');
  await prompt.press('Enter');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByText('Generating Python preview…', { exact: true })).toBeVisible();
  await expect(page.locator('.code-preview')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show Blocks' }).click();
  await edit(page, 5);
  await resolve(page, 5, { code: '# edited after apply' });
  await resolve(page, 4, { code: '# late apply' });
  await page.getByRole('button', { name: 'Show Python' }).click();
  await expect(page.locator('.code-block')).toHaveText('# edited after apply');
});
for (const failure of ['http', 'missing', 'network']) test(`generation ${failure} failure replaces stale code with an explicit error and recovers`, async ({ page }) => {
  await setup(page);
  await edit(page, 2);
  if (failure === 'network') await page.evaluate(() => window.previewRequests.at(-1).reject(new Error('offline')));
  else await resolve(page, 2, failure === 'http' ? { error: 'Unsupported block', code: '# invalid' } : {}, failure !== 'http');
  await page.getByRole('button', { name: 'Show Python' }).click();
  await expect(page.getByRole('alert')).toContainText('Python generation failed');
  await expect(page.locator('.code-preview')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show Blocks' }).click();
  await edit(page, 3);
  await resolve(page, 3, { code: '# recovered' });
  await page.getByRole('button', { name: 'Show Python' }).click();
  await expect(page.locator('.code-block')).toHaveText('# recovered');
});
test('project load and new project fence old requests and preserve saved source', async ({ page }) => {
  await setup(page);
  await edit(page, 2);
  await page.getByTitle('Project menu', { exact: true }).click();
  await page.locator('.project-option').filter({ hasText: 'Second' }).click();
  await resolve(page, 2, { code: '# old project' });
  await page.getByRole('button', { name: 'Show Python' }).click();
  await expect(page.locator('.code-block')).toHaveText('# saved second');
  await page.getByTitle('Save project', { exact: true }).click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('mbot-studio-projects:profile_default')).find(p => p.id === 'b').pythonCode)).toBe('# saved second');
  await page.getByRole('button', { name: 'Show Blocks' }).click();
  await edit(page, 9);
  await page.getByTitle('New project', { exact: true }).click();
  await resolve(page, 9, { code: '# late reset' });
  await page.getByRole('button', { name: 'Show Python' }).click();
  await expect(page.locator('.code-block')).not.toContainText('# late reset');
  await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled();
});
test('late edit response cannot replace newer preview, including undo/redo', async ({ page }) => {
  await setup(page);
  await edit(page, 2);
  await edit(page, 3);
  await resolve(page, 3, { code: '# newest' });
  await resolve(page, 2, { code: '# stale' });
  await page.getByRole('button', { name: 'Show Python' }).click();
  await expect(page.locator('.code-block')).toHaveText('# newest');
  await page.getByRole('button', { name: 'Undo', exact: false }).click();
  await page.getByRole('button', { name: 'Redo', exact: false }).click();
  await resolve(page, 3, { code: '# redo' });
  await resolve(page, 2, { code: '# late undo' });
  await expect(page.locator('.code-block')).toHaveText('# redo');
});
