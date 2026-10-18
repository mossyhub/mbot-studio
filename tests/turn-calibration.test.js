import test from 'node:test';
import assert from 'node:assert/strict';
import { MqttService } from '../server/src/services/mqtt-service.js';
import { lowerProgram } from '../server/src/services/program-lowering.js';
import { programToMicroPython } from '../server/src/services/code-generator.js';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { getProgramBlockDefinition } from '../web/src/services/program-capabilities.js';
import { robotRoutes } from '../server/src/routes/robot.js';
import { aiRoutes } from '../server/src/routes/ai.js';

test('real Run, preflight and Python routes keep source/wire targets and reject >180 atomically', async () => {
  const previous = MqttService.instance;
  const invoke = async (router, path, body) => {
    const handler = router.stack.find(l => l.route?.path === path && l.route.methods.post).route.stack[0].handle;
    const res = { statusCode: 200, status(code) { this.statusCode=code;return this; }, json(body) { this.body=body;return this; } };
    try { await handler({ body },res); } catch(e) { res.statusCode=e.status || 500;res.body={error:e.message}; }
    return res;
  };
  try {
    for (const indexed of [false,true]) {
      const mqtt=service([calibration,'turn_angle_360',...(indexed?['program_indexed_v1']:[])]);
      MqttService.instance=mqtt;
      const packets=[]; mqtt.client={publish:(_topic,payload)=>packets.push(JSON.parse(payload))};
      const source=[{type:'turn_left',params:{angle:90},_id:'left'},{type:'turn_right',angle:180,_id:'right'}];
      const original=structuredClone(source);
      const preflight=await invoke(robotRoutes,'/program/validate',{program:source});
      assert.equal(preflight.body.runnable,true,JSON.stringify(preflight.body));assert.equal(packets.length,0);
      const preview=await invoke(aiRoutes,'/blocks-to-code',{blocks:source});
      assert.equal(preview.statusCode,200);assert.match(preview.body.code,/mbot2.turn\(-215\)/);assert.match(preview.body.code,/mbot2.turn\(396\)/);
      assert.equal(packets.length,0);
      const run=await invoke(robotRoutes,'/program',{program:source});
      assert.equal(run.statusCode,200,JSON.stringify(run.body));assert.equal(packets.length,1);
      const wire=packets[0].program;
      const commands=indexed?[...Buffer.from(wire.order,'hex')].map(i=>wire.commands[i]):wire;
      assert.deepEqual(commands.map(b=>[b.type,(b.params||b).angle]),[['turn_left',90],['turn_right',180]]);
      assert.deepEqual(source,original);
      const invalid=[{type:'turn_left',angle:360}];
      const validation=await invoke(robotRoutes,'/program/validate',{program:invalid});
      assert.equal(validation.body.runnable,false);assert.match(validation.body.error,/preserved.*edit/i);
      assert.equal((await invoke(robotRoutes,'/program',{program:invalid})).statusCode,400);
      assert.equal((await invoke(aiRoutes,'/blocks-to-code',{blocks:invalid})).statusCode,400);
      assert.equal(packets.length,1);assert.equal(invalid[0].angle,360);
    }
  } finally { MqttService.instance=previous; }
});

test('pure catalog overlays distinguish native/target angle and preserve catalog and imports', () => {
  const jsx = readFileSync(new URL('../web/src/components/BlocklyEditor.jsx', import.meta.url), 'utf8');
  const catalog = vm.runInNewContext(jsx.slice(jsx.indexOf('const NUM ='), jsx.indexOf('const CATEGORIES =')) + '\nBLOCK_DEFS');
  for (const type of ['turn_left', 'turn_right']) {
    for (const [status, max, label] of [[null,360,'native angle'],[service(['turn_angle_360']).robotStatusMetadata,360,'native angle'],[service().robotStatusMetadata,180,'target angle']]) {
      const def = getProgramBlockDefinition(type, catalog[type], status);
      const angle = def.slots.find(s => s.key === 'angle');
      assert.equal(angle.max, max); assert.equal(angle.label, label);
      if (max === 180) { assert.equal(angle.min, 0); assert.match(angle.title, /current chassis.*approximate.*surface/i); }
    }
    assert.equal(catalog[type].slots.find(s => s.key === 'angle').max, 360);
  }
});

