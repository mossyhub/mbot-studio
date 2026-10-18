import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { MqttService } from '../server/src/services/mqtt-service.js';
import { lowerProgram } from '../server/src/services/program-lowering.js';
const root = fileURLToPath(new URL('..', import.meta.url));
const base = { application: 'cooperative-v1', build: 'mbot-av-control-v1', armed: true, motion_enabled: true,
  capabilities: ['turn_left', 'turn_right', 'turn_angle_360'] };
const calibrated = { ...base, capabilities: [...base.capabilities, 'chassis_turn_calibrated_v1'] };
let bundle;
test.beforeAll(async () => {
  bundle = (await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom'; import Editor from './web/src/components/BlocklyEditor.jsx';
    const root=createRoot(document.getElementById('root'));
    window.mount=(blocks,robotStatus)=>flushSync(()=>root.render(<Editor blocks={blocks} robotStatus={robotStatus}
      robotConfig={{additions:[]}} onBlocksChange={b=>{window.saved=b;window.edits=(window.edits||0)+1}}/>));`,
    resolveDir: root, loader: 'jsx' }, bundle: true, write: false, format: 'iife', loader: { '.css': 'empty' } })).outputFiles[0].text;
});
for (const direction of ['left', 'right']) test(`${direction}: actual editor changes only labels/bounds, never imported angles`, async ({ page }) => {
  const unexpected = [], errors = [];
  await page.route('**/*', r => r.request().url() === 'http://turn.test/'
    ? r.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' })
    : (unexpected.push(r.request().url()), r.abort()));
  await page.routeWebSocket('**/*', ws => { unexpected.push(ws.url()); ws.close(); });
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://turn.test/');
  await page.addScriptTag({ content: bundle });
  const source = [{ type: 'repeat', times: 1, do: [{ type: `turn_${direction}`, params: { angle: 360 }, _id: 'saved-turn' }] }];
  const group = page.getByRole('group', { name: `turn ${direction} block`, exact: true });
  const input = group.locator('[data-target-key="angle"] input[type=number]');
  for (const [status, max, label] of [[null,360,'native angle'],[base,360,'native angle'],[calibrated,180,'target angle'],[base,360,'native angle'],[calibrated,180,'target angle']]) {
    await page.evaluate(([b,s]) => window.mount(b,s), [source,status]);
    expect(errors).toEqual([]);

    await expect(group).toBeVisible();
    await expect(input).toHaveAttribute('max', String(max));
    await expect(input).toHaveValue('360');
    await expect(group.locator('.se-slot-label').filter({ hasText: label })).toBeVisible();
    expect(await page.evaluate(() => window.edits || 0)).toBe(0);
    if (max === 180) {
      await expect(input).toHaveAttribute('min', '0');
      expect(await input.evaluate(e => e.checkValidity())).toBe(false);
      await expect(group.locator('.se-slot-pair[title]')).toHaveAttribute('title', /current chassis.*approximate.*surface/i);
      await expect(group.locator('.se-slot-pair[title]')).toHaveAttribute('title', /215.*198.*provisional/i);
    }
  }
  await input.fill('180');
  const edited = await page.evaluate(() => window.saved);
  expect(edited[0].do[0]).toEqual({ type: `turn_${direction}`, params: { angle: 180 }, _id: 'saved-turn' });
  const mqtt = new MqttService(); mqtt.robotStatusMetadata = calibrated;
  mqtt.robotLastSeen = mqtt.robotStatusLastSeen = Date.now();
  expect(() => lowerProgram(edited, { validateBlock: b => mqtt.validateCooperativeProgram([b]) })).not.toThrow();
  expect(source[0].do[0].params.angle).toBe(360);
  expect(errors).toEqual([]); expect(unexpected).toEqual([]); expect(mqtt.client).toBeNull();
});
