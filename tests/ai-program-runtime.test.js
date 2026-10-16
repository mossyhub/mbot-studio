// Real AI routes, lowerer and admission; provider transport is in-memory only.
import { test, beforeEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import OpenAI from 'openai';

const savedEnv = { ...process.env };
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbot-ai-runtime-'));
process.env.DATA_DIR = dataDir;
process.env.AI_API_KEY = 'isolated-test-key';
process.env.AZURE_OPENAI_ENDPOINT = '';
process.env.AZURE_OPENAI_API_KEY = '';
const config = { name: 'Test robot', additions: [
  { type: 'servo', port: 'S1', label: 'Arm', actions: [{ name: 'raise', angle: 90 }] },
  { type: 'dc_motor', port: 'M1', label: 'Claw', actions: [
    { name: 'close', speed: 30, duration: 0.5, targetState: 'closed' },
  ] },
] };
fs.writeFileSync(path.join(dataDir, 'robot-config.json'), JSON.stringify(config));
const { MqttService } = await import('../server/src/services/mqtt-service.js');
const { aiRoutes } = await import('../server/src/routes/ai.js');
const { lowerProgram } = await import('../server/src/services/program-lowering.js');
const previous = MqttService.instance;
const caps = ['move_forward', 'move_backward', 'turn_left', 'turn_right', 'dc_motor', 'servo',
  'wait', 'stop', 'display_text', 'set_led', 'play_tone', 'play_sound', 'set_volume', 'stop_sound',
  'display_animation', 'read_sensors', 'status', 'motor_power_100', 'turn_angle_360'];
let mqtt, completion, requests;
mock.method(globalThis, 'fetch', () => { throw new Error('Network forbidden'); });
mock.method(OpenAI.prototype, 'post', async (url, options) => {
  assert.equal(url, '/chat/completions');
  requests.push(options.body);
  return { choices: [{ message: { content: JSON.stringify(completion) } }] };
});
beforeEach(() => {
  requests = [];
  completion = { chat: 'Hello' };
  process.env.AI_LOCAL_DEBUG = 'true';
  mqtt = new MqttService({ mqttConnect: () => { throw new Error('MQTT forbidden'); } });
  MqttService.instance = mqtt;
  mqtt.connected = true;
  mqtt.robotLastSeen = mqtt.robotStatusLastSeen = Date.now();
  mqtt.robotState = 'ready';
  mqtt.robotStatusMetadata = { application: 'cooperative-v1', build: 'mbot-av-control-v1',
    capabilities: [...caps], motion_enabled: true, armed: true };
  mqtt.client = { publish: () => assert.fail('AI must never publish') };
});
after(() => {
  MqttService.instance = previous;
  mock.restoreAll();
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  fs.rmSync(dataDir, { recursive: true, force: true });
});
async function request(route, body = {}) {
  const handler = aiRoutes.stack.find(layer => layer.route?.path === route && layer.route.methods.post).route.stack[0].handle;
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ body: { message: 'make a square', sessionId: `test-${Math.random()}`, ...body } }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return res.body;
}

test('AI recording preflight resolves trusted metadata without modifying the generated source or publishing', async () => {
  process.env.AI_LOCAL_DEBUG = 'false';
  const id = 'a'.repeat(64);
  mqtt.setRecordingRegistry({ get: key => key === id ? { id, sha256: id, size: 100, duration_ms: 1250 } : null });
  mqtt.robotStatusMetadata.capabilities.push('play_recording', 'recorded_audio_v1');
  const program = [{ type: 'play_recording', recording: id, _id: 'voice' }];
  completion = { program, explanation: 'Play saved voice' };
  for (const route of ['/generate', '/chat']) {
    const result = await request(route);
    assert.equal(result.success, true, result.error);
    assert.deepEqual(result.program, program);
  }
});

test('AV local debug generates angle-only turns accepted by the real lowerer and admission', async () => {
  for (const message of ['make a square', 'dance']) {
    const result = await request('/generate', { message });
    assert.equal(result.success, true);
    const lowered = lowerProgram(result.program, { validateBlock: block => mqtt.validateCooperativeProgram([block]) });
    mqtt.validateCooperativeProgram(lowered.program);
    for (const block of lowered.program.filter(block => block.type.startsWith('turn_'))) {
      assert.equal(Object.hasOwn(block, 'speed'), false);
    }
  }
  assert.equal(requests.length, 0);
});

