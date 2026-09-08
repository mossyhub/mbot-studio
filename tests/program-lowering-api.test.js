// In-process real Express handlers and MqttService admission. No sockets/broker/device.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { MqttService } from '../server/src/services/mqtt-service.js';
import { robotRoutes } from '../server/src/routes/robot.js';
const previous = MqttService.instance;
let mqtt, packets;
const caps = ['move_forward', 'move_backward', 'turn_left', 'turn_right', 'dc_motor', 'servo',
  'wait', 'stop', 'display_text', 'set_led', 'play_tone', 'play_sound', 'set_volume', 'stop_sound', 'display_animation'];
beforeEach(() => {
  packets = [];
  mqtt = new MqttService();
  MqttService.instance = mqtt;
  mqtt.connected = true;
  mqtt.robotLastSeen = mqtt.robotStatusLastSeen = Date.now();
  mqtt.robotState = 'ready';
  mqtt.robotStatusMetadata = { application: 'cooperative-v1', build: 'mbot-av-control-v1',
    capabilities: caps, motion_enabled: true, armed: true };
  mqtt.client = { publish: (topic, payload) => packets.push({ topic, ...JSON.parse(payload) }) };
});
after(() => { MqttService.instance = previous; });
function request(path, program) {
  const layer = robotRoutes.stack.find(item => item.route?.path === path && item.route.methods.post);
  assert.ok(layer, `POST ${path} must exist`);
  const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  try { layer.route.stack[0].handle({ body: { program } }, response); }
  catch (error) { response.statusCode = error.status || 500; response.body = { error: error.message, code: error.code }; }
  return response;
}

test('preflight is read-only and Run publishes exactly its fully admitted lowering', () => {
  const program = [{ type: 'repeat', times: 2, do: [{ type: 'wait', _id: 'pause', duration: 0.1 }] }];
  const validation = request('/program/validate', program);
  assert.equal(validation.statusCode, 200);
  assert.equal(validation.body.runnable, true);
  assert.deepEqual(validation.body.errors, []);
  assert.equal(validation.body.compiledCount, 2);
  assert.equal(validation.body.sourceMap[1].sourceId, 'pause');
  assert.equal(packets.length, 0);
  const result = request('/program', program);
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.sent, true);
  assert.equal(result.body.compiledCount, 2);
  assert.equal(packets.length, 1);
  assert.deepEqual(packets[0].program, [program[0].do[0], program[0].do[0]]);
});

test('validation has a stable display contract for success, unsupported and empty output', () => {
  for (const [program, runnable, count, pattern] of [
    [[{ type: 'display_animation', frames: ['one', 'two'], interval: 0.5 }], true, 4, null],
    [[{ type: 'repeat_forever', do: [] }], false, null, /Unsupported/],
    [[{ type: 'repeat', times: 0, do: [] }], false, 0, /no.*instruction/i],
    [[], false, 0, /no.*instruction/i],
  ]) {
    const { body } = request('/program/validate', program);
    assert.equal(body.runnable, runnable);
    assert.equal(body.compiledCount, count);
    assert.equal(body.expandedCount, count);
    assert.ok(Object.hasOwn(body, 'wireBytes'));
    if (runnable) assert.equal(body.error, null);
    else {
      assert.match(body.error, pattern);
      assert.equal(body.errors[0].message, body.error);
    }
    assert.equal(packets.length, 0);
  }
});

