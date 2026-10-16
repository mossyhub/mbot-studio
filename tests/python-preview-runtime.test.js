// Real routes/compiler/admission; provider and network transports are trapped.
// Python is only parsed/compiled, never imported or executed against hardware.
import { test, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import OpenAI from 'openai';

const savedEnv = { ...process.env };
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbot-preview-'));
Object.assign(process.env, { DATA_DIR: dataDir, AI_API_KEY: 'isolated-test-key',
  AZURE_OPENAI_ENDPOINT: '', AZURE_OPENAI_API_KEY: '', AI_LOCAL_DEBUG: 'false' });
fs.writeFileSync(path.join(dataDir, 'robot-config.json'), JSON.stringify({ additions: [] }));
let completion, mqtt, requests;
mock.method(globalThis, 'fetch', () => { throw Error('Network forbidden'); });
mock.method(OpenAI.prototype, 'post', async (_url, options) => {
  requests.push(options.body);
  return { choices: [{ message: { content: JSON.stringify(completion) } }] };
});
const { MqttService } = await import('../server/src/services/mqtt-service.js');
const { aiRoutes } = await import('../server/src/routes/ai.js');
const generator = await import('../server/src/services/code-generator.js');
const previous = MqttService.instance;
const caps = ['move_forward', 'move_backward', 'turn_left', 'turn_right', 'wait', 'stop',
  'servo', 'dc_motor', 'display_animation', 'display_text', 'set_led', 'play_tone',
  'play_sound', 'set_volume', 'stop_sound', 'motor_power_100', 'turn_angle_360'];
beforeEach(() => {
  requests = [];
  mqtt = new MqttService({ mqttConnect: () => { throw Error('MQTT forbidden'); } });
  MqttService.instance = mqtt;
  mqtt.connected = true;
  mqtt.robotLastSeen = mqtt.robotStatusLastSeen = Date.now();
  mqtt.robotState = 'ready';
  mqtt.robotStatusMetadata = { application: 'cooperative-v1', build: 'mbot-av-control-v1',
    motion_enabled: true, armed: true, capabilities: [...caps] };
  mqtt.client = { publish: () => assert.fail('Preview must not publish') };
});
after(() => {
  MqttService.instance = previous;
  mock.restoreAll();
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  fs.rmSync(dataDir, { recursive: true, force: true });
});
async function request(route, body = {}, router = aiRoutes) {
  const handler = router.stack.find(l => l.route?.path === route && l.route.methods.post).route.stack[0].handle;
  const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(b) { this.body = b; return this; } };
  await handler({ body: { message: 'Produce the requested program', sessionId: Math.random().toString(), ...body } }, res);
  return res;
}
function calls(source) {
  const result = spawnSync('python3', ['-c', `import ast,json,sys
source=sys.stdin.read()
compile(source,'preview','exec')
tree=ast.parse(source)
def name(node):
 if isinstance(node,ast.Name):return node.id
 if isinstance(node,ast.Attribute):return name(node.value)+'.'+node.attr
 return ''
print(json.dumps([{'name':name(n.func),'args':[ast.unparse(a) for a in n.args]} for n in ast.walk(tree) if isinstance(n,ast.Call)]))`],
  { input: source, encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
// /api/ai/blocks-to-code is the actual editor preview route. Do not invent a
// second endpoint merely to satisfy a test of a mistaken route assumption.
for (const [route, router, field] of [
  ['/blocks-to-code', aiRoutes, 'blocks'],
]) {
  test(`direct ${route}: runtime-aware preview preserves wrappers, defaults, animation and Stop`, async () => {
    assert.ok(router.stack.some(l => l.route?.path === route), `Missing preview route ${route}`);
    const program = [{ type: 'move_forward', params: { speed: 0, duration: 0 } },
      { type: 'move_backward' }, { type: 'display_animation', params: { frames: ['hello'], interval: 0.5 } },
      { type: 'stop' }];
    const original = structuredClone(program);
    const res = await request(route, { [field]: program }, router);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(program, original);
    const emitted = calls(res.body.code);
    assert.deepEqual(emitted.find(c => c.name === 'mbot2.forward').args, ['0']);
    assert.deepEqual(emitted.find(c => c.name === 'mbot2.backward').args, ['20']);
    assert.ok(emitted.some(c => c.name === 'mbot2.starter_shield.dc_motor_stop'));
    assert.ok(emitted.some(c => c.name === 'cyberpi.audio.stop'));
    assert.ok(emitted.some(c => c.name === 'cyberpi.display.show_label' && c.args[1] === '24'));
  });
  test(`direct ${route}: AV incompatibility is explicit, legacy output remains unchanged`, async () => {
    assert.ok(router.stack.some(l => l.route?.path === route), `Missing preview route ${route}`);
    for (const state of ['unsupported', 'offline', 'unarmed']) {
      mqtt.connected = state !== 'offline';
      mqtt.robotStatusMetadata.armed = state !== 'unarmed';
      const program = state === 'unsupported' ? [{ type: 'if_line', then: [{ type: 'stop' }] }]
        : [{ type: 'move_forward', duration: 0.1 }];
      const res = await request(route, { [field]: program }, router);
      assert.ok(res.statusCode >= 400 && res.statusCode !== 500, JSON.stringify(res.body));
      assert.equal(res.body.code, undefined);
      assert.ok(res.body.error);
    }
    mqtt.robotStatusMetadata = {};
    const program = [{ type: 'move_forward' }, { type: 'turn_left' }, { type: 'if_line', then: [] }];
    const res = await request(route, { [field]: program }, router);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.code, generator.blocksToMicroPython(program, { additions: [] }));
  });
}

for (const route of ['/generate', '/chat']) {
  test(`${route}: unexportable recording is withheld explicitly after runtime admission`, async () => {
    const id = 'a'.repeat(64);
    mqtt.robotStatusMetadata.capabilities.push('play_recording', 'recorded_audio_v1');
    mqtt.setRecordingRegistry({ get: key => key === id ? { id, sha256: id, size: 100, duration_ms: 500 } : null });
    completion = { program: [{ type: 'play_recording', recording: id }], explanation: 'WITHHELD-PREVIEW-MARKER' };
    const sessionId = `withheld-${route}`;
    const res = await request(route, { sessionId });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.success, true);
    assert.equal(res.body.pythonCode, undefined);
    assert.equal(res.body.previewUnavailable.code, 'PYTHON_PREVIEW_UNAVAILABLE');
    assert.match(res.body.previewUnavailable.reason, /play_recording.*preview/i);
    assert.deepEqual(res.body.program, completion.program);
    completion = { chat: 'What next?' };
    await request(route, { sessionId });
    assert.equal(requests.at(-1).messages.some(m => m.role === 'assistant' && m.content.includes('WITHHELD-PREVIEW-MARKER')), false);
  });
  test(`${route}: zero tone/turn guards preserve AV no-op semantics`, async () => {
    completion = { program: [{ type: 'play_tone', duration: 0 }, { type: 'turn_left' }] };
    const res = await request(route);
    assert.equal(res.statusCode, 200);
    assert.equal((res.body.pythonCode.match(/if 0 > 0:/g) || []).length, 2);
    calls(res.body.pythonCode);
  });
  test(`${route}: wrapped animation and static lowering serialize a separate preview`, async () => {
    completion = { program: [{ type: 'set_variable', name: 'n', value: 10 },
      { type: 'repeat', times: 2, do: [
        { type: 'move_forward', params: { speed: { type: 'op_add', a: { type: 'var_get', name: 'n' }, b: 2 }, duration: 0.1 } },
        { type: 'change_variable', name: 'n', by: 1 },
      ] },
      { type: 'display_animation', _id: 'frames', params: { frames: ['hello', '', 'a\nb😀'], interval: 0.5 } }] };
    const res = await request(route);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.success, true);
    assert.deepEqual(res.body.program, completion.program);
    const emitted = calls(res.body.pythonCode);
    assert.deepEqual(emitted.filter(c => c.name === 'mbot2.forward').map(c => c.args), [['12'], ['13']]);
    const labels = emitted.filter(c => c.name === 'cyberpi.display.show_label');
    assert.equal(labels.length, 3);
    assert.ok(labels.every(c => c.args[1] === '24'));
    assert.equal(emitted.filter(c => c.name === 'time.sleep' && c.args[0] === '0.5').length, 3);
    assert.deepEqual(mqtt.getHardwareStates(), {});
  });
  test(`${route}: flat AV metadata does not accidentally select indexed source-ID limits`, async () => {
    completion = { program: [{ type: 'wait', _id: 'x'.repeat(129), duration: 0 }] };
    const res = await request(route);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.success, true);
    assert.deepEqual(res.body.program, completion.program);
    calls(res.body.pythonCode);
  });
  test(`${route}: failed preview never enters successful conversation history`, async () => {
    mqtt.robotStatusMetadata = {}; // Legacy generation still throws for malformed animation.
    completion = { program: [{ type: 'display_animation', frames: 'invalid' }], explanation: 'SUCCESS-MARKER-NOT-DELIVERED' };
    const sessionId = `preview-failure-${route}`;
    const failed = await request(route, { sessionId });
    assert.equal(failed.statusCode, 500);
    completion = { chat: 'What next?' };
    await request(route, { sessionId });
    const history = requests.at(-1).messages.filter(message => message.role === 'assistant');
    assert.equal(history.some(message => message.content.includes('SUCCESS-MARKER-NOT-DELIVERED')), false);
  });
  test(`${route}: AV motor preview uses setpoints and complete timed Stop, guarded at zero duration`, async () => {
    completion = { program: [{ type: 'move_forward', params: { speed: 0, duration: 0 } },
      { type: 'move_backward', speed: 21, duration: 0.25 },
      { type: 'dc_motor', port: 'M2', speed: -12.5, duration: 0.0001 }] };
    const res = await request(route);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const emitted = calls(res.body.pythonCode);
    assert.deepEqual(emitted.find(c => c.name === 'mbot2.forward').args, ['0']);
    assert.deepEqual(emitted.find(c => c.name === 'mbot2.backward').args, ['21']);
    assert.deepEqual(emitted.find(c => c.name === 'mbot2.starter_shield.dc_motor_set_power').args, ['2', '-12.5']);
    assert.match(res.body.pythonCode, /if 0 > 0:/, 'zero-duration motors must not dispatch');
    assert.match(res.body.pythonCode, /time.sleep\(0.001\)/, 'positive sub-tick motor holds get a tick');
    assert.equal(emitted.filter(c => c.name === 'mbot2.starter_shield.dc_motor_stop').length, 3);
    assert.deepEqual(res.body.program, completion.program);
  });
  test(`${route}: AV omission defaults and complete Stop match the runtime, not the palette`, async () => {
    completion = { program: [{ type: 'move_forward' }, { type: 'move_backward' },
      { type: 'dc_motor', port: 'M1' }, { type: 'turn_left' }, { type: 'turn_right' },
      { type: 'servo', port: 'S2' }, { type: 'play_tone' }, { type: 'wait' }, { type: 'stop' }] };
    const res = await request(route);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.program, completion.program);
    const emitted = calls(res.body.pythonCode);
    const args = name => emitted.filter(call => call.name === name).map(call => call.args);
    assert.equal(args('mbot2.forward')[0][0], '20');
    assert.equal(args('mbot2.backward')[0][0], '20');
    assert.ok(args('mbot2.turn').some(a => a[0] === '-0'));
    assert.ok(args('mbot2.turn').some(a => a[0] === '0'));
    assert.deepEqual(args('mbot2.starter_shield.servo_set_angle'), [['2', '90']]);
    assert.deepEqual(args('cyberpi.audio.play_tone'), [['440', '0.5']]);
    assert.ok(args('mbot2.starter_shield.dc_motor_set_power').some(a => a[0] === '1' && ['20', 'int(20)'].includes(a[1])));
    assert.ok(args('mbot2.EM_stop').length);
    assert.ok(args('mbot2.starter_shield.dc_motor_stop').length, 'Stop must include DC outputs');
    assert.ok(args('cyberpi.audio.stop').length, 'Stop must include audio');
    assert.doesNotMatch(res.body.pythonCode, /Running\\.\\.\\.|Done!/, 'preview must not inject display actions');
  });
  test(`${route}: wrapped zeros survive admitted AV preview without editor mutation`, async () => {
    completion = { program: [{ type: 'move_forward', _id: 'zero', params: { speed: 0, duration: 0 } }] };
    const res = await request(route);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.success, true);
    assert.deepEqual(res.body.program, completion.program);
    assert.ok(calls(res.body.pythonCode).some(call => call.name === 'mbot2.forward' && call.args[0] === '0'));
    assert.doesNotMatch(res.body.pythonCode, /forward\(50/);
    assert.deepEqual(mqtt.getHardwareStates(), {});
  });
}
