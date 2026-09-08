// Real routers/services and a loopback MQTT broker; no device or user config.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const express = require('express');
const { Aedes } = require('aedes');
const mqttClient = require('mqtt');
const { WebSocketServer, WebSocket } = require('ws');
const prefix = 'cooperative-api-isolated';
const packets = [];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const envKeys = ['DATA_DIR', 'AI_LOCAL_DEBUG', 'MQTT_BROKER_URL', 'MQTT_TOPIC_PREFIX'];
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const originalLog = console.log;
let broker, tcp, server, wss, mqtt, peer, base, dataDir;

before(async () => {
  console.log = (...args) => console.error(...args);
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbot-cooperative-api-'));
  process.env.DATA_DIR = dataDir;
  process.env.AI_LOCAL_DEBUG = 'true';
  process.env.MQTT_TOPIC_PREFIX = prefix;
  broker = await Aedes.createBroker();
  tcp = net.createServer(broker.handle);
  tcp.listen(0, '127.0.0.1');
  await once(tcp, 'listening');
  process.env.MQTT_BROKER_URL = `mqtt://127.0.0.1:${tcp.address().port}`;
  const { MqttService } = await import('../server/src/services/mqtt-service.js');
  const { robotRoutes } = await import('../server/src/routes/robot.js');
  const { setupWebSocket } = await import('../server/src/services/websocket.js');
  mqtt = MqttService.getInstance();
  broker.on('publish', (packet, client) => {
    if (client?.id.startsWith('mbot-studio-server-') && packet.topic.startsWith(`${prefix}/robot/`)) {
      packets.push({ topic: packet.topic, payload: JSON.parse(packet.payload.toString()) });
    }
  });
  const app = express();
  app.use(express.json());
  app.use('/api/robot', robotRoutes);
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message, code: err.code }));
  server = http.createServer(app);
  wss = new WebSocketServer({ server });
  setupWebSocket(wss);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  await mqtt.connect();
  await mqtt.client.subscribeAsync(`${prefix}/robot/status`);
  peer = await mqttClient.connectAsync(process.env.MQTT_BROKER_URL);
});

after(async () => {
  if (peer) await peer.endAsync(true);
  if (mqtt?.client) await mqtt.client.endAsync(true);
  if (wss) { for (const client of wss.clients) client.terminate(); await new Promise(resolve => wss.close(resolve)); }
  if (server) await new Promise(resolve => server.close(resolve));
  if (broker) await new Promise(resolve => broker.close(resolve));
  if (tcp) await new Promise(resolve => tcp.close(resolve));
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  console.log = originalLog;
});

async function status(data) {
  const received = new Promise(resolve => mqtt.onMessage('status-test', (topic) => {
    if (topic === 'robot/status') { mqtt.removeListener('status-test'); resolve(); }
  }));
  await peer.publishAsync(`${prefix}/robot/status`, JSON.stringify(data), { qos: 1, retain: false });
  await received;
}

async function cooperative(overrides = {}) {
  await status({ status: 'ready', application: 'cooperative-v1', capabilities: ['wait', 'stop', 'display_text', 'set_led', 'repeat'], motion_enabled: false, armed: false, self_managed_homing: true, build: 'fixture-build', boot: 'fixture-boot', sha256: 'fixture-digest', ...overrides });
}

beforeEach(async () => {
  packets.length = 0;
  mqtt.resetHardwareStates();
  fs.rmSync(path.join(dataDir, 'robot-config.json'), { force: true });
  await cooperative();
});

async function request(method, route, input) {
  const response = await fetch(base + '/api/robot' + route, {
    method, headers: { 'content-type': 'application/json' },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(5000),
  });
  return { status: response.status, body: await response.json() };
}

async function send(route, input) {
  const start = packets.length;
  const result = await request('POST', route, input);
  await mqtt.client.publishAsync(`${prefix}/barrier`, '{}', { qos: 1, retain: false });
  return { ...result, published: packets.slice(start) };
}

test('cooperative sensor requests are command-only and do not require a statement capability', async () => {
  assert.equal(mqtt.requestSensors(), true);
  await mqtt.client.publishAsync(`${prefix}/barrier`, '{}', { qos: 1 });
  assert.equal(packets.length, 1);
  assert.equal(packets[0].payload.type, 'read_sensors');
  assert.match(packets[0].payload.run_id, uuid);
  assert.throws(() => mqtt.sendProgram([{ type: 'read_sensors' }]), /unsupported/i);
});

test('cooperative wrapped editor block metadata passes admission unchanged', async () => {
  const program = [{type:'wait', _id:'editor-1', params:{duration:0.1}}];
  const result = await send('/program', {program});
  assert.equal(result.status, 200);
  assert.deepEqual(result.published[0].payload.program, program);
});

const motorCapabilities = ['move_forward', 'move_backward', 'dc_motor', 'servo',
  'wait', 'stop', 'display_text', 'set_led', 'read_sensors', 'status', 'turn_left', 'turn_right'];

async function motorControl(overrides = {}) {
  await cooperative({ build: 'mbot-motor-control-v1', capabilities: motorCapabilities,
    motion_enabled: true, armed: true, ...overrides });
}

const avTypes = ['play_tone', 'play_sound', 'set_volume', 'stop_sound', 'display_animation'];
async function avControl(overrides = {}) {
  await motorControl({ build: 'mbot-av-control-v1',
    capabilities: [...motorCapabilities, ...avTypes], ...overrides });
}

test('AV build preserves strict small-runtime motor admission and palette', async () => {
  await avControl();
  await checkMotorBlock({ type: 'move_forward', speed: 51 }, { type: 'move_forward', speed: 50 });
  await checkMotorBlock({ type: 'set_led', color: 'magenta' }, { type: 'set_led', color: 'purple' });
  for (const color of ['red', 'green', 'blue', 'yellow', 'cyan', 'purple', 'white', 'orange', 'off']) {
    const command = { type: 'set_led', color };
    assertPublished(await send('/command', { command }), '/command', command);
  }
});