test('preflight never infers an installed runtime from missing, offline or stale status', () => {
  for (const mutate of [
    () => { mqtt.connected = false; },
    () => { mqtt.robotLastSeen = null; },
    () => { mqtt.robotStatusLastSeen = Date.now() - MqttService.ROBOT_TIMEOUT; },
    () => { mqtt.robotStatusMetadata = {}; },
    () => { mqtt.robotStatusMetadata.build = 'mbot-motor-control-v1'; },
  ]) {
    const saved = { connected: mqtt.connected, robotLastSeen: mqtt.robotLastSeen,
      robotStatusLastSeen: mqtt.robotStatusLastSeen, robotStatusMetadata: { ...mqtt.robotStatusMetadata } };
    mutate();
    const result = request('/program/validate', [{ type: 'wait', duration: 0 }]);
    assert.equal(result.body.runnable, false);
    assert.equal(result.body.compiledCount, null);
    assert.ok(result.body.errors[0].code);
    assert.equal(packets.length, 0);
    Object.assign(mqtt, saved);
  }
});

test('all source primitives, including unreachable ones, pass real admission before any publish', () => {
  for (const block of [
    { type: 'move_forward', speed: 51 }, { type: 'turn_left', angle: 10, speed: 5 },
    { type: 'wait', duration: -1 }, { type: 'display_text', text: 'x'.repeat(129) },
    { type: 'servo', port: 'M1', angle: 90 }, { type: 'play_sound', sound: 'unsupported' },
  ]) {
    const program = [{ type: 'wait', duration: 0 }, { type: 'if_predicate', cond: false,
      then: [{ ...block, _id: 'hidden-bad' }], else: [] }];
    for (const route of ['/program/validate', '/program']) {
      const result = request(route, program);
      assert.equal(result.body.runnable, false);
      assert.equal(result.body.errors[0].sourceId, 'hidden-bad');
      assert.equal(result.body.errors[0].path, 'program[1].then[0]');
      assert.equal(packets.length, 0);
    }
  }
  mqtt.robotStatusMetadata.armed = false;
  const result = request('/program/validate', [{ type: 'repeat', times: 0, do: [{ type: 'move_forward', speed: 10 }] }, { type: 'stop' }]);
  assert.equal(result.body.runnable, false);
  assert.equal(result.body.errors[0].code, 'COOPERATIVE_NOT_ARMED');
});

test('say uses the documented centered LCD label semantics, never speech or ignored options', () => {
  const result = request('/program', [{ type: 'say', _id: 'label', text: 'Hello 😀' }, { type: 'stop' }, { type: 'wait', duration: 0 }]);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(packets[0].program, [{ type: 'display_text', _id: 'label', text: 'Hello 😀', size: 14 }, { type: 'stop' }, { type: 'wait', duration: 0 }]);
  for (const extra of [{ duration: 1 }, { size: 24 }, { voice: 'hello' }]) {
    const result = request('/program/validate', [{ type: 'say', text: 'hello', ...extra }]);
    assert.equal(result.body.runnable, false);
  }
});

test('flat primitive params wrappers and run metadata retain their validated wire shape', () => {
  const program = [{ type: 'wait', _id: 'wrapped', run_id: 'editor-run', params: { duration: { type: 'op_div', a: 1, b: 2 } } }];
  const result = request('/program', program);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(packets[0].program, [{ type: 'wait', _id: 'wrapped', run_id: 'editor-run', params: { duration: 0.5 } }]);
  for (const block of [
    { type: 'wait', params: { duration: 0 }, speed: 10 },
    { type: 'wait', params: { type: 'stop' } },
    { type: 'repeat', run_id: 'ignored', times: 1, do: [] },
    { type: 'if_predicate', cond: true, then: null },
  ]) assert.equal(request('/program/validate', [block]).body.runnable, false);
});

test('Run retains native admission error codes and unsupported statement HTTP status', () => {
  for (const block of [
    { type: 'display_animation', frames: [] },
    { type: 'play_tone', frequency: { type: 'var_get' } },
    { type: 'wait', duration: { type: 'sensor_distance' } },
  ]) {
    const result = request('/program', [block]);
    assert.equal(result.statusCode, 400);
    assert.equal(result.body.code, 'COOPERATIVE_INVALID');
    assert.equal(result.body.runnable, false);
  }
  for (const type of ['read_sensors', 'status']) {
    const result = request('/program', [{ type }]);
    assert.equal(result.statusCode, 422);
    assert.equal(result.body.code, 'COOPERATIVE_UNSUPPORTED');
  }
  assert.equal(packets.length, 0);
});

