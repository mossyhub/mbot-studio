// Real editor + admission validators only. No app server, MQTT or hardware calls.
import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { MqttService } from '../server/src/services/mqtt-service.js';

const status = { build: 'mbot-av-control-v1', capabilities: ['dc_motor', 'servo'],
  application: 'cooperative-v1', motion_enabled: true, armed: true };
const config = { additions: [{ type: 'dc_motor', port: 'M1', label: 'Claw', actions: [
  // Same configured powers/durations as the deployed M1 claw (read-only API check).
  { name: 'open', motorDirection: 'reverse', speed: 100, duration: 4.4 },
  { name: 'close', motorDirection: 'forward', speed: 100, duration: 4.1 },
] }] };
let bundle;
test.beforeAll(async () => {
  bundle = (await build({ stdin: { contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import Editor from './web/src/components/BlocklyEditor.jsx';
    const root = createRoot(document.getElementById('root'));
    window.mount = (blocks, robotStatus, robotConfig) => {
      window.config = robotConfig;
      root.render(React.createElement(Editor, {blocks, robotStatus, robotConfig,
        onBlocksChange: b => { window.saved = b; window.edits = (window.edits || 0) + 1; }}));
    };
  `, resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'jsx' },
  bundle: true, write: false, format: 'iife', loader: { '.css': 'empty' }, logLevel: 'silent' })).outputFiles[0].text;
});
async function mount(page, blocks = [], robotStatus = status, robotConfig = config) {
  await page.route('**/*', route => route.request().url() === 'http://hardware.test/'
    ? route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }) : route.abort());
  await page.goto('http://hardware.test/');
  await page.addStyleTag({ content: '#root{display:flex;height:700px}' + readFileSync(new URL('../web/src/components/BlocklyEditor.css', import.meta.url), 'utf8') });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(args => window.mount(...args), [blocks, robotStatus, robotConfig]);
  await page.getByRole('button', { name: /My Robot/ }).click();
}
async function dragAction(page, name) {
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  const action = page.locator('.se-palette-list .se-block-shape').filter({ hasText: name });
  await expect(action).toHaveAttribute('aria-disabled', 'false');
  await expect(action).toHaveAttribute('draggable', 'true');
  await action.dispatchEvent('dragstart', { dataTransfer: transfer });
  await page.locator('.se-script.main > [data-arr-slot]').last().dispatchEvent('drop', { dataTransfer: transfer });
  await transfer.dispose();
  return page.evaluate(() => window.saved);
}
function validator() {
  const service = new MqttService();
  service.robotStatusMetadata = status;
  service.robotLastSeen = service.robotStatusLastSeen = Date.now();
  return service;
}
function firmwareValidate(blocks) {
  const result = spawnSync('python3', ['-c', `import json,sys
from firmware.robot_control import validate
print(json.dumps(validate(json.load(sys.stdin))))`], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    input: JSON.stringify(blocks), encoding: 'utf8', timeout: 10000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

test('new claw actions use runtime power bounds in both directions and pass real validators', async ({ page }) => {
  const service = validator();
  for (const speed of [-100, 100]) {
    expect(() => service.validateCooperativeProgram([{ type: 'dc_motor', port: 'M1', speed, duration: 1 }])).toThrow(/speed/);
  }
  await mount(page);
  await dragAction(page, 'Claw: open');
  const blocks = await dragAction(page, 'Claw: close');
  expect(blocks.map(b => b.speed)).toEqual([-50, 50]);
  expect(blocks.map(b => [b.type, b.port, b.duration])).toEqual([
    ['dc_motor', 'M1', 4.4], ['dc_motor', 'M1', 4.1],
  ]);
  expect(() => service.validateCooperativeProgram(blocks)).not.toThrow();
  expect(firmwareValidate(blocks).map(b => b.speed)).toEqual([-50, 50]);
  expect(await page.evaluate(() => window.config)).toEqual(config);
  expect(service.client).toBeNull();
});

test('runtime transitions refresh only new action defaults, never imported or existing program values', async ({ page }) => {
  const stored = [{ type: 'dc_motor', port: 'M1', speed: -100, duration: 4.4, _id: 'imported' },
    { type: 'repeat', times: 2, do: [{ type: 'dc_motor', port: 'M1', speed: 75, duration: 1, _id: 'nested' }], _id: 'loop' }];
  await mount(page, stored, null);
  expect(await page.evaluate(() => window.saved)).toBeUndefined();
  const legacy = await dragAction(page, 'Claw: close');
  expect(legacy.at(-1).speed).toBe(100);
  const edits = await page.evaluate(() => window.edits);
  // Keep the identical config reference: memoization must react to status alone.
  await page.evaluate(s => window.mount(window.saved, s, window.config), status);
  await expect(page.locator('.se-palette-controls')).toContainText('Type support only');
  expect(await page.evaluate(() => window.edits)).toBe(edits);
  const av = await dragAction(page, 'Claw: open');
  expect(av.slice(0, -1)).toEqual(legacy);
  expect(av.at(-1).speed).toBe(-50);
  expect(av.slice(0, 2)).toEqual(stored);
  expect(() => validator().validateCooperativeProgram([av[0]])).toThrow(/speed/);
  await page.evaluate(() => window.mount(window.saved, null, window.config));
  await expect(page.locator('.se-palette-controls')).toContainText('Runtime unverified');
  const unknown = await dragAction(page, 'Claw: open');
  expect(unknown.slice(0, -1)).toEqual(av);
  expect(unknown.at(-1).speed).toBe(-100);
  expect(await page.evaluate(() => window.config)).toEqual(config);
});

test('known unsupported actions and invalid unknown-runtime actions remain unavailable without edits', async ({page}) => {
  await mount(page, [], {...status, capabilities:['servo']});
  await expect(page.locator('.se-palette-list')).not.toContainText('Claw: close');
  await page.getByRole('button',{name:'All blocks',exact:true}).click();
  const action = page.locator('.se-palette-list .se-block-shape').filter({hasText:'Claw: close'});
  await expect(action).toHaveAttribute('aria-disabled','true');
  await expect(action).toHaveAttribute('draggable','false');
  await expect(action).toContainText('does not advertise');
  const missingPort = structuredClone(config);
  delete missingPort.additions[0].port;
  await page.evaluate(args => window.mount(...args), [[], null, missingPort]);
  await expect(action).toHaveAttribute('aria-disabled','true');
  await expect(action).toHaveAttribute('draggable','false');
  await expect(action).toContainText('Repair this action in Setup');
  expect(await page.evaluate(() => window.saved)).toBeUndefined();
  expect(await page.evaluate(() => window.config)).toEqual(missingPort);
});

test('bounded powers, explicit zero, missing defaults and servo actions retain their semantics', async ({ page }) => {
  const robotConfig = { additions: [
    { type: 'dc_motor', port: 'M2', label: 'Motor', actions: [
      { name: 'gentle', motorDirection: 'reverse', speed: 25, duration: 0.5 },
      { name: 'zero', speed: 0, duration: 0 },
      { name: 'boundary', speed: 50, duration: 5 },
      { name: 'missing' },
    ] },
    { type: 'servo', port: 'S1', label: 'Arm', actions: [{ name: 'ground', angle: 56 }] },
  ] };
  await mount(page, [], status, robotConfig);
  for (const name of ['Motor: gentle', 'Motor: zero', 'Motor: boundary', 'Motor: missing', 'Arm: ground']) {
    await dragAction(page, name);
  }
  const blocks = await page.evaluate(() => window.saved);
  expect(blocks.map(({ _id, ...block }) => block)).toEqual([
    { type: 'dc_motor', port: 'M2', speed: -25, duration: 0.5 },
    { type: 'dc_motor', port: 'M2', speed: 0, duration: 0 },
    { type: 'dc_motor', port: 'M2', speed: 50, duration: 5 },
    { type: 'dc_motor', port: 'M2', speed: 50, duration: 1 },
    { type: 'servo', port: 'S1', angle: 56 },
  ]);
  expect(() => validator().validateCooperativeProgram(blocks)).not.toThrow();
  expect(firmwareValidate(blocks)).toHaveLength(5);
  expect(await page.evaluate(() => window.config)).toEqual(robotConfig);
});