function assertPublished(result, route, value) {
  assert.equal(result.status, 200);
  assert.equal(result.body.sent, true);
  assert.equal(result.published.length, 1);
  assert.equal(result.published[0].topic, `${prefix}/robot${route}`);
  assert.match(result.body.run_id, uuid);
  const { run_id, timestamp, ...payload } = result.published[0].payload;
  assert.equal(run_id, result.body.run_id);
  assert.deepEqual(payload, route === '/program' ? { program: value } : value);
}

test('motor-control admission caps a flat program at 32 blocks without disabling valid sends', async () => {
  await motorControl();
  const tooMany = Array.from({ length: 33 }, () => ({ type: 'wait', duration: 0 }));
  const rejected = await send('/program', { program: tooMany });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.code, 'COOPERATIVE_INVALID');
  assert.deepEqual(rejected.published, []);
  const valid = tooMany.slice(0, 32);
  assertPublished(await send('/program', { program: valid }), '/program', valid);
  // The full engine still accepts programs beyond the small app's limit.
  await cooperative();
  assertPublished(await send('/program', { program: tooMany }), '/program', tooMany);
});

// Exercise both wire forms through both real HTTP routes. Every invalid block
// is also the tail of an otherwise valid program: no prefix may be published.
async function checkMotorBlock(invalid, valid, expected = 400) {
  for (const wrapped of [false, true]) {
    const form = ({ type, ...params }) => wrapped
      ? { type, _id: 'editor-block', params } : { type, ...params };
    for (const route of ['/command', '/program']) {
      const body = command => route === '/command' ? { command }
        : { program: [{ type: 'display_text', text: 'no partial program' }, command] };
      const rejected = await send(route, body(form(invalid)));
      assert.equal(rejected.status, expected, JSON.stringify({ route, invalid: form(invalid) }));
      assert.equal(rejected.body.code, expected === 422 ? 'COOPERATIVE_UNSUPPORTED' : 'COOPERATIVE_INVALID');
      assert.deepEqual(rejected.published, []);
      const permitted = body(form(valid));
      assertPublished(await send(route, permitted), route, permitted.command || permitted.program);
    }
  }
}

test('AV audio admission matches literal firmware bounds in both HTTP wire forms', async () => {
  await avControl();
  for (const [type, field, invalid, valid] of [
    ['play_tone', 'frequency', [99, 2001, '440', true, null, { type: 'var_get' }], [100, 440.5, 2000]],
    ['play_tone', 'duration', [-0.1, 2.1, '1', false, null, { type: 'sensor_distance' }], [0, 0.5, 2]],
    ['play_sound', 'sound', [undefined, 'Hello', 'alarm', 1, true, null, { type: 'var_get' }], ['hello', 'beeps', 'laugh', 'score']],
    ['set_volume', 'volume', [undefined, -1, 61, 0.5, '30', true, null, { type: 'sensor_distance' }], [0, 30, 60]],
  ]) {
    for (const value of invalid) await checkMotorBlock({ type, [field]: value }, { type, [field]: valid[0] });
    for (const value of valid) {
      const command = { type, params: { [field]: value } };
      assertPublished(await send('/command', { command }), '/command', command);
    }
  }
  for (const type of ['play_tone', 'play_sound', 'set_volume', 'stop_sound']) {
    const command = { type, ...(type === 'play_sound' ? { sound: 'hello' }
      : type === 'set_volume' ? { volume: 30 } : {}) };
    await checkMotorBlock({ ...command, mystery: 0 }, command);
    const program = [command];
    assertPublished(await send('/program', { program }), '/program', program);
  }
  await avControl({ capabilities: motorCapabilities });
  for (const type of avTypes.slice(0, 4)) await checkMotorBlock({ type }, { type: 'stop' }, 422);
});

test('AV animation admission validates frames, interval and expanded budgets without transforming payloads', async () => {
  await avControl();
  const animation = { type: 'display_animation', frames: ['a', 'b'], interval: 0.5 };
  for (const frames of [undefined, [], Array(13).fill('x'), 'abc', null, [false], [123], [null],
    [{ type: 'var_get' }], ['x'.repeat(129)], ['😀'.repeat(129)]]) {
    await checkMotorBlock({ ...animation, frames }, animation);
  }
  for (const interval of [0, 0.149, 2.01, '0.5', true, null, { type: 'sensor_distance' }]) {
    await checkMotorBlock({ ...animation, interval }, animation);
  }
  await checkMotorBlock({ ...animation, duration: 1 }, animation);
  for (const command of [
    { type: 'display_animation', frames: [''] },
    { ...animation, frames: ['x'.repeat(128), '😀'.repeat(128)], interval: 0.15 },
    { ...animation, frames: Array(12).fill('frame'), interval: 1 },
    { ...animation, frames: Array(6).fill('frame'), interval: 2 },
  ]) for (const wrapped of [false, true]) {
    const { type, ...params } = command;
    const block = wrapped ? { type, _id: 'animation', params } : command;
    assertPublished(await send('/command', { command: block }), '/command', block);
    assertPublished(await send('/program', { program: [block] }), '/program', [block]);
  }
  // Two display/wait statements per frame, plus every ordinary block.
  const frames12 = { ...animation, frames: Array(12).fill('f') };
  const expanded32 = [frames12, ...Array.from({ length: 8 }, () => ({ type: 'stop_sound' }))];
  for (const [invalid, valid] of [
    [[...expanded32, { type: 'stop' }], expanded32],
    [[frames12, { ...frames12, frames: Array(5).fill('f') }],
      [frames12, { ...frames12, frames: Array(4).fill('f') }]],
    [[{ ...frames12, interval: 1 }, { ...animation, frames: ['f'], interval: 0.15 }],
      [{ ...frames12, interval: 1 }]],
    [[{ ...frames12, interval: 1.01 }], [{ ...frames12, interval: 1 }]],
  ]) {
    const result = await send('/program', { program: invalid });
    assert.equal(result.status, 400);
    assert.deepEqual(result.published, []);
    assertPublished(await send('/program', { program: valid }), '/program', valid);
  }
  await avControl({ capabilities: motorCapabilities });
  await checkMotorBlock(animation, { type: 'stop' }, 422);
});

