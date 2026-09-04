// Real HTTP routers + MQTT service, isolated from devices, user config and AI.
// Run with: node --test tests/backend-regressions.test.js
// Requires python3 for artifact-only Python syntax/literal checks.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const express = require('express');
const { Aedes } = require('aedes');
const prefix = 'backend-regression-only';
const packets = [];
let broker, tcp, server, mqtt, base, dataDir, configPath;
const envKeys = ['DATA_DIR', 'AI_LOCAL_DEBUG', 'ENABLE_REPL', 'MQTT_BROKER_URL', 'MQTT_TOPIC_PREFIX'];
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const originalLog = console.log;

before(async () => {
  // Keep application logs visible on stderr, off node:test's binary stdout pipe.
  // Older Node runners can corrupt that pipe with emoji-prefixed application logs:
  // https://github.com/nodejs/node/issues/64061
  console.log = (...args) => console.error(...args);
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbot-backend-regression-'));
  configPath = path.join(dataDir, 'robot-config.json');
  process.env.DATA_DIR = dataDir;
  process.env.AI_LOCAL_DEBUG = 'true';
  process.env.ENABLE_REPL = 'false';
  process.env.MQTT_TOPIC_PREFIX = prefix;
  broker = await Aedes.createBroker();
  tcp = net.createServer(broker.handle);
  tcp.listen(0, '127.0.0.1');
  await once(tcp, 'listening');
  process.env.MQTT_BROKER_URL = `mqtt://127.0.0.1:${tcp.address().port}`;
  // Import production modules only after every isolation variable is set.
  const { MqttService } = await import('../server/src/services/mqtt-service.js');
  const { configRoutes } = await import('../server/src/routes/config.js');
  const { robotRoutes } = await import('../server/src/routes/robot.js');
  mqtt = MqttService.getInstance();
  broker.on('publish', (packet, client) => {
    if (client && packet.topic.startsWith(`${prefix}/robot/`)) {
      packets.push({ topic: packet.topic, payload: JSON.parse(packet.payload.toString()) });
    }
  });
  const app = express();
  app.use(express.json());
  app.use('/api/config', configRoutes);
  app.use('/api/robot', robotRoutes);
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
  server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  await mqtt.connect();
  // SUBACK establishes readiness without sleeps or an actual robot.
  await mqtt.client.subscribeAsync(`${prefix}/robot/status`);
});

