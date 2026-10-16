import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { MqttService } from '../server/src/services/mqtt-service.js';
import { robotRoutes } from '../server/src/routes/robot.js';
const previous = MqttService.instance;
let mqtt, packets;
const caps = ['move_forward', 'move_backward', 'turn_left', 'turn_right', 'dc_motor', 'servo',
  'wait', 'stop', 'display_text', 'set_led', 'play_tone', 'play_sound', 'set_volume', 'stop_sound', 'display_animation',
  'motor_power_100', 'turn_angle_360', 'program_indexed_v1'];
beforeEach(() => {
  packets = []; mqtt = new MqttService(); MqttService.instance = mqtt;
  mqtt.connected = true; mqtt.robotLastSeen = mqtt.robotStatusLastSeen = Date.now(); mqtt.robotState = 'ready';
  mqtt.robotStatusMetadata = { application: 'cooperative-v1', build: 'mbot-av-control-v1', capabilities: [...caps], motion_enabled: true, armed: true };
  mqtt.client = { publish: (topic, payload, options) => packets.push({ topic, payload, options, ...JSON.parse(payload) }) };
});
after(() => { MqttService.instance = previous; });
function request(path, program) {
  const layer = robotRoutes.stack.find(item => item.route?.path === path && item.route.methods.post);
  const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  try { layer.route.stack[0].handle({ body: { program } }, response); }
  catch (error) { response.statusCode = error.status || 500; response.body = { error: error.message, code: error.code }; }
  return response;
}
const repeat = (times, block = { type: 'wait', duration: 0.1, _id: 'pause' }) => [{ type: 'repeat', times, do: [block] }];