test('AV runtime command and sensor routes retain strict command-only admission', async () => {
  await avControl();
  for (const type of ['read_sensors', 'status']) {
    for (const command of [{ type }, { type, params: {} }]) {
      assertPublished(await send('/command', { command }), '/command', command);
    }
    for (const command of [{ type, speed: 0 }, { type, params: { mystery: true } }]) {
      const rejected = await send('/command', { command });
      assert.equal(rejected.status, 400);
      assert.deepEqual(rejected.published, []);
    }
    const rejected = await send('/program', { program: [{ type }] });
    assert.equal(rejected.status, 422);
    assert.deepEqual(rejected.published, []);
  }
  const unknown = await send('/command', { command: { type: 'get_status' } });
  assert.equal(unknown.status, 422);
  assert.deepEqual(unknown.published, []);
  const start = packets.length;
  assert.equal(mqtt.requestSensors(), true);
  await mqtt.client.publishAsync(`${prefix}/barrier`, '{}', { qos: 1 });
  assert.equal(packets.length, start + 1);
  assert.equal(packets.at(-1).payload.type, 'read_sensors');
  assert.match(packets.at(-1).payload.run_id, uuid);
});

test('AV wire admission includes UTF-8, escaping and the complete 8192-byte envelope', async () => {
  await avControl();
  for (const frames of [Array(12).fill('\u0001'.repeat(128))]) {
    const command = { type: 'display_animation', frames };
    for (const route of ['/command', '/program']) {
      const input = route === '/command' ? { command } : { program: [command] };
      const rejected = await send(route, input);
      assert.equal(rejected.status, 400);
      assert.match(rejected.body.error, /8192|payload/i);
      assert.deepEqual(rejected.published, []);
      const valid = { ...command, frames: ['😀'.repeat(128)] };
      assertPublished(await send(route, route === '/command' ? { command: valid } : { program: [valid] }), route,
        route === '/command' ? valid : [valid]);
    }
  }
  const program = [
    { type: 'display_animation', frames: Array(12).fill('😀'.repeat(128)) },
    { type: 'display_animation', frames: Array(4).fill('😀'.repeat(128)) },
  ];
  const oversized = await send('/program', { program });
  assert.equal(oversized.status, 400);
  assert.deepEqual(oversized.published, []);
  const valid = [program[0], { ...program[1], frames: program[1].frames.slice(0, 3) }];
  assertPublished(await send('/program', { program: valid }), '/program', valid);
  const envelopeBytes = Buffer.byteLength(JSON.stringify({ type: 'stop_sound', _id: '', run_id: '0'.repeat(36) }));
  const command = { type: 'stop_sound', _id: 'x'.repeat(8192 - envelopeBytes) };
  const accepted = await send('/command', { command });
  assertPublished(accepted, '/command', command);
  assert.equal(Buffer.byteLength(JSON.stringify(accepted.published[0].payload)), 8192);
  const rejected = await send('/command', { command: { ...command, _id: command._id + 'x' } });
  assert.equal(rejected.status, 400);
  assert.deepEqual(rejected.published, []);
  assertPublished(await send('/command', { command }), '/command', command);
});

test('AV shared WebSocket admission preserves strict fields, motion gates and freshness', async () => {
  await avControl();
  const command = { type: 'display_animation', _id: 'frames', params: { frames: ['first', 'second'], interval: 0.15 } };
  for (const invalid of [
    { ...command, mystery: true },
    { ...command, params: { ...command.params, run_id: 'nested' } },
    { ...command, params: { ...command.params, type: 'stop' } },
    { ...command, params: { ...command.params, do: [] } },
    { ...command, params: { ...command.params, interval: null } },
    { type: 'servo', port: 'S1', duration: 0 },
    { type: 'dc_motor', port: 'S1' },
  ]) {
    const rejected = await socketSend({ type: 'command', command: invalid });
    assert.equal(rejected.body.type, 'error');
    assert.deepEqual(rejected.published, []);
    const permitted = await socketSend({ type: 'command', command });
    assert.equal(permitted.body.type, 'ack');
    assert.equal(permitted.published.length, 1);
    const { run_id, ...payload } = permitted.published[0].payload;
    assert.match(run_id, uuid);
    assert.equal(run_id, permitted.body.run_id);
    assert.deepEqual(payload, command);
  }
  for (const flags of [{ motion_enabled: false }, { armed: false }]) {
    await avControl(flags);
    const rejected = await send('/command', { command: { type: 'servo', port: 'S1', angle: 0 } });
    assert.equal(rejected.status, 409);
    assert.deepEqual(rejected.published, []);
    assertPublished(await send('/command', { command }), '/command', command);
  }
  mqtt.robotStatusLastSeen = Date.now() - 16000;
  for (const stale of [command, { type: 'read_sensors' }]) {
    const rejected = await send('/command', { command: stale });
    assert.equal(rejected.status, 503);
    assert.deepEqual(rejected.published, []);
  }
  await avControl();
  assertPublished(await send('/command', { command }), '/command', command);
  assert.deepEqual(mqtt.getHardwareStates(), {});
});

const nonNumbers = ['20', true, null, { type: 'sensor_distance' }];
for (const [build, control] of [['motor-control', motorControl], ['AV', avControl]])
for (const [type, baseParams, field, invalid, valid] of [
  ['move_forward', {}, 'speed', [-0.1, 50.1, ...nonNumbers], [0, 20.5, 50]],
  ['move_backward', {}, 'speed', [-0.1, 50.1, ...nonNumbers], [0, 20.5, 50]],
  ['dc_motor', { port: 'M1' }, 'speed', [-50.1, 50.1, ...nonNumbers], [-50, 0, 50]],
  ...['move_forward', 'move_backward', 'dc_motor'].map(type =>
    [type, type === 'dc_motor' ? { port: 'M1' } : {}, 'duration', [-0.1, 5.1, ...nonNumbers], [0, 0.5, 5]]),
  ['servo', { port: 'S1' }, 'angle', [-0.1, 180.1, ...nonNumbers], [0, 90.5, 180]],
  ['servo', { port: 'S1' }, 'speed', [-0.1, 0.1, ...nonNumbers], [0]],
  ['display_text', { text: 'hello' }, 'size', [7, 33, ...nonNumbers], [8, 14.5, 32]],
  ['display_text', {}, 'text', ['x'.repeat(129), '😀'.repeat(129), 123, false, null, { type: 'var_get', name: 'x' }], ['', 'x'.repeat(128), '😀'.repeat(128)]],
  ['wait', {}, 'duration', [-0.1, 60.1, ...nonNumbers], [0, 0.5, 60]],
  ...['turn_left', 'turn_right'].map(type => [type, {}, 'angle', [-0.1, 30.1, ...nonNumbers], [0, 15.5, 30]]),
]) {
  test(`${build} literal ${type}.${field} matches the small runtime`, async () => {
    await control();
    for (const value of invalid) {
      await checkMotorBlock({ type, ...baseParams, [field]: value },
        { type, ...baseParams, [field]: valid[0] });
    }
    for (const value of valid) {
      const command = { type, params: { ...baseParams, [field]: value } };
      assertPublished(await send('/command', { command }), '/command', command);
    }
  });
}

