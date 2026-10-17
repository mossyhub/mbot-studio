import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

let script, stylesheet;
test.beforeAll(async () => {
  const result = await build({ stdin: {
    contents: `import React from 'react';import {createRoot} from 'react-dom/client';import App from './web/src/App.jsx';import './web/src/index.css';createRoot(document.getElementById('root')).render(<App/>);`,
    resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'jsx',
  }, bundle: true, write: false, outdir: '/virtual', format: 'iife', logLevel: 'silent' });
  script = result.outputFiles.find(file => file.path.endsWith('.js')).text;
  stylesheet = result.outputFiles.find(file => file.path.endsWith('.css')).text;
});

async function mount(page) {
  const requests = [], errors = [], unexpected = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.routeWebSocket('**/*', socket => socket.onMessage(() => {}));
  await page.route('**/*', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.isNavigationRequest() && path === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div>' });
    requests.push(`${request.method()} ${path}`);
    const fixtures = {
      '/api/config': { additions: [] }, '/api/config/firmware': { files: [], suggested: {} },
      '/api/config/calibrations': { calibrations: {} }, '/api/ai/model': { model: 'isolated-fixture' },
      '/api/robot/status': { robotOnline: false, mqttConnected: false, robotState: 'unknown' },
      '/api/robot/telemetry': { robotOnline: false, sensors: {}, sampling: false },
      '/api/recordings': { assets: [] },
    };
    if (request.method() === 'GET' && path in fixtures) return route.fulfill({ json: fixtures[path] });
    if (request.method() === 'POST' && path === '/api/robot/stop') return route.fulfill({ json: { success: true } });
    if (request.method() === 'POST' && path === '/api/ai/blocks-to-code') return route.fulfill({ json: { code: '# fixture preview' } });
    unexpected.push(`${request.method()} ${path}`); return route.abort();
  });
  await page.addInitScript(() => {
    localStorage.setItem('mbot-studio-profiles', JSON.stringify([{ id: 'guided', name: 'Alex' }]));
    localStorage.setItem('mbot-studio-current-profile', 'guided');
    localStorage.setItem('mbot-sound-muted', '1');
    window.globalStops = 0;
    window.addEventListener('mbot-global-stop', () => window.globalStops++);
  });
  await page.goto('http://guided-shell.test/');
  await page.addStyleTag({ content: stylesheet }); await page.addScriptTag({ content: script });
  await expect(page.locator('.scratch-editor')).toBeVisible();
  return { requests, errors, unexpected };
}

async function expectHitTarget(locator) {
  await expect(locator).toBeInViewport({ ratio: 1 });
  expect(await locator.evaluate(element => {
    const r = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  })).toBe(true);
}

test('Stop discards pending Helper drafts, fences late AI, and permits a fresh request', async ({ page }) => {
  const fixture = await mount(page);
  let release, arrived;
  const received = new Promise(resolve => { arrived = resolve; });
  await page.route('**/api/ai/generate', async route => {
    arrived();
    await new Promise(resolve => { release = resolve; });
    await route.fulfill({ json: { explanation: 'Late canceled suggestion', program: [{ id: 'late', type: 'wait', seconds: 1 }] } });
  });
  await page.getByRole('button', { name: 'AI helper', exact: true }).click();
  await page.getByPlaceholder('Tell your robot what to do...').fill('Wait one second');
  await page.getByPlaceholder('Tell your robot what to do...').press('Enter');
  await received;
  await page.getByTestId('global-stop').click();
  release();
  await expect(page.getByPlaceholder('Tell your robot what to do...')).toBeEnabled();
  await page.route('**/api/ai/generate', route => route.fulfill({ json: { explanation: 'Fresh intentional suggestion', program: [{ id: 'fresh', type: 'wait', seconds: 2 }] } }));
  await page.getByPlaceholder('Tell your robot what to do...').fill('Wait two seconds');
  await page.getByPlaceholder('Tell your robot what to do...').press('Enter');
  await expect(page.locator('.suggestion-bar')).toBeVisible();
  await expect(page.locator('.chat-messages')).toContainText('Fresh intentional suggestion');
  await expect(page.locator('.chat-messages')).not.toContainText('Late canceled suggestion');
  await page.getByTestId('global-stop').click();
  await expect(page.locator('.suggestion-bar')).toHaveCount(0);
  expect(fixture.unexpected).toEqual([]); expect(fixture.errors).toEqual([]);
});

test('Mobile starts with a usable canvas and expandable guidance', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(page);
  await expect(page.locator('.se-script.main').getByText('when program starts', { exact: true })).toBeInViewport({ ratio: 1 });
  await page.locator('.editing-hints summary').click();
  await expect(page.getByText('Keep space around the robot clear.', { exact: false })).toBeVisible();
  await expectHitTarget(page.getByTestId('global-stop'));
});

test('Helper closes internally, returns focus, and never covers Stop', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await mount(page);
  const opener = page.getByRole('button', { name: 'AI helper', exact: true });
  await opener.click();
  await expect(page.locator('.chat-panel-container')).toBeVisible();
  const close = page.getByRole('button', { name: 'Close helper', exact: true });
  await expectHitTarget(close);
  await expectHitTarget(page.getByTestId('global-stop'));
  await page.screenshot({ path: testInfo.outputPath('guided-mobile-helper.png') });
  await close.click();
  await expect(page.locator('.chat-panel-container')).toBeHidden();
  await expect(opener).toBeFocused();
  await opener.click(); await page.keyboard.press('Escape');
  await expect(page.locator('.chat-panel-container')).toBeHidden();
  expect(fixture.errors).toEqual([]);
});