test('AV generated programs are rejected explicitly, unchanged, before code or assumed-state updates', async () => {
  const invalid = [
    { type: 'turn_right', angle: 90, speed: 40 },
    { type: 'servo', port: 'S1', angle: 90, speed: 30 },
    { type: 'turn_left', params: { angle: 20, speed: 0 } },
    { type: 'servo', params: { port: 'S1', angle: 90, speed: 1 } },
    { type: 'repeat_forever', do: [{ type: 'stop' }] },
    { type: 'if_predicate', cond: { type: 'sensor_obstacle_close', distance: 20 }, then: [] },
    { type: 'play_sound', sound: 'meow' },
    { type: 'dc_motor_position', port: 'M1', position: 50 },
    { type: 'read_sensors' },
  ];
  for (const route of ['/generate', '/chat']) {
    for (const bad of invalid) {
      process.env.AI_LOCAL_DEBUG = 'false';
      const program = [{ type: 'dc_motor', port: 'M1', speed: 30, duration: 0.5 },
        { type: 'repeat', times: 1, do: [{ ...bad, _id: 'invalid-block' }] }];
      completion = { program, explanation: 'Do the thing' };
      const result = await request(route);
      assert.equal(result.success, false, `${route}: ${JSON.stringify(bad)}`);
      assert.equal(result.runnable, false);
      assert.equal(result.program, undefined);
      assert.equal(result.pythonCode, undefined);
      assert.deepEqual(result.rejectedProgram, program, 'do not silently remove incompatible fields');
      assert.ok(result.error);
      assert.ok(result.chat.includes(result.error));
      assert.equal(result.errors[0].sourceId, 'invalid-block');
      assert.equal(result.errors[0].path, `program[1].do[0]${bad.type === 'if_predicate' ? '.cond' : ''}`);
      assert.deepEqual(mqtt.getHardwareStates(), {});
    }
  }
});

test('AV local debug refuses sensor tasks rather than substituting blind movement', async () => {
  for (const message of ['avoid obstacles', 'make a square and avoid obstacles', 'follow a line', 'drive until the distance sensor changes']) {
    const result = await request('/generate', { message });
    assert.equal(result.success, false, message);
    assert.equal(result.program, undefined);
    assert.match(result.chat, /live sensor.*(unsupported|not supported)/i);
    assert.equal(requests.length, 0);
  }
});

test('AV valid generation preserves blocks without claiming hardware moved', async () => {
  process.env.AI_LOCAL_DEBUG = 'false';
  const program = [{ type: 'servo', port: 'S1', angle: 90, speed: 0 },
    { type: 'repeat', times: 2, do: [{ type: 'turn_left', angle: 90 }] },
    { type: 'dc_motor', port: 'M1', speed: 30, duration: 0.5 }];
  completion = { program, explanation: 'A short sequence' };
  for (const route of ['/generate', '/chat']) {
    const result = await request(route);
    assert.equal(result.success, true);
    assert.deepEqual(result.program, program);
    assert.equal(typeof result.pythonCode, 'string');
    assert.deepEqual(mqtt.getHardwareStates(), {});
  }
});

test('preflight also checks imported blocks, whole-program budgets, empty output and runtime freshness', async () => {
  const imported = [{ type: 'turn_left', angle: 20, speed: 10 }];
  const result = await request('/generate', { currentBlocks: imported });
  assert.equal(result.success, false);
  assert.deepEqual(result.rejectedProgram[0], imported[0]);
  assert.deepEqual(imported, [{ type: 'turn_left', angle: 20, speed: 10 }]);
  process.env.AI_LOCAL_DEBUG = 'false';
  for (const program of [[], null, 'invalid', [{ type: 'repeat', times: 0, do: [] }],
    [{ type: 'repeat', times: 33, do: [{ type: 'wait', duration: 0 }] }],
    [{ type: 'repeat', times: 3, do: [{ type: 'wait', duration: 60 }] }],
    Array.from({ length: 32 }, () => ({ type: 'display_text', text: '😀'.repeat(128) }))]) {
    completion = { program };
    const rejected = await request('/generate');
    assert.equal(rejected.success, false, JSON.stringify(program));
    assert.deepEqual(rejected.rejectedProgram, program);
    assert.equal(rejected.program, undefined);
    assert.ok(rejected.error);
  }
  completion = { program: [{ type: 'wait', duration: 0 }] };
  mqtt.robotStatusLastSeen = Date.now() - MqttService.ROBOT_TIMEOUT;
  assert.equal((await request('/generate')).errors[0].code, 'COOPERATIVE_OFFLINE');
  mqtt.connected = false;
  assert.equal((await request('/chat')).errors[0].code, 'COOPERATIVE_OFFLINE');
});