test('motor-control requires display text, LED color and literal actuator ports', async () => {
  await motorControl();
  for (const [invalid, valid] of [
    [{ type: 'display_text' }, { type: 'display_text', text: '' }],
    [{ type: 'set_led' }, { type: 'set_led', color: 'off' }],
    ...['dc_motor', 'servo'].flatMap(type => [undefined, null, 1, true, '1', 'M0', 'M5', 'S0', 'S5', 'm1', 's1', 'ALL', { type: 'var_get', name: 'port' }]
      .map(port => [{ type, ...(port === undefined ? {} : { port }) }, { type, port: type === 'servo' ? 'S1' : 'M1' }])),
    [{ type: 'dc_motor', port: 'S1' }, { type: 'dc_motor', port: 'M1' }],
    [{ type: 'servo', port: 'M1' }, { type: 'servo', port: 'S1' }],
  ]) await checkMotorBlock(invalid, valid);
  for (const type of ['dc_motor', 'servo']) {
    for (const suffix of ['1', '2', '3', '4']) {
      const command = { type, port: (type === 'servo' ? 'S' : 'M') + suffix };
      assertPublished(await send('/command', { command }), '/command', command);
    }
  }
});

test('motor-control rejects unknown fields, nested bodies and unsupported build types even when advertised', async () => {
  await motorControl({ capabilities: [...motorCapabilities, 'repeat', 'say', 'set_speed',
    'dc_motor_position', 'set_variable', 'play_tone', 'play_sound', 'stop_sound', 'set_volume', 'display_animation'] });
  for (const command of [
    { type: 'wait', mystery: 0 }, { type: 'wait', do: [] },
    { type: 'wait', then: [{ type: 'stop' }] }, { type: 'stop', duration: 0 },
    { type: 'move_forward', angle: 0 }, { type: 'servo', port: 'S1', duration: 0 },
    ...['turn_left', 'turn_right'].flatMap(type => [{ type, speed: 0 }, { type, duration: 0 }]),
    { type: 'set_led', color: 'red', brightness: 0 },
  ]) await checkMotorBlock(command, { type: 'wait', duration: 0 });
  for (const type of ['repeat', 'say', 'set_speed', 'dc_motor_position', 'set_variable',
    'play_tone', 'play_sound', 'stop_sound', 'set_volume', 'display_animation']) {
    await checkMotorBlock({ type }, { type: 'stop' }, 422);
  }
  // Advertising a turn is necessary; support in the server is not sufficient.
  await motorControl({ capabilities: motorCapabilities.filter(type => type !== 'turn_left') });
  await checkMotorBlock({ type: 'turn_left', angle: 10 }, { type: 'turn_right', angle: 10 }, 422);
});

test('motor-control only permits actual editor and transport envelopes in their wire positions', async () => {
  await motorControl();
  const commands = [
    { type: 'wait', _id: 'editor', run_id: 'sender', duration: 0 },
    { type: 'wait', _id: 'editor', run_id: 'sender', params: { duration: 0 } },
  ];
  for (const command of commands) {
    const result = await send('/command', { command: { ...command, timestamp: 123 } });
    const { run_id, ...expected } = command; // HTTP assigns its own run ID.
    assertPublished(result, '/command', expected);
    assert.equal(result.published[0].payload.timestamp, 123);
    assertPublished(await send('/program', { program: [command] }), '/program', [command]);
  }
  for (const command of [
    { type: 'wait', params: { duration: 0, run_id: 'nested' } },
    { type: 'wait', params: { duration: 0, timestamp: 123 } },
    { type: 'wait', params: { duration: 0 }, mystery: 1 },
    { type: 'wait', params: { duration: 0 }, duration: 0 },
    { type: 'wait', params: { type: 'stop' } },
    { type: 'wait', timestamp: { type: 'sensor_distance' } },
  ]) {
    const result = await send('/command', { command });
    assert.equal(result.status, 400, JSON.stringify(command));
    assert.deepEqual(result.published, []);
    assertPublished(await send('/command', { command: { type: 'wait' } }), '/command', { type: 'wait' });
  }
  // Firmware strips timestamp from standalone commands, not program blocks.
  for (const command of commands) {
    const result = await send('/program', { program: [{ ...command, timestamp: 123 }] });
    assert.equal(result.status, 400);
    assert.deepEqual(result.published, []);
    assertPublished(await send('/program', { program: [command] }), '/program', [command]);
  }
});

test('motor-control runtime requests reject unexpected fields and unsupported get_status without disabling sensors', async () => {
  await motorControl();
  for (const type of ['read_sensors', 'status']) {
    const result = await send('/command', { command: { type, speed: 0 } });
    assert.equal(result.status, 400);
    assert.deepEqual(result.published, []);
    for (const command of [{ type }, { type, params: {} }]) {
      assertPublished(await send('/command', { command }), '/command', command);
    }
    const programResult = await send('/program', { program: [{ type }] });
    assert.equal(programResult.status, 422); // Runtime operations remain command-only.
    assert.deepEqual(programResult.published, []);
  }
  const unknown = await send('/command', { command: { type: 'get_status' } });
  assert.equal(unknown.status, 422);
  assert.deepEqual(unknown.published, []);
  assert.equal(mqtt.requestSensors(), true);
  await mqtt.client.publishAsync(`${prefix}/barrier`, '{}', { qos: 1 });
  assert.equal(packets.at(-1).payload.type, 'read_sensors');
  assert.match(packets.at(-1).payload.run_id, uuid);
});