test('Learn, mission starter, achievements, Robot and Advanced Debug remain real and reachable', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  const fixture = await mount(page);
  const header = page.locator('header.header');
  await page.getByRole('button', { name: 'Choose a mission', exact: true }).click();
  await expect(page.locator('.challenges-panel')).toBeVisible();
  await page.locator('.challenge-card').first().click();
  await page.getByRole('button', { name: 'Start Programming', exact: true }).click();
  await expect(page.getByTestId('mission-strip')).toBeVisible();
  await expect(page.locator('.mission-rail .mission-strip')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('guided-active-mission.png') });
  await page.getByRole('button', { name: 'Dismiss mission', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Choose a mission', exact: true })).toBeVisible();
  for (const name of ['Live Control', 'Learn', 'Robot']) {
    await header.getByRole('button', { name, exact: true }).click();
    await expectHitTarget(page.getByTestId('global-stop'));
    await page.getByTestId('global-stop').click();
  }
  await header.getByRole('button', { name: 'Advanced Debug', exact: true }).click();
  await expect(page.locator('.debug-terminal')).toBeVisible();
  await header.getByRole('button', { name: 'Learn', exact: true }).click();
  await header.getByRole('button', { name: /^Achievements/ }).click();
  await expect(page.locator('.achievements-panel')).toBeVisible();
  await expect.poll(() => fixture.requests.filter(r => r === 'POST /api/robot/stop').length).toBe(3);
  expect(await page.evaluate(() => window.globalStops)).toBe(3);
  expect(fixture.unexpected).toEqual([]); expect(fixture.errors).toEqual([]);
});

test('Project save, rename, reload and child profile isolation remain intact', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await mount(page);
  const header = page.locator('header.header');
  await header.getByTitle('Click to rename').click();
  await header.getByPlaceholder('Project name...').fill('My real draft');
  await header.getByPlaceholder('Project name...').press('Enter');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('mbot-studio-projects:guided'))?.[0]?.name)).toBe('My real draft');
  await header.getByTitle('New project', { exact: true }).click();
  await expect(header.getByTitle('Click to rename')).toHaveText('Untitled Project');
  await header.getByTitle('Project menu', { exact: true }).click();
  await expect(header.locator('.project-dropdown')).toBeInViewport({ ratio: 1 });
  await header.locator('.project-option').filter({ hasText: 'My real draft' }).click();
  await expect(header.getByTitle('Click to rename')).toHaveText('My real draft');
  await header.getByTitle('Switch child profile').click();
  await expect(header.locator('.profile-dropdown')).toBeInViewport({ ratio: 1 });
  await header.getByPlaceholder('New child name').fill('Blair');
  await header.getByTitle('Add child profile', { exact: true }).click();
  await expect(header.getByTitle('Click to rename')).toHaveText('Untitled Project');
  await header.getByTitle('Switch child profile').click();
  await header.getByPlaceholder('Rename current profile').fill('Blair Two');
  await header.getByTitle('Rename current profile', { exact: true }).click();
  await expect(header.getByTitle('Switch child profile')).toHaveText('Blair Two');
  await header.getByTitle('Switch child profile').click();
  await header.getByRole('button', { name: 'Alex', exact: true }).click();
  await expect(header.getByTitle('Click to rename')).toHaveText('My real draft');
  await header.getByTitle('Click to rename').focus();
  for (const title of ['Save project', 'Project menu', 'New project', 'Switch child profile']) {
    await page.keyboard.press('Tab');
    await expect(header.getByTitle(title, { exact: true })).toBeFocused();
  }
  expect(fixture.unexpected).toEqual([]); expect(fixture.errors).toEqual([]);
});

for (const width of [1440, 820, 390]) {
  test(`Guided mission workspace and persistent safety at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 960 });
    const fixture = await mount(page);
    await expect(page.getByText('Test workspace — shares robot and settings with main Studio', { exact: true })).toBeVisible();
    await expect(page.locator('.header-status')).toHaveText('Robot Offline');
    await expect(page.getByRole('complementary', { name: 'Mission checklist' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Choose a mission', exact: true })).toBeVisible();
    const stop = page.getByTestId('global-stop');
    await expect(stop).toBeInViewport({ ratio: 1 });
    const headerClipping = await page.locator('header.header').evaluate(header => [...header.querySelectorAll('button, .header-status')].filter(element => {
      const r = element.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return r.left < 0 || r.right > innerWidth + 1 || r.bottom > innerHeight || !element.contains(hit);
    }).map(element => element.textContent));
    expect(headerClipping).toEqual([]);
    const geometry = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
      rail: document.querySelector('.mission-rail').getBoundingClientRect().toJSON(),
      editor: document.querySelector('.blocks-panel-container').getBoundingClientRect().toJSON() }));
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.width);
    if (width >= 820) expect(geometry.rail.right).toBeLessThanOrEqual(geometry.editor.left + 1);
    await page.screenshot({ path: testInfo.outputPath(`guided-${width}.png`), fullPage: true });
    await stop.click();
    await expect.poll(() => fixture.requests.filter(r => r === 'POST /api/robot/stop').length).toBe(1);
    expect(await page.evaluate(() => window.globalStops)).toBe(1);
    expect(fixture.unexpected).toEqual([]); expect(fixture.errors).toEqual([]);
  });
}