test('unknown runtime preserves legacy generation, servo speeds and cloud reference', async () => {
  mqtt.robotStatusMetadata = {};
  const debug = await request('/generate');
  assert.equal(debug.success, true);
  assert.equal(debug.program[0].do[1].speed, 40);
  assert.equal((await request('/generate', { message: 'avoid obstacles' })).program[0].type, 'repeat_forever');
  process.env.AI_LOCAL_DEBUG = 'false';
  completion = { program: [{ type: 'servo', port: 'S1', angle: 90, speed: 30 }] };
  for (const route of ['/generate', '/chat']) {
    const result = await request(route);
    assert.equal(result.success, true);
    assert.deepEqual(result.program, completion.program);
    assert.match(requests.at(-1).messages[0].content, /Optional "speed": 1–100/);
    assert.doesNotMatch(requests.at(-1).messages[0].content, /Installed runtime: mbot-av-control-v1/);
  }
});

test('AV hardware context does not teach legacy percentage-position commands', async () => {
  process.env.AI_LOCAL_DEBUG = 'false';
  const withPosition = structuredClone(config);
  Object.assign(withPosition.additions[1], { homeState: 'open', states: ['open', 'closed'], actions: [
    { name: 'open', targetState: 'open', speed: 30, duration: 0.5, motorDirection: 'reverse' },
    { name: 'close', targetState: 'closed', speed: 30, duration: 0.5 },
  ] });
  fs.writeFileSync(path.join(dataDir, 'robot-config.json'), JSON.stringify(withPosition));
  try {
    await request('/generate');
    const prompt = requests.at(-1).messages[0].content;
    assert.doesNotMatch(prompt, /Percentage positioning available|Use dc_motor_position/);
  } finally {
    fs.writeFileSync(path.join(dataDir, 'robot-config.json'), JSON.stringify(config));
  }
});

test('indexed-capable AI preflight and prompts use the negotiated larger profile without rewriting source', async () => {
  process.env.AI_LOCAL_DEBUG = 'false';
  mqtt.robotStatusMetadata.capabilities.push('program_indexed_v1');
  const program = [{ type: 'repeat', times: 1024, do: [{ type: 'wait', duration: 0.01 }] }];
  completion = { program, explanation: 'A finite repeated pause' };
  for (const route of ['/generate', '/chat']) {
    const result = await request(route);
    assert.equal(result.success, true, result.error);
    assert.deepEqual(result.program, program);
    const prompt = requests.at(-1).messages[0].content;
    assert.match(prompt, /1024 expanded instructions/);
    assert.match(prompt, /repeat times integer 0\.\.1024/);
    assert.match(prompt, /32 distinct primitives/);
    assert.match(prompt, /8192 bytes/);
    assert.match(prompt, /120 seconds/);
    assert.doesNotMatch(prompt, /32 expanded instructions/);
  }
});

test('both cloud prompts use capability-aware AV contracts rather than legacy examples, including cache changes', async () => {
  process.env.AI_LOCAL_DEBUG = 'false';
  for (const route of ['/generate', '/chat']) {
    for (const expanded of [true, false, true]) {
      mqtt.robotStatusMetadata.capabilities = caps.filter(cap => expanded || !['motor_power_100', 'turn_angle_360'].includes(cap));
      await request(route);
      const prompt = requests.at(-1).messages[0].content;
      assert.match(prompt, /mbot-av-control-v1/);
      assert.match(prompt, /turn[^\n]*speed[^\n]*unsupported/i);
      assert.match(prompt, /servo[^\n]*speed[^\n]*(omit|0)/i);
      assert.match(prompt, /live sensor[^\n]*(unsupported|unavailable|not supported)/i);
      assert.match(prompt, new RegExp(`angle[^\\n]*0\\.\\.${expanded ? 360 : 30}`));
      assert.match(prompt, new RegExp(`RPM[^\\n]*0\\.\\.${expanded ? 100 : 50}`));
      const examples = [...prompt.matchAll(/^- (\{"type":.*?\})(?: —.*)?$/gm)].map(match => JSON.parse(match[1]));
      assert.ok(examples.some(block => block.type === 'turn_right'));
      assert.ok(examples.some(block => block.type === 'servo'));
      for (const example of examples) {
        const lowered = lowerProgram([example], { validateBlock: block => mqtt.validateCooperativeProgram([block]) });
        mqtt.validateCooperativeProgram(lowered.program);
      }
      for (const type of ['play_melody', 'led_effect', 'dc_motor_position', 'sensor_distance', 'move_until', 'while_block']) {
        assert.equal(prompt.includes(`"type": "${type}"`), false, type);
      }
    }
  }
});