test('motor-control admission rejects empty programs and oversized UTF-8 wire payloads atomically', async () => {
  await motorControl();
  const empty = await send('/program', { program: [] });
  assert.equal(empty.status, 400);
  assert.deepEqual(empty.published, []);
  assert.throws(() => mqtt.sendProgram([]), /1.*32|empty/i);
  const oversized = Array.from({ length: 32 }, () => ({ type: 'display_text', text: '😀'.repeat(128) }));
  const rejected = await send('/program', { program: oversized });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /8192|payload/i);
  assert.deepEqual(rejected.published, []);
  const valid = oversized.map(block => ({ ...block, text: 'x'.repeat(128) }));
  assertPublished(await send('/program', { program: valid }), '/program', valid);
  const tooLargeCommand = await send('/command', { command: { type: 'wait', _id: 'x'.repeat(8192) } });
  assert.equal(tooLargeCommand.status, 400);
  assert.deepEqual(tooLargeCommand.published, []);
  assertPublished(await send('/command', { command: { type: 'wait', _id: 'editor' } }),
    '/command', { type: 'wait', _id: 'editor' });
  await cooperative();
  assertPublished(await send('/program', { program: oversized }), '/program', oversized);
});

test('motor-control preserves defaults, motion gates, raw turns and shared WebSocket admission', async () => {
  await motorControl();
  fs.writeFileSync(path.join(dataDir, 'robot-config.json'), JSON.stringify({ turnMultiplier: 9, additions: [] }));
  const program = motorCapabilities.filter(type => !['status', 'read_sensors'].includes(type)).map(type => ({
    type, ...(type === 'servo' ? { port: 'S1' } : type === 'dc_motor' ? { port: 'M1' }
      : type === 'display_text' ? { text: '' } : type === 'set_led' ? { color: 'off' } : {}),
  }));
  assertPublished(await send('/program', { program }), '/program', program);
  for (const flags of [{ motion_enabled: false, armed: true }, { motion_enabled: true, armed: false }]) {
    await motorControl(flags);
    const result = await send('/program', { program: [{ type: 'wait' }, { type: 'turn_left', angle: 30 }] });
    assert.equal(result.status, 409);
    assert.deepEqual(result.published, []);
    assertPublished(await send('/command', { command: { type: 'stop' } }), '/command', { type: 'stop' });
  }
  await motorControl();
  const rejected = await socketSend({ type: 'command', command: { type: 'move_forward', speed: 51 } });
  assert.equal(rejected.body.type, 'error');
  assert.deepEqual(rejected.published, []);
  const command = { type: 'turn_left', angle: 30 };
  const accepted = await socketSend({ type: 'command', command });
  assert.equal(accepted.body.type, 'ack');
  assert.equal(accepted.published.length, 1);
  const { run_id, ...payload } = accepted.published[0].payload;
  assert.match(run_id, uuid);
  assert.equal(run_id, accepted.body.run_id);
  assert.deepEqual(payload, command); // Never apply legacy chassis multipliers.
  assert.deepEqual(mqtt.getHardwareStates(), {});
});

// COLORS and CAPS from firmware/robot_control.py, not the broader RobotEngine.
for (const color of ['red', 'green', 'blue', 'yellow', 'cyan', 'purple', 'white', 'orange', 'off', 'magenta']) {
  test(`mbot-motor-control-v1 LED ${color} follows the runtime palette`, async () => {
    await cooperative({
      build: 'mbot-motor-control-v1',
      capabilities: ['move_forward', 'move_backward', 'dc_motor', 'servo', 'wait',
        'stop', 'display_text', 'set_led', 'read_sensors', 'status'],
    });
    for (const command of [{ type: 'set_led', color }, { type: 'set_led', _id: 'led', params: { color } }]) {
      const program = [{ type: 'display_text', text: 'no prefix' }, command];
      for (const [route, body] of [['/command', { command }], ['/program', { program }]]) {
        const result = await send(route, body);
        if (color === 'magenta') {
          assert.equal(result.status, 400);
          assert.equal(result.body.code, 'COOPERATIVE_INVALID');
          assert.match(result.body.error, /LED color/i);
          assert.deepEqual(result.published, []);
        } else {
          assert.equal(result.status, 200);
          assert.equal(result.body.sent, true);
          assert.equal(result.published.length, 1);
          assert.match(result.body.run_id, uuid);
          const payload = result.published[0].payload;
          assert.equal(payload.run_id, result.body.run_id);
          if (route === '/program') assert.deepEqual(payload.program, program);
          else {
            const { run_id, timestamp, ...publishedCommand } = payload;
            assert.deepEqual(publishedCommand, command);
          }
        }
      }
    }
    // A rejected palette entry must not disable subsequent valid submissions.
    const control = await send('/program', { program: [{ type: 'set_led', color: 'red' }] });
    assert.equal(control.status, 200);
    assert.deepEqual(control.published[0].payload.program, [{ type: 'set_led', color: 'red' }]);
    assert.equal(control.published[0].payload.run_id, control.body.run_id);
  });
}

test('broader cooperative engine LED purple rejects atomically in flat and wrapped commands and nested programs', async () => {
  for (const command of [{ type: 'set_led', color: 'purple' }, { type: 'set_led', _id: 'led', params: { color: 'purple' } }]) {
    for (const [route, body] of [['/command', { command }], ['/program', { program: [{ type: 'display_text', text: 'no prefix' }, { type: 'repeat', times: 1, do: [command] }] }]]) {
      const result = await send(route, body);
      assert.equal(result.status, 400);
      assert.match(result.body.error, /LED color/i);
      assert.deepEqual(result.published, []);
    }
  }
  for (const color of ['red', 'green', 'blue', 'yellow', 'cyan', 'magenta', 'white', 'off']) {
    const command = { type: 'set_led', params: { color } };
    const result = await send('/command', { command });
    assert.equal(result.status, 200);
    assert.deepEqual(result.published[0].payload.params, command.params);
  }
});