test('exact complete UTF-8 payload boundary is admitted without changing source IDs', (t) => {
  t.mock.method(Date, 'now', () => 1700000000000);
  mqtt.robotLastSeen = mqtt.robotStatusLastSeen = Date.now();
  const block = { type: 'stop', _id: '😀\u0001' };
  const envelope = program => JSON.stringify({ program, timestamp: Date.now(), run_id: '0'.repeat(36) });
  block._id += 'x'.repeat(8192 - Buffer.byteLength(envelope([block]), 'utf8'));
  const original = structuredClone(block);
  const validation = request('/program/validate', [block]);
  assert.equal(validation.body.runnable, true);
  assert.equal(validation.body.wireBytes, 8192);
  assert.equal(packets.length, 0);
  const run = request('/program', [block]);
  assert.equal(run.body.sent, true);
  assert.equal(run.body.wireBytes, 8192);
  assert.deepEqual(packets[0].program, [original]);
  assert.deepEqual(block, original);
  const { topic, ...payload } = packets[0];
  assert.equal(Buffer.byteLength(JSON.stringify(payload), 'utf8'), 8192);
  block._id += 'x';
  for (const route of ['/program/validate', '/program']) {
    assert.equal(request(route, [block]).body.runnable, false);
    assert.equal(packets.length, 1);
  }
});

test('API enforces source bytes and requested holds even when the wire would otherwise fit', () => {
  for (const [program, pattern] of [
    [[{ type: 'repeat', _id: 'x'.repeat(65536), times: 0, do: [] }, { type: 'stop' }], /65536/],
    [[{ type: 'repeat', times: 3, do: [{ type: 'wait', duration: 60 }] }], /120/],
  ]) {
    for (const route of ['/program/validate', '/program']) {
      const result = request(route, program);
      assert.equal(result.body.runnable, false);
      assert.match(result.body.error, pattern);
      assert.equal(packets.length, 0);
    }
  }
  assert.equal(request('/program/validate', [{ type: 'repeat', times: 2, do: [{ type: 'wait', duration: 60 }] }]).body.requestedHoldSeconds, 120);
});

test('whole-plan admission retains animation, UTF-8 wire, capability and atomic publish limits', () => {
  const rejected = [
    [{ type: 'repeat', times: 33, do: [{ type: 'wait', duration: 0 }] }],
    [{ type: 'repeat', times: 2, do: [{ type: 'display_animation', frames: Array(7).fill('frame'), interval: 1 }] }],
    [{ type: 'repeat', times: 16, do: [{ type: 'display_text', text: '😀'.repeat(128) }] }],
    [{ type: 'wait', duration: 0 }, { type: 'display_text', text: 'fine', _id: '\u0001'.repeat(1400) }],
    [{ type: 'repeat', times: 0, do: [] }],
  ];
  for (const program of rejected) {
    for (const route of ['/program/validate', '/program']) {
      assert.equal(request(route, program).body.runnable, false);
      assert.equal(packets.length, 0);
    }
  }
  const valid = [{ type: 'repeat', times: 32, do: [{ type: 'wait', duration: 0 }] }];
  const result = request('/program/validate', valid);
  assert.equal(result.body.runnable, true);
  assert.equal(result.body.compiledCount, 32);
  assert.equal(result.body.wireBytes, Buffer.byteLength(JSON.stringify({ program: Array.from({ length: 32 }, () => ({ type: 'wait', duration: 0 })), timestamp: Date.now(), run_id: '0'.repeat(36) })));
  assert.equal(packets.length, 0);
  mqtt.robotStatusMetadata.capabilities = caps.filter(type => type !== 'wait');
  assert.equal(request('/program/validate', valid).body.runnable, false);
});