test('actual indexed send boundary measures complete 8191/8192/8193-byte UTF-8 packets', () => {
  const runId = '😀'.repeat(32), timestamp = 1700000000000;
  const commands = Array.from({ length: 32 }, (_, i) => ({ type: 'display_text', size: 16, text: String(i) + '\u0001'.repeat(24) + '😀\"\\\n' }));
  const program = { format: 'indexed-v1', commands, order: Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0')).join('') };
  const bytes = () => Buffer.byteLength(JSON.stringify({ program, timestamp, run_id: runId }));
  for (const command of commands) {
    const padding = Math.min(128 - [...command.text].length, 8191 - bytes());
    if (padding > 0) command.text += 'x'.repeat(padding);
  }
  assert.equal(bytes(), 8191);
  const grow = commands.find(command => [...command.text].length < 127);
  assert.ok(grow);
  for (const size of [8191, 8192]) {
    assert.equal(mqtt.sendProgram(program, runId, timestamp), true);
    assert.equal(Buffer.byteLength(packets.at(-1).payload), size);
    grow.text += 'x';
  }
  assert.equal(bytes(), 8193);
  assert.throws(() => mqtt.sendProgram(program, runId, timestamp), /8192/);
  assert.equal(packets.length, 2);
});

test('indexed responses include selected limits on failures before any publish', () => {
  const response = request('/program/validate', repeat(1025));
  assert.equal(response.body.runnable, false);
  assert.equal(response.body.encoding, 'indexed-v1');
  assert.equal(response.body.limits.instructions, 1024);
  assert.equal(response.body.uniqueCount, null);
  assert.equal(packets.length, 0);
});

test('executed animations, static variables and say retain exact global source-map order', () => {
  const source = [
    { type: 'set_variable', name: 'x', value: 0 },
    { type: 'repeat', times: 20, do: [
      { type: 'wait', _id: 'changing', params: { duration: { type: 'op_div', a: { type: 'var_get', name: 'x' }, b: 1000 } } },
      { type: 'change_variable', name: 'x', by: 1 },
    ] },
    { type: 'repeat', times: 4, do: [{ type: 'display_animation', _id: 'frames', frames: ['a', 'b'], interval: 0.25 }] },
    { type: 'say', _id: 'label', text: 'hello' },
  ];
  const result = request('/program', source);
  assert.equal(result.body.sent, true, result.body.error);
  const packet = packets[0];
  const expanded = [...Buffer.from(packet.program.order, 'hex')].map(index => packet.program.commands[index]);
  assert.equal(result.body.compiledCount, 37);
  assert.deepEqual(expanded.slice(0, 20), Array.from({ length: 20 }, (_, i) => ({ type: 'wait', duration: i / 1000 })));
  assert.deepEqual(expanded[36], { type: 'display_text', size: 14, text: 'hello' });
  assert.deepEqual(result.body.sourceMap.map(s => s.sourceId), [...Array(20).fill('changing'), ...Array(16).fill('frames'), 'label']);
  assert.deepEqual(result.body.sourceMap.map(s => s.compiledIndex), Array.from({ length: 37 }, (_, i) => i));
  assert.equal(result.body.requestedHoldSeconds, 2.19);
  for (const rejected of [
    repeat(7, { type: 'display_animation', frames: ['a'], interval: 2 }),
    repeat(1024, { type: 'wait', duration: 0, _id: '\u0001'.repeat(128) }),
    repeat(1, { type: 'stop', _id: '😀'.repeat(33) }),
    [{ type: 'stop' }, { type: 'if_predicate', cond: false, then: [{ type: 'wait', duration: -1 }], else: [] }],
  ]) assert.equal(request('/program', rejected).body.runnable, false);
  assert.equal(packets.length, 1);
});

test('actual shared send boundary revalidates indexed schema, capability and weighted holds', () => {
  const plan = { format: 'indexed-v1', commands: [{ type: 'wait', duration: 0.1 }], order: '00'.repeat(1024) };
  assert.doesNotThrow(() => mqtt.validateCooperativeProgram(plan));
  assert.equal(mqtt.sendProgram(plan, 'direct'), true);
  packets.length = 0;
  for (const mutate of [
    () => { mqtt.robotStatusMetadata.capabilities = caps.filter(c => c !== 'program_indexed_v1'); },
    () => { mqtt.robotStatusMetadata = {}; },
    () => { mqtt.robotStatusMetadata.build = 'mbot-motor-control-v1'; },
    () => { mqtt.robotStatusMetadata.build = 'experimental'; },
    () => { mqtt.robotStatusLastSeen = Date.now() - MqttService.ROBOT_TIMEOUT; },
    () => { mqtt.connected = false; },
    () => { mqtt.robotLastSeen = null; },
    () => { mqtt.robotStatusMetadata.capabilities = caps.filter(c => c !== 'wait'); },
  ]) {
    const saved = { robotStatusMetadata: structuredClone(mqtt.robotStatusMetadata), robotStatusLastSeen: mqtt.robotStatusLastSeen, robotLastSeen: mqtt.robotLastSeen, connected: mqtt.connected };
    mutate();
    assert.throws(() => mqtt.sendProgram(plan, 'blocked'));
    assert.equal(packets.length, 0);
    Object.assign(mqtt, saved);
  }
  for (const invalid of [
    { ...plan, order: '01' }, { ...plan, surprise: true },
    { ...plan, commands: [{ type: 'wait', duration: 60 }], order: '000000' },
    { ...plan, commands: [{ type: 'display_animation', frames: ['x'] }] },
    { ...plan, commands: [{ type: 'stop' }, { type: 'turn_left', angle: 400 }], order: '00' },
  ]) {
    assert.throws(() => mqtt.sendProgram(invalid, 'blocked'));
    assert.equal(packets.length, 0);
  }
  mqtt.robotStatusMetadata.armed = false;
  assert.throws(() => mqtt.sendProgram({ ...plan, commands: [{ type: 'move_forward', speed: 20, duration: 0.1 }] }), /armed/);
});

test('direct flat shared admission now enforces total holds while retaining legacy 32', () => {
  mqtt.robotStatusMetadata.capabilities = caps.filter(c => c !== 'program_indexed_v1');
  assert.equal(request('/program/validate', repeat(32)).body.runnable, true);
  assert.equal(request('/program/validate', repeat(33)).body.runnable, false);
  assert.throws(() => mqtt.sendProgram(Array(33).fill({ type: 'wait', duration: 0 })), /32/);
  assert.throws(() => mqtt.validateCooperativeProgram(Array(3).fill({ type: 'wait', duration: 60 })), /120/);
  assert.throws(() => mqtt.sendProgram(Array(3).fill({ type: 'wait', duration: 60 })), /120/);
  assert.equal(packets.length, 0);
});

test('capability withdrawal between route preparation and send cannot publish old indexed admission', () => {
  const original = mqtt.sendProgram.bind(mqtt);
  mqtt.sendProgram = (...args) => {
    mqtt.robotStatusMetadata.capabilities = caps.filter(c => c !== 'program_indexed_v1');
    return original(...args);
  };
  assert.equal(request('/program', repeat(1024)).body.runnable, false);
  assert.equal(packets.length, 0);
});

test('preflight and actual Run share indexed encoding, limits and expanded source evidence', () => {
  for (const count of [33, 256, 1024]) {
    const validation = request('/program/validate', repeat(count));
    assert.equal(validation.body.runnable, true, validation.body.error);
    assert.equal(validation.body.encoding, 'indexed-v1');
    assert.equal(validation.body.limits.instructions, 1024);
    assert.equal(validation.body.uniqueCount, 1);
    assert.equal(validation.body.expandedCount, count);
    assert.equal(validation.body.sourceMap.length, count);
    const before = packets.length;
    const run = request('/program', repeat(count));
    assert.equal(run.body.sent, true, run.body.error);
    assert.equal(packets.length, before + 1);
    const packet = packets.at(-1);
    assert.deepEqual(packet.program, { format: 'indexed-v1', commands: [{ type: 'wait', duration: 0.1 }], order: '00'.repeat(count) });
    assert.equal(run.body.wireBytes, Buffer.byteLength(packet.payload));
    assert.equal(run.body.wireBytes, validation.body.wireBytes);
    assert.deepEqual(packet.options, { qos: 0, retain: false });
    assert.deepEqual(run.body.sourceMap, validation.body.sourceMap);
  }
});