test('cooperative repeat times rejects 51 and nonintegers with engine bounds in both forms', async () => {
  for (const times of [51, -1, 0.5, '2', true, null, { type: 'sensor_distance' }]) {
    for (const block of [{ type: 'repeat', times, do: [] }, { type: 'repeat', params: { times, do: [] } }]) {
      const result = await send('/program', { program: [block] });
      assert.equal(result.status, 400, JSON.stringify(block));
      assert.deepEqual(result.published, []);
    }
  }
  for (const times of [0, 1, 50]) {
    const program = [{ type: 'repeat', _id: 'repeat', params: { times, do: [{ type: 'set_led', color: 'red' }] } }];
    const result = await send('/program', { program });
    assert.equal(result.status, 200);
    assert.deepEqual(result.published[0].payload.program, program);
  }
});

for (const [type, field, invalid, valid] of [
  ['wait', 'duration', [61, -0.1, '1', true, null, { type: 'sensor_distance' }], [0, 0.5, 60]],
  ['display_text', 'size', [7, 65, '14', true, null], [8, 14.5, 64]],
  ['say', 'size', [7, 65, '14', true, null], [8, 14.5, 64]],
  ['display_text', 'text', ['x'.repeat(257), 123, null, { type: 'var_get', name: 'x' }], ['', 'x'.repeat(256), '😀'.repeat(256)]],
  ['say', 'text', ['x'.repeat(257), false, null], ['', 'hello']],
]) {
  test(`cooperative ${type} ${field} enforces literal engine bounds in both forms`, async () => {
    await cooperative({ capabilities: ['wait', 'display_text', 'say'] });
    for (const wrapped of [false, true]) {
      for (const [values, expected] of [[invalid, 400], [valid, 200]]) {
        for (const value of values) {
          const params = { [field]: value };
          const command = wrapped ? { type, _id: 'editor', params } : { type, ...params };
          const result = await send('/command', { command });
          assert.equal(result.status, expected, JSON.stringify(command));
          if (expected === 400) assert.deepEqual(result.published, []);
          else assert.equal(result.published.length, 1);
        }
      }
    }
  });
}

test('cooperative program publishes unchanged without default S1/S2 homing and correlates UUID', async () => {
  const program = [{ type: 'wait', duration: 2 }];
  const result = await send('/program', { program });
  assert.equal(result.status, 200);
  assert.equal(result.body.sent, true);
  assert.equal(result.body.blockCount, 1);
  assert.match(result.body.run_id, uuid);
  assert.deepEqual(result.published.map(packet => packet.payload.program), [program]);
  assert.equal(result.published[0].payload.run_id, result.body.run_id);
  assert.deepEqual(mqtt.getHardwareStates(), {});
  const next = await send('/program', { program });
  assert.notEqual(next.body.run_id, result.body.run_id);
});

test('program rejects an unadvertised nested type before publishing any prefix', async () => {
  const program = [{ type: 'display_text', text: 'must not send' }, { type: 'repeat', count: 2, do: [{ type: 'play_melody' }] }];
  const rejected = await send('/program', { program });
  assert.equal(rejected.status, 422);
  assert.match(rejected.body.error, /unsupported.*play_melody/i);
  assert.deepEqual(rejected.published, []);
  assert.deepEqual(mqtt.getHardwareStates(), {});
  assert.throws(() => mqtt.sendProgram(program), /unsupported.*play_melody/i);
  await mqtt.client.publishAsync(`${prefix}/barrier`, '{}', { qos: 1 });
  assert.deepEqual(packets, []);
  const control = await send('/program', { program: [{ type: 'wait', duration: 0.1 }] });
  assert.equal(control.body.sent, true);
  assert.equal(control.published.length, 1);
});

test('motion requires both advertised capability and literal enabled/armed flags before command or program send', async () => {
  const command = { type: 'servo', port: 'S1', angle: 30 };
  for (const flags of [{ motion_enabled: false, armed: false }, { motion_enabled: true, armed: false }, { motion_enabled: 'true', armed: true }]) {
    await cooperative({ capabilities: ['servo', 'wait'], ...flags });
    for (const [route, body] of [['/command', { command }], ['/program', { program: [command] }]]) {
      const result = await send(route, body);
      assert.equal(result.status, 409);
      assert.match(result.body.error, /motion.*disabled|not armed/i);
      assert.deepEqual(result.published, []);
    }
    assert.throws(() => mqtt.sendCommand(command), /motion.*disabled|not armed/i);
  }
  await cooperative({ capabilities: ['wait'], motion_enabled: true, armed: true });
  const unsupported = await send('/command', { command });
  assert.equal(unsupported.status, 422);
  assert.deepEqual(unsupported.published, []);
  await cooperative({ capabilities: ['servo'], motion_enabled: true, armed: true });
  const permitted = await send('/command', { command });
  assert.equal(permitted.status, 200);
  assert.equal(permitted.body.sent, true);
  assert.match(permitted.body.run_id, uuid);
  assert.equal(permitted.published[0].payload.run_id, permitted.body.run_id);
  assert.deepEqual(mqtt.getHardwareStates(), {});
});

async function socketSend(message) {
  const start = packets.length;
  const ws = new WebSocket(base.replace('http:', 'ws:'));
  await once(ws, 'open');
  try {
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('No explicit WebSocket response')), 1500);
      ws.on('message', bytes => {
        const data = JSON.parse(bytes.toString());
        if (['ack', 'error', 'pong', 'repl_ack', 'emergency_stop'].includes(data.type)) {
          clearTimeout(timeout);
          resolve(data);
        }
      });
    });
    ws.send(JSON.stringify(message));
    const body = await response;
    await mqtt.client.publishAsync(`${prefix}/barrier`, '{}', { qos: 1 });
    return { body, published: packets.slice(start) };
  } finally {
    ws.close();
    await once(ws, 'close');
  }
}