test('actual status ingestion retains only whitelisted calibration metadata across sparse status, not new boots', async () => {
  const client = new EventEmitter();
  client.subscribe = () => {};
  const mqtt = new MqttService({ mqttConnect: () => client,
    diagnostics: { persist: true, record: () => {}, lastKnown: {} } });
  const connected = mqtt.connect();
  client.emit('connect');
  await connected;
  const turn_calibration = { reference: 'owner_visual', reference_degrees: 90,
    native_per90: { left: 215, right: 198 }, factors: { left: 215 / 90, right: 198 / 90 },
    provisional: { left: true, right: false }, max_angle: 180, extrapolated_above: 90 };
  const status = { ...service().robotStatusMetadata, boot: 'a', turn_calibration, arbitrary: 'not retained' };
  const emit = data => client.emit('message', `${mqtt.topicPrefix}/robot/status`, Buffer.from(JSON.stringify(data)));
  emit(status);
  assert.deepEqual(mqtt.getRobotStatus().turn_calibration, turn_calibration);
  assert.equal(mqtt.getRobotStatus().arbitrary, undefined);
  emit({ status: 'ready' });
  assert.deepEqual(mqtt.getRobotStatus().turn_calibration, turn_calibration);
  emit({ boot: 'b', status: 'ready' });
  assert.equal(mqtt.getRobotStatus().turn_calibration, undefined);
});

test('Python native reference applies directional factors once, skips zero and leaves legacy native angles alone', () => {
  for (const calibrated of [true, false]) {
    const mqtt = service(calibrated ? [calibration] : ['turn_angle_360']);
    const source = ['left', 'right'].flatMap(direction => [0, 45, 90, 180].map(angle => ({ type: `turn_${direction}`, params: { angle } })));
    const original = structuredClone(source);
    const code = programToMicroPython(source, {}, mqtt);
    // Execute only native stand-ins: no hardware imports, networking, or motion.
    const result = spawnSync('python3', ['-c', `import sys,types,json
calls=[]
sys.modules['mbot2']=types.SimpleNamespace(turn=lambda *a,**k:calls.append([a,k]))
sys.modules['cyberpi']=types.SimpleNamespace()
exec(sys.stdin.read())
print(json.dumps(calls))`], { input: code, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), (calibrated ? [-107.5,-215,-430,99,198,396] : [-45,-90,-180,45,90,180]).map(n => [[n], {}]));
    assert.deepEqual(source, original);
    if (calibrated) assert.match(code, /approximate.*surface/i);
  }
});

const calibration = 'chassis_turn_calibrated_v1';
function service(extra = [calibration, 'turn_angle_360']) {
  const mqtt = new MqttService({ mqttConnect: () => { throw Error('MQTT forbidden'); } });
  mqtt.connected = true;
  mqtt.robotLastSeen = mqtt.robotStatusLastSeen = Date.now();
  mqtt.robotStatusMetadata = { application: 'cooperative-v1', build: 'mbot-av-control-v1',
    armed: true, motion_enabled: true, capabilities: ['turn_left', 'turn_right', ...extra] };
  mqtt.client = { publish: () => assert.fail('No publication in contract tests') };
  return mqtt;
}

test('calibrated admission preserves target values and rejects old >180 programs explicitly', () => {
  const mqtt = service();
  for (const type of ['turn_left', 'turn_right']) {
    for (const angle of [0, 0.1, 45, 90, 180]) {
      const source = [{ type, params: { angle }, _id: 'original' }];
      const original = structuredClone(source);
      const lowered = lowerProgram(source, { validateBlock: b => mqtt.validateCooperativeProgram([b]) });
      const wire = mqtt.prepareProgram(lowered.program, 'test', 0, lowered.sourceMap);
      assert.equal((lowered.program[0].params || lowered.program[0]).angle, angle);
      assert.deepEqual(source, original);
      assert.ok(wire);
    }
    for (const angle of [180.01, 215, 360]) {
      const source = [{ type, angle }], original = structuredClone(source);
      assert.throws(() => mqtt.validateCooperativeProgram(source), /target angle.*0\.\.180.*preserved.*edit/i);
      assert.deepEqual(source, original);
    }
    for (const angle of [-1, null, '90', NaN, Infinity])
      assert.throws(() => mqtt.validateCooperativeProgram([{ type, angle }]), /angle/);
    assert.throws(() => mqtt.validateCooperativeProgram([{ type, angle: 90, speed: 0 }]), /parameter/);
  }
  for (const [extra, max] of [[['turn_angle_360'], 360], [[], 30], [[calibration], 180]]) {
    const native = service(extra);
    assert.doesNotThrow(() => native.validateCooperativeProgram([{ type: 'turn_left', angle: max }]));
    assert.throws(() => native.validateCooperativeProgram([{ type: 'turn_left', angle: max + 1 }]));
  }
});
