import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('journal bounds, corrupt tail recovery, redaction and disk failure are safe', async () => {
  const { RobotDiagnostics } = await import('../server/src/services/robot-diagnostics.js');
  const dir = temp();
  try {
    const r = new RobotDiagnostics({ dataDir: dir, maxEntries: 8, maxBytes: 4096 });
    for (let i = 0; i < 40; i++) r.record('incoming', { topic: 'robot/log', payload: { i, password: 'secret-value', message: 'mqtt://user:pass@host password=hidden' } });
    await r.flush();
    assert.ok(r.snapshot().events.length <= 8);
    assert.ok(fs.statSync(r.file).size <= 4096);
    assert.doesNotMatch(fs.readFileSync(r.file, 'utf8'), /secret-value|user:pass|hidden/);
    fs.appendFileSync(r.file, '{broken');
    const recovered = new RobotDiagnostics({ dataDir: dir, maxEntries: 8, maxBytes: 4096 });
    assert.equal(recovered.snapshot().lastKnown.log.payload.i, 39);
    assert.equal(recovered.snapshot().recording.corruptLines, 1);
    await recovered.flush();
    const failed = new RobotDiagnostics({ dataDir: path.join(dir, 'not-dir') });
    fs.writeFileSync(path.join(dir, 'not-dir'), 'block');
    assert.doesNotThrow(() => failed.record('publish_intent', { type: 'emergency_stop' }));
    await failed.flush();
    assert.equal(failed.snapshot().recording.healthy, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('record never serializes disk journal synchronously and sparse status retains boot identity', async () => {
  const { RobotDiagnostics } = await import('../server/src/services/robot-diagnostics.js');
  const dir = temp();
  const r = new RobotDiagnostics({ dataDir: dir });
  await r.flush();
  const serialize = r.serialize.bind(r);
  let serialized = false;
  r.serialize = () => { serialized = true; return serialize(); };
  r.record('incoming', { topic: 'robot/status', payload: { boot: 'boot-a', build: 'build-a', sha256: 'digest-a', capabilities: ['turn_right'] } });
  r.record('incoming', { topic: 'robot/status', payload: { status: 'ready' } });
  assert.equal(serialized, false);
  assert.equal(r.lastKnown.status.payload.boot, 'boot-a');
  assert.equal(r.lastKnown.status.payload.sha256, 'digest-a');
  assert.deepEqual(r.lastKnown.status.payload.capabilities, ['turn_right']);
  r.record('incoming', { topic: 'robot/status', payload: { boot: 'boot-b' } });
  assert.equal(r.lastKnown.status.payload.sha256, undefined);
  assert.equal(r.lastKnown.status.payload.capabilities, undefined);
  await r.flush();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('unconnected service construction never writes the default data directory', async () => {
  const { MqttService } = await import('../server/src/services/mqtt-service.js');
  const dir = temp();
  const old = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  try {
    const service = new MqttService();
    await service.diagnostics.flush();
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    if (old === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = old;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sampling-only and malformed sensor messages do not rejuvenate actual readings', async () => {
  const { RobotDiagnostics } = await import('../server/src/services/robot-diagnostics.js');
  const r = new RobotDiagnostics({ persist: false });
  r.record('incoming', { topic: 'robot/sensors', payload: { battery: 50, sampling: false } });
  const reading = r.snapshot().lastKnown.sensors;
  r.record('incoming', { topic: 'robot/sensors', payload: { sampling: true } });
  r.record('incoming', { topic: 'robot/sensors', payload: null });
  assert.deepEqual(r.lastKnown.sensors, { payload: reading.payload, receivedAt: reading.receivedAt });
  assert.equal(r.lastKnown.sensorReadState.payload.sampling, true);
});

test('same-boot status churn cannot accumulate arbitrary checkpoint keys', async () => {
  const { RobotDiagnostics } = await import('../server/src/services/robot-diagnostics.js');
  const r = new RobotDiagnostics({ persist: false });
  r.record('incoming', { topic: 'robot/status', payload: { boot: 'a', build: 'b', capabilities: ['stop'] } });
  for (let i = 0; i < 180; i++) {
    const payload = Object.fromEntries(Array.from({ length: 100 }, (_, j) => [`key_${i}_${j}`, 'x'.repeat(70)]));
    r.record('incoming', { topic: 'robot/status', payload });
  }
  assert.ok(Object.keys(r.lastKnown.status.payload).length <= 128);
  assert.equal(r.lastKnown.status.payload.boot, 'a');
  assert.equal(r.lastKnown.status.payload.build, 'b');
  assert.deepEqual(r.lastKnown.status.payload.capabilities, ['stop']);
  assert.ok(Buffer.byteLength(r.serialize()) <= r.maxBytes);
});

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mbot-recorder-'));
test('invalid checkpoint entries are counted and cannot crash snapshots', async () => {
  const { RobotDiagnostics } = await import('../server/src/services/robot-diagnostics.js');
  const dir = temp();
  try {
    fs.writeFileSync(path.join(dir, 'robot-diagnostics.jsonl'), JSON.stringify({ checkpoint: {
      sensors: null, status: { payload: {}, receivedAt: 'bad' }, log: [],
      execution: { payload: { state: 'done' }, receivedAt: 10 }, alien: { payload: {}, receivedAt: 10 }
    } }) + '\n');
    const r = new RobotDiagnostics({ dataDir: dir });
    assert.doesNotThrow(() => r.snapshot());
    assert.equal(r.snapshot().recording.corruptLines, 4);
    assert.equal(r.snapshot().recording.healthy, false);
    assert.deepEqual(Object.keys(r.lastKnown), ['execution']);
    await r.flush();
    assert.equal(r.snapshot().recording.healthy, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('restored events are validated and redacted before exposure or replay', async () => {
  const { RobotDiagnostics } = await import('../server/src/services/robot-diagnostics.js');
  const dir = temp();
  try {
    fs.writeFileSync(path.join(dir, 'robot-diagnostics.jsonl'), [
      { kind: 'incoming', time: 10, data: { topic: 'robot/log', payload: { password: 'disk-secret', message: 'token=private' } }, extra: 'password=private' },
      { kind: 'incoming', time: 10, data: { topic: 123, payload: {} } },
      { kind: {}, time: 10, data: [] }
    ].map(e => JSON.stringify(e)).join('\n'));
    const r = new RobotDiagnostics({ dataDir: dir });
    assert.doesNotMatch(JSON.stringify(r.snapshot()), /disk-secret|private/);
    assert.equal(r.snapshot().recording.corruptLines, 2);
    await r.flush();
    assert.doesNotMatch(fs.readFileSync(r.file, 'utf8'), /disk-secret|private/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('restored checkpoint has an independent byte cap even after redaction expansion', async () => {
  const { RobotDiagnostics } = await import('../server/src/services/robot-diagnostics.js');
  const dir = temp();
  try {
    const disk = JSON.stringify({ checkpoint: { log: { receivedAt: 1, payload: { message: 'token=a '.repeat(450) } } } });
    assert.ok(Buffer.byteLength(disk) < 4096);
    fs.writeFileSync(path.join(dir, 'robot-diagnostics.jsonl'), disk + '\n');
    const r = new RobotDiagnostics({ dataDir: dir, maxBytes: 4096 });
    assert.ok(Buffer.byteLength(JSON.stringify(r.snapshot().lastKnown)) <= 2048);
    assert.ok(Buffer.byteLength(r.serialize()) <= 4096);
    await r.flush();
    assert.ok(fs.statSync(r.file).size <= 4096);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('recorder persists actual sensor receive time across Studio restart', async () => {
  const { RobotDiagnostics } = await import('../server/src/services/robot-diagnostics.js');
  const dir = temp();
  try {
    const recorder = new RobotDiagnostics({ dataDir: dir });
    recorder.record('incoming', { topic: 'robot/sensors', payload: { battery: 50, sampling: false } });
    await recorder.flush();
    const before = recorder.snapshot().lastKnown.sensors;
    const restarted = new RobotDiagnostics({ dataDir: dir });
    const after = restarted.snapshot().lastKnown.sensors;
    assert.equal(after.receivedAt, before.receivedAt);
    assert.equal(after.payload.battery, 50);
    assert.ok(after.ageMs >= before.ageMs);
    assert.equal(after.payload.voltage, undefined);
    assert.ok(restarted.snapshot().events.some(e => e.kind === 'studio_start'));
    await restarted.flush();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