test('WebSocket uses the same admission gate and returns correlated acceptance, never silent rejection', async () => {
  await cooperative({ capabilities: ['wait', 'servo'] });
  for (const message of [
    { type: 'command', command: { type: 'servo', port: 'S1', angle: 0 } },
    { type: 'command', command: { type: 'unknown-command' } },
    { type: 'diagnostic' },
    { type: 'unknown-message' },
  ]) {
    const rejected = await socketSend(message);
    assert.equal(rejected.body.type, 'error');
    assert.equal(typeof rejected.body.message, 'string');
    assert.deepEqual(rejected.published, []);
  }
  const control = await socketSend({ type: 'command', command: { type: 'wait', duration: 0.1 } });
  assert.equal(control.body.type, 'ack');
  assert.match(control.body.run_id, uuid);
  assert.equal(control.published[0].payload.run_id, control.body.run_id);
});

test('admission bounds recursive trees and rejects unknown capabilities and wrapped bypasses atomically', async () => {
  await cooperative({ capabilities: ['wait', 'repeat', 'if_predicate', 'servo', 'invented', 'upload_code', 'set_variable'] });
  let deep = [{ type: 'wait' }];
  for (let i = 0; i < 8; i++) deep = [{ type: 'repeat', do: deep }];
  const cases = [
    [[{ type: 'invented' }], 422],
    [[{ type: 'upload_code', code: 'unsafe' }], 422],
    [[{ type: 'repeat', params: { do: [{ type: 'servo' }] } }], 409],
    [[{ type: 'repeat', do: [null] }], 400],
    [[{ type: 'repeat', do: 'invalid' }], 400],
    [[{ type: 'repeat', params: [] }], 400],
    [[{ type: 'wait', params: { type: 'servo' } }], 400],
    [[{ type: 'set_variable', name: 'x', value: { type: 'unavailable_reporter' } }], 422],
    [Array.from({ length: 257 }, () => ({ type: 'wait' })), 400],
    [deep, 400],
  ];
  for (const [program, statusCode] of cases) {
    const rejected = await send('/program', { program });
    assert.equal(rejected.status, statusCode, JSON.stringify(program));
    assert.equal(typeof rejected.body.error, 'string');
    assert.deepEqual(rejected.published, []);
  }
  const command = await send('/command', { command: { type: 'repeat', params: { do: [{ type: 'servo' }] } } });
  assert.equal(command.status, 409);
  assert.deepEqual(command.published, []);
  const valid = [{ type: 'set_variable', name: 'x', value: { type: 'op_add', a: 1, b: 2 } }, { type: 'repeat', params: { times: 2, do: [{ type: 'wait', duration: 0.1 }] } }];
  const control = await send('/program', { program: valid });
  assert.equal(control.status, 200);
  assert.deepEqual(control.published[0].payload.program, valid);
});

for (const [build, control] of [['cooperative', cooperative], ['motor-control', motorControl], ['AV', avControl]]) {
  test(`${build} emergency stop publishes only the dedicated topic and permits the next READY command`, async () => {
    await control();
    for (const transport of ['HTTP', 'WebSocket']) {
      const stopped = transport === 'HTTP'
        ? await send('/stop', {}) : await socketSend({ type: 'emergency_stop' });
      if (transport === 'HTTP') assert.equal(stopped.status, 200);
      else assert.equal(stopped.body.type, 'emergency_stop');
      // Both helpers fence publications on the server's MQTT socket before
      // asserting that no unsupported command-topic duplicate was queued.
      assert.deepEqual(stopped.published.map(item => item.topic), [`${prefix}/robot/emergency`]);
      const { run_id, ...payload } = stopped.published[0].payload;
      assert.match(run_id, uuid);
      assert.deepEqual(payload, { type: 'emergency_stop' });
      await control();
      const ready = { type: 'display_text', text: 'READY' };
      const next = await send('/command', { command: ready });
      assertPublished(next, '/command', ready);
      assert.notEqual(next.body.run_id, run_id);
    }
  });
}

test('legacy emergency stop retains both topic publications and its original payload', async () => {
  await status({ application: 'legacy', status: 'ready' });
  for (const transport of ['HTTP', 'WebSocket']) {
    const stopped = transport === 'HTTP'
      ? await send('/stop', {}) : await socketSend({ type: 'emergency_stop' });
    if (transport === 'HTTP') assert.equal(stopped.status, 200);
    else assert.equal(stopped.body.type, 'emergency_stop');
    assert.deepEqual(stopped.published, [
      { topic: `${prefix}/robot/emergency`, payload: { type: 'emergency_stop' } },
      { topic: `${prefix}/robot/command`, payload: { type: 'emergency_stop' } },
    ]);
  }
});

test('expired cooperative status cannot be revived by telemetry; stop remains available and a fresh status recovers', async () => {
  mqtt.robotStatusLastSeen = Date.now() - 16000;
  mqtt.robotLastSeen = Date.now(); // Other robot messages are not fresh capability evidence.
  for (const [route, body] of [['/command', { command: { type: 'wait' } }], ['/program', { program: [{ type: 'wait' }] }]]) {
    const rejected = await send(route, body);
    assert.equal(rejected.status, 503);
    assert.match(rejected.body.error, /status.*stale|offline/i);
    assert.deepEqual(rejected.published, []);
  }
  const stopped = await send('/stop', {});
  assert.equal(stopped.status, 200);
  assert.deepEqual(stopped.published.map(item => item.topic), [`${prefix}/robot/emergency`]);
  assert.match(stopped.published[0].payload.run_id, uuid);
  assert.equal(stopped.published[0].payload.type, 'emergency_stop');
  await cooperative();
  const control = await send('/command', { command: { type: 'wait', duration: 0.1 } });
  assert.equal(control.body.sent, true);
  assert.match(control.body.run_id, uuid);
});

