import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Bundle the real App; every network route is fulfilled or aborted before mounting.
// Run with an isolated Playwright config (no MQTT global setup or web server).
let script, stylesheet;
test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `import React from 'react';import {createRoot} from 'react-dom/client';import App from './web/src/App.jsx';import './web/src/index.css';createRoot(document.getElementById('root')).render(<App/>);`,
      resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'jsx',
    },
    bundle: true, write: false, outdir: '/virtual', format: 'iife', logLevel: 'silent',
  });
  script = result.outputFiles.find(file => file.path.endsWith('.js')).text;
  stylesheet = result.outputFiles.find(file => file.path.endsWith('.css')).text;
});

async function mount(page) {
  const unexpected = [], socketMessages = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // Never connect these intercepted sockets to a server (including Setup/Live Control).
  await page.routeWebSocket('**/*', socket => {
    socket.onMessage(message => socketMessages.push(String(message)));
  });
  await page.route('**/*', route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.isNavigationRequest() && path === '/') {
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div>' });
    }
    const fixtures = {
      '/api/config': { additions: [] },
      '/api/config/firmware': { files: [], suggested: {} },
      '/api/config/calibrations': { calibrations: {} },
      '/api/ai/model': { model: 'test' },
      '/api/robot/status': { robotOnline: true, mqttConnected: true, application: 'cooperative-v1', build: 'mbot-av-control-v1', capabilities: ['wait', 'stop'], armed: true, motion_enabled: true },
      '/api/robot/telemetry': { robotOnline: true, sensors: {}, sampling: false },
    };
    if (request.method() === 'GET' && path in fixtures) return route.fulfill({ json: fixtures[path] });
    if (request.method() === 'POST' && path === '/api/ai/blocks-to-code') {
      return route.fulfill({ json: { code: '# preview only' } });
    }
    unexpected.push(`${request.method()} ${path}`);
    return route.abort();
  });
  await page.addInitScript(() => {
    localStorage.setItem('mbot-studio-profiles', JSON.stringify([{ id: 'a', name: 'Alex' }]));
    localStorage.setItem('mbot-studio-current-profile', 'a');
    localStorage.setItem('mbot-sound-muted', '1');
  });
  await page.goto('http://header-layout.test/');
  await page.addStyleTag({ content: stylesheet });
  await page.addScriptTag({ content: script });
  await expect(page.locator('.scratch-editor')).toBeVisible();
  await expect(page.locator('.header-status')).toHaveText('Robot Online');
  return { unexpected, socketMessages, errors };
}

async function expectHeaderFits(page) {
  // Visibility alone passes for controls clipped by App's overflow:hidden.
  // Check full rectangles AND hit testing, without scrolling controls into view.
  const layout = await page.locator('.header').evaluate(header => {
    const bounds = header.getBoundingClientRect();
    const elements = [...header.querySelectorAll('button, .header-status')];
    return {
      pageWidth: document.documentElement.scrollWidth,
      viewport: innerWidth,
      headerWidth: header.clientWidth,
      contentWidth: header.scrollWidth,
      clipped: elements.filter(element => {
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return box.left < 0 || box.right > innerWidth + 1 || box.top < bounds.top ||
          box.bottom > bounds.bottom + 1 || !hit || !element.contains(hit);
      }).map(element => element.textContent.trim()),
    };
  });
  expect(layout.clipped, 'every toolbar/nav/status control must be fully on-screen and unobscured').toEqual([]);
  expect(layout.contentWidth, 'header must not hide horizontal overflow').toBeLessThanOrEqual(layout.headerWidth);
  expect(layout.pageWidth, 'page must not overflow horizontally').toBeLessThanOrEqual(layout.viewport);
}

for (const width of [820, 1280]) {
  test(`real App header controls remain reachable at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mount(page);
    await page.screenshot({ path: testInfo.outputPath(`header-${width}-initial.png`) });
    await expectHeaderFits(page);

    const header = page.locator('header.header');
    const names = ['🧩 Program', '🎮 Live Control', '🎯 Challenges', '🏆 0', '⚙️ Setup'];
    for (const name of names) {
      const button = header.getByRole('button', { name, exact: true });
      await button.click();
      await expect(button).toHaveClass(/tab-active/);
      await expectHeaderFits(page);
    }
    // Check keyboard reachability as well as pointer hit targets.
    await header.getByTitle('Click to rename').focus();
    for (const title of ['Save project', 'Project menu', 'New project', 'Switch child profile']) {
      await page.keyboard.press('Tab');
      await expect(header.getByTitle(title, { exact: true })).toBeFocused();
    }
    for (const name of names) {
      await page.keyboard.press('Tab');
      await expect(header.getByRole('button', { name, exact: true })).toBeFocused();
    }
    await page.keyboard.press('Tab');
    await expect(header.getByTitle('Unmute sounds')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(header.getByTitle('Mute sounds')).toBeVisible();

    for (const [title, menu] of [['Project menu', '.project-dropdown'], ['Switch child profile', '.profile-dropdown']]) {
      await header.getByTitle(title, { exact: true }).click();
      await expect(header.locator(menu)).toBeInViewport({ ratio: 1 });
      await header.getByTitle(title, { exact: true }).click();
    }
    await header.getByRole('button', { name: '🎯 Challenges', exact: true }).click();
    await expect(page.locator('.challenge-card').first()).toBeVisible();
    await expectHeaderFits(page);
    if (width === 1280) {
      const centers = await header.evaluate(element => [...element.children].map(child => {
        const box = child.getBoundingClientRect();
        return box.y + box.height / 2;
      }));
      expect(Math.max(...centers) - Math.min(...centers), 'desktop keeps its existing single-row layout').toBeLessThan(2);
    }
    await expect(header.getByRole('button', { name: '🎯 Challenges', exact: true })).toHaveClass(/tab-active/);
    await page.screenshot({ path: testInfo.outputPath(`header-${width}-challenges.png`), animations: 'disabled' });
    expect(fixture.unexpected, 'no unhandled HTTP or physical commands').toEqual([]);
    // Setup probes local mLink discovery; these sockets are intercepted too.
    const discoveryOnly = fixture.socketMessages.every(message => {
      const data = JSON.parse(message);
      return (data.jsonrpc === '2.0' && data.method === 'rpc.discover') ||
        (data.service === 'data-channel' && data.method === 'list' && JSON.stringify(data.params) === '["serialport"]');
    });
    expect(discoveryOnly, 'navigation must not dispatch robot commands').toBe(true);
    expect(fixture.errors).toEqual([]);
  });
}