after(async () => {
  console.log = originalLog;
  if (mqtt?.client) await mqtt.client.endAsync(true);
  if (server) await new Promise(resolve => server.close(resolve));
  if (broker) await new Promise(resolve => broker.close(resolve));
  if (tcp) await new Promise(resolve => tcp.close(resolve));
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function request(method, route, input) {
  const response = await fetch(base + route, {
    method, headers: { 'content-type': 'application/json' },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    signal: AbortSignal.timeout(5000),
  });
  return { status: response.status, body: await response.json() };
}

async function send(route, input) {
  const start = packets.length;
  const result = await request('POST', route, input);
  // A QoS1 marker on the same socket fences all preceding outgoing packets.
  await mqtt.client.publishAsync(`${prefix}/barrier`, '{}', { qos: 1 });
  return { ...result, published: packets.slice(start) };
}

function published(result, suffix) {
  return result.published.filter(packet => packet.topic === `${prefix}/robot/${suffix}`);
}

test('B1 explicitly empty additions survive save/read and do not prepend servo commands', async () => {
  const fresh = await request('GET', '/api/config');
  assert.deepEqual(fresh.body.additions.map(item => item.port), ['S1', 'S2']);
  const save = await send('/api/config', { name: 'Bare robot', additions: [] });
  assert.equal(save.status, 200);
  assert.deepEqual(save.body.config.additions, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')).additions, []);
  assert.deepEqual(published(save, 'config')[0].payload.additions, []);
  const reload = await request('GET', '/api/config');
  const program = [{ type: 'wait', duration: 0.1 }];
  const run = await send('/api/robot/program', { program });
  assert.equal(run.body.sent, true);
  assert.deepEqual(reload.body.additions, []);
  assert.deepEqual(published(run, 'program')[0].payload.program, program);
});

test('B2 test-action preserves explicit zero angle, speed and duration; absent fields still default', async () => {
  const cases = [
    { type: 'servo', port: 'S1', action: { angle: 0 }, expected: { angle: 0 } },
    { type: 'dc_motor', port: 'M1', action: { speed: 0, duration: 0 }, expected: { speed: 0, duration: 0 } },
    { type: 'dc_motor', port: 'M1', action: { motorDirection: 'reverse', speed: 0, duration: 0 }, expected: { speed: 0, duration: 0 } },
    { type: 'servo', port: 'S1', action: {}, expected: { angle: 90 } },
    { type: 'dc_motor', port: 'M1', action: {}, expected: { speed: 50, duration: 1 } },
    { type: 'dc_motor', port: 'M1', action: { motorDirection: 'reverse', speed: 25, duration: 2 }, expected: { speed: -25, duration: 2 } },
  ];
  const results = [];
  for (const { expected, ...input } of cases) {
    const result = await send('/api/robot/test-action', input);
    assert.equal(result.status, 200);
    assert.equal(result.body.sent, true);
    results.push({ expected: { type: input.type, port: input.port, ...expected }, http: result.body.command, mqtt: published(result, 'command')[0].payload });
  }
  // Collect both actuator cases before asserting so the RED run exercises each.
  assert.deepEqual(results.map(item => item.http), results.map(item => item.expected));
  assert.deepEqual(results.map(item => item.mqtt), results.map(item => item.expected));
});

test('B4 HTTP REPL rejects disabled requests without publishing and allows explicitly enabled control', async () => {
  const input = { code: 'print("LOCAL_TEST_NO_DEVICE")', id: 'backend-repl-control' };
  try {
    process.env.ENABLE_REPL = 'false';
    const disabled = await send('/api/robot/repl', input);
    process.env.ENABLE_REPL = 'true';
    const enabled = await send('/api/robot/repl', input);
    assert.equal(enabled.status, 200);
    assert.equal(enabled.body.sent, true);
    assert.deepEqual(published(enabled, 'repl').map(item => item.payload), [input]);
    assert.equal(disabled.status, 403);
    assert.match(disabled.body.error, /REPL.*disabled/i);
    assert.deepEqual(published(disabled, 'repl'), []);
  } finally {
    process.env.ENABLE_REPL = 'false';
  }
});

test('B7 malformed config structures are rejected before disk, hardware state or MQTT changes', async (t) => {
  const hardware = { port: 'M1', type: 'dc_motor', feedbackType: 'none', states: ['home'], actions: [], settings: {}, metadata: { vendor: 'kept' } };
  const valid = {
    name: 'Validation control', additions: [hardware, { port: 'P1', type: 'color_sensor' }],
    notes: 'Preserve metadata', physicalDescription: 'Test fixture', turnMultiplier: 1,
    constraints: ['Keep clear'], taskPatterns: [{ trigger: 'wave', sequence: 'wait', custom: true }],
    calibrations: { forward: [{ speed: 20, duration: 1, distance_inches: 2, note: 'kept' }] },
  };
  const cases = [
    ['root array', '/api/config', []],
    ['root null', '/api/config', null],
    ['additions object', '/api/config', { additions: {} }],
    ['additions null', '/api/config', { additions: null }],
    ['null addition', '/api/config', { additions: [null] }],
    ['array addition', '/api/config', { additions: [[]] }],
    ['missing port', '/api/config', { additions: [{ type: 'servo' }] }],
    ['invalid type shape', '/api/config', { additions: [{ port: 'S1', type: {} }] }],
    ['actions object', '/api/config', { additions: [{ ...hardware, actions: {} }] }],
    ['null action', '/api/config', { additions: [{ ...hardware, actions: [null] }] }],
    ['array action', '/api/config', { additions: [{ ...hardware, actions: [[]] }] }],
    ['states string', '/api/config', { additions: [{ ...hardware, states: 'home' }] }],
    ['invalid state member', '/api/config', { additions: [{ ...hardware, states: [null] }] }],
    ['settings array', '/api/config', { additions: [{ ...hardware, settings: [] }] }],
    ['constraints string', '/api/config', { constraints: 'must be an array' }],
    ['taskPatterns null entry', '/api/config', { taskPatterns: [null] }],
    ['calibrations array', '/api/config', { calibrations: [] }],
    ['calibration entries object', '/api/config', { calibrations: { forward: {} } }],
    ['calibration null entry', '/api/config', { calibrations: { forward: [null] } }],
    ['name object', '/api/config', { name: {} }],
    ['turn multiplier object', '/api/config', { turnMultiplier: {} }],
    ['addition endpoint invalid actions', '/api/config/addition', { port: 'S3', type: 'servo', actions: [null] }],
    ['addition endpoint invalid states', '/api/config/addition', { port: 'S3', type: 'servo', states: {} }],
  ];
  for (const [label, route, input] of cases) {
    await t.test(label, async () => {
      const save = await send('/api/config', valid);
      assert.equal(save.status, 200);
      const beforeBytes = fs.readFileSync(configPath);
      const beforeStates = (await request('GET', '/api/robot/hardware-state')).body;
      const rejected = await send(route, input);
      assert.deepEqual(fs.readFileSync(configPath), beforeBytes, 'rejected input must leave persisted bytes unchanged');
      assert.equal(rejected.status, 400);
      assert.equal(typeof rejected.body.error, 'string');
      assert.deepEqual(published(rejected, 'config'), []);
      assert.deepEqual((await request('GET', '/api/robot/hardware-state')).body, beforeStates);
      assert.deepEqual((await request('GET', '/api/config')).body, save.body.config);
    });
  }
  await t.test('valid partial update and addition preserve optional metadata', async () => {
    const save = await send('/api/config', valid);
    assert.equal(save.status, 200);
    assert.deepEqual(published(save, 'config')[0].payload, save.body.config);
    for (const [key, value] of Object.entries(valid)) assert.deepEqual(save.body.config[key], value);
    const update = await send('/api/config', { notes: 'updated' });
    assert.equal(update.status, 200);
    assert.deepEqual(update.body.config.additions, valid.additions);
    const extra = { port: 'S3', type: 'servo', actions: [{ name: 'zero', angle: 0, metadata: { kept: true } }], custom: ['kept'] };
    const add = await send('/api/config/addition', extra);
    assert.equal(add.status, 200);
    assert.deepEqual(add.body.config.additions.at(-1), extra);
    assert.deepEqual((await request('GET', '/api/config')).body, add.body.config);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), add.body.config);
    assert.deepEqual(published(add, 'config')[0].payload, add.body.config);
  });
});

test('B8 firmware settings round-trip as Python literals without replacement expansion or new source lines', async (t) => {
  const fields = { wifiSsid: 'WIFI_SSID', wifiPassword: 'WIFI_PASSWORD', mqttBroker: 'MQTT_BROKER', topicPrefix: 'MQTT_TOPIC_PREFIX', clientId: 'MQTT_CLIENT_ID' };
  const cases = [
    ['ordinary control', 'ordinary-value'],
    ['dollar dollar', 'safe$$pass'],
    ['dollar ampersand', 'safe$&pass'],
    ['replacement prefix and suffix', "safe$`middle$'end"],
    ['quote and backslash control', 'quote"and\\slash'],
    ['newline and control characters', 'line1\nline2\r\n\t\0\b\fend'],
    ['non-ASCII control', 'café-机器人-🤖'],
  ];
  for (const [label, value] of cases) {
    await t.test(label, async () => {
      const settings = Object.fromEntries(Object.keys(fields).map(key => [key, value]));
      const result = await send('/api/config/firmware/bundle', { settings });
      assert.equal(result.status, 200);
      assert.deepEqual(result.published, []);
      assert.equal(result.body.files.length, 1);
      const source = result.body.files[0].content;
      // Parse/compile the actual returned artifact; evaluate ONLY constant assignments.
      // Firmware imports and hardware code are never executed.
      const checked = spawnSync('python3', ['-c', `
import ast, json, sys
source = sys.stdin.read()
tree = ast.parse(source)
compile(tree, '<firmware-bundle>', 'exec')
names = set(json.loads(sys.argv[1]))
values = {}
for node in tree.body:
    if isinstance(node, ast.Assign) and len(node.targets) == 1:
        target = node.targets[0]
        if isinstance(target, ast.Name) and target.id in names:
            values[target.id] = ast.literal_eval(node.value)
print(json.dumps(values))
`, JSON.stringify(Object.values(fields))], { input: source, encoding: 'utf8', timeout: 5000 });
      assert.ifError(checked.error);
      assert.equal(checked.status, 0, checked.stderr);
      assert.deepEqual(JSON.parse(checked.stdout), Object.fromEntries(Object.values(fields).map(key => [key, value])));
    });
  }
});

async function robotMessage(topic, payload) {
  const body = JSON.stringify(payload);
  await new Promise((resolve, reject) => {
    const id = 'backend-regression-message';
    const timer = setTimeout(() => {
      mqtt.removeListener(id);
      reject(new Error(`Did not receive ${topic} through MQTT`));
    }, 5000);
    mqtt.onMessage(id, (receivedTopic, receivedBody) => {
      if (receivedTopic !== topic || receivedBody !== body) return;
      clearTimeout(timer);
      mqtt.removeListener(id);
      resolve();
    });
    broker.publish({ topic: `${prefix}/${topic}`, payload: Buffer.from(body), qos: 0, retain: false }, error => {
      if (!error) return;
      clearTimeout(timer);
      mqtt.removeListener(id);
      reject(error);
    });
  });
}

test('B10 explicit offline overrides recent presence and a subsequent ready status restores online', async () => {
  assert.equal((await request('GET', '/api/robot/status')).body.robotOnline, false);
  await robotMessage('robot/status', { status: 'ready' });
  const ready = (await request('GET', '/api/robot/status')).body;
  await robotMessage('robot/status', { status: 'offline' });
  const offline = (await request('GET', '/api/robot/status')).body;
  await robotMessage('robot/log', { message: 'disconnected' });
  const afterLog = (await request('GET', '/api/robot/status')).body;
  await robotMessage('robot/status', { status: 'ready' });
  const reconnected = (await request('GET', '/api/robot/status')).body;
  assert.equal(ready.mqttConnected, true);
  assert.equal(ready.robotOnline, true);
  assert.equal(ready.robotState, 'ready');
  assert.equal(offline.mqttConnected, true);
  assert.equal(typeof offline.robotLastSeen, 'number');
  assert.equal(offline.robotState, 'offline');
  assert.equal(reconnected.robotOnline, true);
  assert.equal(reconnected.robotState, 'ready');
  assert.equal(offline.robotOnline, false);
  assert.equal(afterLog.robotOnline, false);
});