test('sparse, malformed, offline, and new-boot statuses never restore old motion grants or enable legacy fallback', async () => {
  await cooperative({ capabilities: ['servo'], motion_enabled: true, armed: true });
  await status({ status: 'ready', application: null, boot: 'new-boot' });
  assert.equal(mqtt.getRobotStatus().application, 'cooperative-v1');
  const rebooted = await send('/command', { command: { type: 'servo' } });
  assert.notEqual(rebooted.status, 200);
  assert.deepEqual(rebooted.published, []);
  await cooperative();
  mqtt.robotStatusLastSeen = Date.now() - 16000;
  await status({ status: 'running' });
  const sparse = await send('/program', { program: [{ type: 'wait' }] });
  assert.equal(sparse.status, 503);
  assert.deepEqual(sparse.published, []);
  await cooperative({ status: 'offline' });
  const offline = await send('/command', { command: { type: 'wait' } });
  assert.equal(offline.status, 503);
  assert.deepEqual(offline.published, []);
  for (const capabilities of [null, 'wait', { supported_types: ['wait'] }]) {
    await cooperative({ capabilities });
    const malformed = await send('/command', { command: { type: 'wait' } });
    assert.equal(malformed.status, 422);
    assert.deepEqual(malformed.published, []);
  }
  await cooperative();
  assert.equal((await send('/command', { command: { type: 'wait' } })).body.sent, true);
});

test('legacy side doors cannot publish cooperative REPL, diagnostics, uploads or unadvertised test actions', async () => {
  for (const [route, input] of [
    ['/repl', { code: 'print(1)' }], ['/diagnostic', {}],
    ['/upload', { program: [{ type: 'wait' }] }],
    ['/test-action', { port: 'S1', type: 'servo', action: { angle: 0 } }],
    ['/hardware-state/home', { port: 'S1', homeState: 'home', homeAction: { type: 'servo', port: 'S1', angle: 0 } }],
  ]) {
    const result = await send(route, input);
    assert.equal(result.status, 422);
    assert.deepEqual(result.published, []);
  }
  for (const message of [{ type: 'repl', code: 'print(1)' }]) {
    const result = await socketSend(message);
    assert.equal(result.body.type, 'error');
    assert.deepEqual(result.published, []);
  }
  assert.deepEqual(mqtt.getHardwareStates(), {});
  assert.equal((await send('/command', { command: { type: 'wait' } })).body.sent, true);
});

test('advertised cooperative position and turn commands remain raw, regardless of legacy config', async () => {
  await cooperative({ capabilities: ['dc_motor_position', 'turn_left'], motion_enabled: true, armed: true, self_managed_homing: false });
  fs.writeFileSync(path.join(dataDir, 'robot-config.json'), JSON.stringify({ turnMultiplier: 9, additions: [] }));
  const program = [{ type: 'dc_motor_position', port: 'M1', position: 30 }, { type: 'turn_left', angle: 20 }];
  const result = await send('/program', { program });
  assert.equal(result.status, 200);
  assert.deepEqual(result.published[0].payload.program, program);
  for (const command of program) {
    const single = await send('/command', { command });
    assert.equal(single.body.sent, true);
    const { run_id, ...payload } = single.published[0].payload;
    assert.match(run_id, uuid);
    assert.deepEqual(payload, command);
  }
  const ws = await socketSend({ type: 'command', command: program[1] });
  assert.equal(ws.published[0].payload.angle, 20);
  assert.deepEqual(mqtt.getHardwareStates(), {});
});

test('legacy default homing and command payload/response shapes remain unchanged', async () => {
  await status({ application: 'legacy', status: 'ready' });
  assert.equal(mqtt.getRobotStatus().capabilities, undefined);
  const program = [{ type: 'wait', duration: 0.1 }];
  const run = await send('/program', { program });
  assert.deepEqual(run.body, { sent: true, blockCount: 3 });
  assert.deepEqual(run.published[0].payload.program.map(block => block.type), ['servo', 'servo', 'wait']);
  assert.equal(run.published[0].payload.run_id, undefined);
  const command = await send('/command', { command: program[0] });
  assert.equal(command.body.run_id, undefined);
  assert.equal(command.published[0].payload.run_id, undefined);
  assert.deepEqual(command.published[0].payload.params, program[0]);
  const ws = await socketSend({ type: 'command', command: program[0] });
  assert.deepEqual(ws.body, { type: 'ack', command: 'wait' });
  assert.deepEqual(ws.published[0].payload, program[0]);
});

test('correlated runtime execution events reach WebSocket without becoming assumed physical state', async () => {
  const run = await send('/program', { program: [{ type: 'wait', duration: 0.1 }] });
  const ws = new WebSocket(base.replace('http:', 'ws:'));
  await once(ws, 'open');
  try {
    const forwarded = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Execution event was not forwarded')), 1500);
      ws.on('message', bytes => {
        const message = JSON.parse(bytes.toString());
        if (message.type === 'mqtt' && message.topic === 'robot/execution') {
          clearTimeout(timeout);
          resolve(message.data);
        }
      });
    });
    const event = { run_id: run.body.run_id, event: 'completed', block_path: [0], type: 'wait', details: {} };
    await peer.publishAsync(`${prefix}/robot/execution`, JSON.stringify(event), { qos: 1, retain: false });
    assert.deepEqual(await forwarded, event);
    assert.deepEqual(mqtt.getHardwareStates(), {});
  } finally {
    ws.close();
    await once(ws, 'close');
  }
});

test('status exposes latest cooperative metadata without claiming hardware position', async () => {
  const first = await request('GET', '/status');
  assert.equal(first.body.application, 'cooperative-v1');
  assert.deepEqual(first.body.capabilities, ['wait', 'stop', 'display_text', 'set_led', 'repeat']);
  for (const key of ['motion_enabled', 'armed']) assert.equal(first.body[key], false);
  assert.equal(first.body.self_managed_homing, true);
  assert.equal(first.body.build, 'fixture-build');
  assert.equal(first.body.boot, 'fixture-boot');
  assert.equal(first.body.sha256, 'fixture-digest');
  await cooperative({ capabilities: ['wait'], build: 'next-build' });
  const latest = await request('GET', '/status');
  assert.deepEqual(latest.body.capabilities, ['wait']);
  assert.equal(latest.body.build, 'next-build');
  await status({ status: 'running' });
  assert.equal((await request('GET', '/status')).body.application, 'cooperative-v1');
  assert.deepEqual(mqtt.getHardwareStates(), {});
});
