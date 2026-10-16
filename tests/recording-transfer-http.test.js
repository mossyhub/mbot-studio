// Loopback HTTP + actual MqttService event handlers. No broker connection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import express from 'express';
import { MqttService } from '../server/src/services/mqtt-service.js';
import { robotRoutes } from '../server/src/routes/robot.js';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t, { autoAck = true } = {}) {
  const audio = Buffer.alloc(600, 21), id = createHash('sha256').update(audio).digest('hex');
  const metadata = { id, sha256: id, size: audio.length, duration_ms: 1250 };
  const registry = { get: key => key === id ? metadata : null, read: async key => { assert.equal(key, id); return audio; } };
  const client = new EventEmitter(), packets = [], subscriptions = []; let connectOptions;
  client.connected = true; client.subscribe = (topic, opts) => subscriptions.push({ topic, opts });
  const incoming = (topic, data, packet = {}) => client.emit('message', `mbot-studio/${topic}`, Buffer.from(JSON.stringify(data)), packet);
  client.publish = (topic, raw, options, callback) => {
    const data = JSON.parse(raw); packets.push({ topic, data, options, callback }); callback?.();
    if (autoAck && topic.endsWith('/asset') && data.op !== 'abort') queueMicrotask(() => incoming('robot/asset_status', {
      transfer_id: data.transfer_id, boot: data.boot, id, op: data.op, ok: true,
      offset: data.op === 'chunk' ? data.offset + data.data.length / 2 : data.op === 'finish' ? audio.length : 0,
    }));
  };
  const mqtt = new MqttService({ recordingRegistry: registry, recordingTransferOptions: { ackTimeoutMs: 25, retries: 1 },
    mqttConnect: (url, opts) => { connectOptions = opts; return client; } });
  const diagnostics = mqtt.diagnostics;
  mqtt.diagnostics = { persist: true, record: (...args) => diagnostics.record(...args), get lastKnown() { return diagnostics.lastKnown; } };
  const connected = mqtt.connect(); client.emit('connect'); await connected;
  incoming('robot/status', { status: 'ready', application: 'cooperative-v1', build: 'mbot-av-control-v1', boot: 'boot-a', device: 'robot1',
    capabilities: ['recorded_audio_v1', 'play_recording', 'program_indexed_v1', 'wait', 'move_forward', 'drive_hold'], armed: true, motion_enabled: true });
  const previous = MqttService.instance; MqttService.instance = mqtt;
  const app = express(); app.use(express.json()); app.use('/api/robot', robotRoutes);
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { mqtt.recordingTransfer?.invalidate('test teardown'); clearInterval(mqtt.diagnosticTimer); MqttService.instance = previous; await new Promise(resolve => server.close(resolve)); });
  const post = async (path, body = {}, signal) => { const res = await fetch(`http://127.0.0.1:${server.address().port}/api/robot${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal }); return { status: res.status, body: await res.json() }; };
  return { mqtt, client, packets, post, id, metadata, registry, incoming, subscriptions, connectOptions };
}

test('HTTP preflight is pure; Run syncs trusted clip before the first Program movement', async t => {
  const f = await fixture(t);
  const program = [{ type: 'move_forward', duration: 0.1 }, { type: 'play_recording', recording: f.id, _id: 'voice' }];
  const preflight = await f.post('/program/validate', { program });
  assert.equal(preflight.body.runnable, true, preflight.body.error);
  assert.equal(preflight.body.requestedHoldSeconds, 1.35);
  assert.equal(f.packets.length, 0);
  const run = await f.post('/program', { program });
  assert.equal(run.status, 200, run.body.error);
  assert.equal(run.body.sent, true);
  assert.deepEqual(f.packets.map(p => p.topic.split('/').at(-1)), ['asset', 'asset', 'asset', 'asset', 'program']);
  assert.equal(f.packets[3].data.op, 'finish');
  assert.deepEqual(f.packets[4].data.program.commands[1], { type: 'play_recording', recording: f.id, duration: 1.25 });
  assert.equal(f.connectOptions.queueQoSZero, false);
  assert.ok(f.subscriptions.some(s => s.topic.endsWith('/robot/asset_status') && s.opts?.qos === 0));
  assert.equal(f.mqtt.recordingTransfer.getVerification(f.id).verified, true);
});

async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await pause(2); }
  assert.fail('isolated test did not reach expected state');
}

test('HTTP Stop cancels pending transfer and stale ACKs cannot publish Program', async t => {
  const f = await fixture(t, { autoAck: false });
  const run = f.post('/program', { program: [{ type: 'play_recording', recording: f.id }] });
  await waitFor(() => f.packets.length > 0);
  const begin = f.packets[0].data;
  assert.equal((await f.post('/stop')).status, 200);
  const result = await run;
  assert.equal(result.status, 409);
  f.incoming('robot/asset_status', { ...begin, offset: 0, ok: true });
  await pause(70);
  assert.equal(f.packets.some(p => p.topic.endsWith('/program')), false);
  assert.equal(f.packets.filter(p => p.data.op === 'begin').length, 1);
  assert.equal(f.mqtt.recordingTransfer.getVerification(f.id), null);
});

test('disconnect and OTA synchronously revoke loading sessions, even after fresh status returns', async t => {
  for (const event of ['offline', 'close', 'error', 'ota']) {
    const f = await fixture(t); let release;
    f.registry.read = () => new Promise(resolve => { release = resolve; });
    const submission = f.mqtt.sendProgram([{ type: 'play_recording', recording: f.id, duration: 1.25 }]);
    const rejected = assert.rejects(submission, /offline|closed|error|OTA/i);
    if (event === 'ota') f.incoming('ota/robot1/request', { op: 'begin' });
    else f.client.emit(event, new Error('test transport error'));
    assert.equal(f.mqtt.recordingTransfer.active, null);
    await rejected;
    f.mqtt.connected = true; f.mqtt.robotStatusLastSeen = f.mqtt.robotLastSeen = Date.now();
    release(Buffer.alloc(600, 21)); await pause(5);
    assert.equal(f.packets.length, 0);
  }
});

test('transfer reservation blocks competing Program, command and drive starts', async t => {
  const f = await fixture(t, { autoAck: false });
  const run = f.post('/program', { program: [{ type: 'play_recording', recording: f.id }] });
  await waitFor(() => f.packets.length > 0);
  const count = f.packets.length;
  assert.throws(() => f.mqtt.sendProgram([{ type: 'wait', duration: 0 }]), /transfer/i);
  assert.throws(() => f.mqtt.sendCommand({ type: 'wait', duration: 0 }), /transfer/i);
  assert.throws(() => f.mqtt.driveHold.submit({}, { type: 'drive_start', hold_id: randomUUID(), direction: 'forward', speed: 20 }), /transfer/i);
  assert.equal(f.packets.length, count);
  const command = await f.post('/command', { command: { type: 'wait', duration: 0 } });
  assert.equal(command.status, 409);
  assert.equal(command.body.code, 'RECORDING_TRANSFER_REJECTED');
  f.mqtt.emergencyStop(); await run;
});

test('HTTP request disconnect revokes only its pending transfer before any delayed Program', async t => {
  const f = await fixture(t, { autoAck: false });
  f.mqtt.recordingTransfer.ackTimeoutMs = 1000;
  const controller = new AbortController();
  const run = f.post('/program', { program: [{ type: 'play_recording', recording: f.id }] }, controller.signal);
  const rejected = assert.rejects(run, /abort/i);
  await waitFor(() => f.packets.length > 0);
  controller.abort(); await rejected;
  await waitFor(() => f.mqtt.recordingTransfer.active === null);
  const before = f.packets.length;
  f.incoming('robot/asset_status', { ...f.packets[0].data, ok: true, offset: 0 });
  await pause(30);
  assert.equal(f.packets.length, before);
  assert.equal(f.packets.some(p => p.topic.endsWith('/program')), false);
});

test('sync adapter verifies only finish ACK, deletion removes receipt, missing delete is safe absence', async t => {
  const f = await fixture(t);
  assert.equal(f.mqtt.recordingTransfer.getStatus().idle, true);
  await f.mqtt.recordingTransfer.sync({ metadata: { id: f.id, bytes: 600, durationMs: 1250 }, audio: Buffer.alloc(600, 21) }, { bootId: 'boot-a' });
  assert.equal(f.mqtt.recordingTransfer.getVerification(f.id).verified, true);
  await f.mqtt.recordingTransfer.delete(f.id);
  assert.equal(f.mqtt.recordingTransfer.getVerification(f.id), null);
  const originalPublish = f.client.publish;
  f.client.publish = (topic, raw, opts, cb) => {
    const body = JSON.parse(raw);
    if (body.op !== 'delete') return originalPublish(topic, raw, opts, cb);
    queueMicrotask(() => f.incoming('robot/asset_status', { ...body, ok: false, error: 'missing', offset: 0 }));
    cb?.();
  };
  await f.mqtt.recordingTransfer.delete(f.id);
  f.mqtt.emergencyStop();
  assert.equal(f.mqtt.recordingTransfer.getVerification(f.id), null);
});

test('receipt is revoked permanently on capability withdrawal, even without an active transfer', async t => {
  const f = await fixture(t);
  await f.post('/program', { program: [{ type: 'play_recording', recording: f.id }] });
  assert.equal(f.mqtt.recordingTransfer.getVerification(f.id).verified, true);
  const saved = structuredClone(f.mqtt.robotStatusMetadata);
  f.incoming('robot/status', { ...saved, capabilities: ['wait'], status: 'ready' });
  assert.equal(f.mqtt.recordingTransfer.getVerification(f.id), null);
  f.incoming('robot/status', { ...saved, status: 'ready' });
  assert.equal(f.mqtt.recordingTransfer.getVerification(f.id), null);
});

test('malformed capabilities never throw inside MQTT status delivery', async t => {
  const f = await fixture(t);
  for (const capabilities of [null, 'recorded_audio_v1', { supported_types: ['recorded_audio_v1'] }]) {
    assert.doesNotThrow(() => f.incoming('robot/status', { status: 'ready', capabilities, motion_enabled: true, armed: true }));
    assert.equal(f.mqtt.recordingTransfer.getVerification(f.id), null);
    assert.deepEqual(f.mqtt.recordingTransfer.getStatus().capabilities, []);
  }
});

test('direct recording cannot bypass trusted metadata or confirmed AV runtime', async t => {
  const f = await fixture(t);
  assert.throws(() => f.mqtt.sendProgram([{ type: 'play_recording', recording: f.id, duration: 3 }]), /metadata/);
  assert.throws(() => f.mqtt.sendCommand({ type: 'play_recording', recording: f.id, duration: 1.25 }), /Program preparation/);
  f.mqtt.robotStatusMetadata = {};
  assert.throws(() => f.mqtt.sendProgram([{ type: 'play_recording', recording: f.id, duration: 1.25 }]), /runtime|unsupported/i);
  assert.equal(f.packets.length, 0);
});

test('flat recording Programs preserve wrapper/source metadata and immutable submission during transfer', async t => {
  const f = await fixture(t);
  f.mqtt.robotStatusMetadata.capabilities = f.mqtt.robotStatusMetadata.capabilities.filter(cap => cap !== 'program_indexed_v1');
  let release;
  f.registry.read = () => new Promise(resolve => { release = resolve; });
  const program = [{ type: 'play_recording', params: { recording: f.id, duration: 1.25 }, _id: 'voice' }];
  const sending = f.mqtt.sendProgram(program, 'immutable');
  program[0].params.recording = 'b'.repeat(64); program[0].params.duration = 3;
  release(Buffer.alloc(600, 21));
  assert.equal(await sending, true);
  assert.deepEqual(f.packets.at(-1).data.program, [{ type: 'play_recording', params: { recording: f.id, duration: 1.25 }, _id: 'voice' }]);
});
