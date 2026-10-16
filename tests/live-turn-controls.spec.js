import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { MqttService } from '../server/src/services/mqtt-service.js';

// Real React button -> intercepted WebSocket -> real server/firmware admission.
// No app server, MQTT connection, firmware IO, or physical robot is involved.
const root = fileURLToPath(new URL('..', import.meta.url));
let bundle;
test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { flushSync } from 'react-dom';
        import LiveControl from './web/src/components/LiveControl.jsx';
        flushSync(() => createRoot(document.getElementById('root')).render(
          <LiveControl robotConnected={true} robotConfig={{}} onStop={() => {}} />));`,
      resolveDir: root, loader: 'jsx',
    },
    bundle: true, write: false, format: 'iife', loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"development"' },
  });
  bundle = result.outputFiles[0].text;
});

function admission(build) {
  const service = new MqttService();
  service.robotStatusMetadata = {
    application: 'cooperative-v1', build, capabilities: ['turn_left', 'turn_right'],
    armed: true, motion_enabled: true,
  };
  service.robotLastSeen = service.robotStatusLastSeen = Date.now();
  return service;
}

for (const build of ['mbot-av-control-v1', 'mbot-motor-control-v1']) {
  for (const direction of ['left', 'right']) {
    test(`${build}: live ${direction} emits one bounded firmware-compatible turn`, async ({ page }) => {
      const service = admission(build);
      const commands = [], errors = [], unexpected = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        const { pathname } = new URL(route.request().url());
        if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
        if (pathname === '/api/robot/status') return route.fulfill({ json: service.robotStatusMetadata });
        if (pathname === '/api/robot/telemetry') return route.fulfill({ json: {} });
        unexpected.push(route.request().url());
        return route.abort();
      });
      await page.routeWebSocket('**/*', socket => socket.onMessage(data => {
        const message = JSON.parse(data);
        if (message.type === 'command') commands.push(message.command);
      }));
      await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
      await page.clock.pauseAt(new Date('2026-01-01T00:00:00Z'));
      await page.goto('http://live-turn.test/');
      await page.addScriptTag({ content: bundle });
      await expect(page.getByRole('button', { name: 'Refresh sensors', exact: true })).toBeEnabled();
      await page.locator(`.dpad-${direction}`).dispatchEvent('mousedown');
      await expect.poll(() => commands.length).toBe(1);
      service.robotLastSeen = service.robotStatusLastSeen = Date.now();
      // Regression: old buttons fail here with Unknown motor-control turn_* parameter.
      expect(() => service.validateCooperativeProgram(commands, { commandEnvelope: true })).not.toThrow();
      expect(commands).toEqual([{ type: `turn_${direction}`, angle: 30 }]);
      const validation = spawnSync('python3', ['-c',
        "import json,sys; from firmware.robot_control import validate; print(json.dumps(validate(json.loads(sys.stdin.read()))))"],
        { cwd: root, input: JSON.stringify(commands), encoding: 'utf8' });
      expect(validation.status, validation.stderr).toBe(0);
      expect(JSON.parse(validation.stdout)).toEqual(commands);
      await page.clock.runFor(1000);
      expect(commands).toHaveLength(1); // Never split a large turn into hidden native calls.
      expect(service.client).toBeNull();
      expect(errors).toEqual([]);
      expect(unexpected).toEqual([]);
    });
  }
}

test('server continues rejecting legacy turn fields and angles beyond the native bound', () => {
  for (const build of ['mbot-av-control-v1', 'mbot-motor-control-v1']) {
    const service = admission(build);
    for (const type of ['turn_left', 'turn_right']) {
      for (const invalid of [{ angle: 30, speed: 40 }, { angle: 30, duration: 1 }, { angle: 90 }, { angle: 30.1 }, { angle: -1 }]) {
        expect(() => service.validateCooperativeProgram([{ type, ...invalid }], { commandEnvelope: true })).toThrow();
      }
      expect(() => service.validateCooperativeProgram([{ type, angle: 30 }], { commandEnvelope: true })).not.toThrow();
    }
    expect(service.client).toBeNull();
  }
});
