// In-memory transport only: real MQTT admission/event handlers, no broker or hardware.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { MqttService } from '../server/src/services/mqtt-service.js';
import { recordingTransferStatus } from '../web/src/services/voice-recording.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function clip(size = 10240, fill = 21) {
  const audio = Buffer.alloc(size, fill), id = createHash('sha256').update(audio).digest('hex');
  return { id, sha256: id, size, duration_ms: 1250, audio };
}
async function fixture(t, clips = [clip()]) {
  // Keep real event handling without flooding node:test's IPC with status logs.
  t.mock.method(console, 'log', () => {});
  const packets = [], reads = [], client = new EventEmitter();
  const metadata = new Map(clips.map(({ audio, ...meta }) => [meta.id, meta]));
  const registry = { get: id => metadata.get(id), read: async id => {
    reads.push(id); return clips.find(asset => asset.id === id).audio;
  } };
  client.connected = true; client.subscribe = () => {};
  const incoming = (topic, data) => client.emit('message', `mbot-studio/${topic}`, Buffer.from(JSON.stringify(data)), {});
  let currentId, currentSize;
  const mqtt = new MqttService({ recordingRegistry: registry, mqttConnect: () => client });
  // Disable disk diagnostics while retaining real event-handler behavior.
  const diagnostics = mqtt.diagnostics;
  mqtt.diagnostics = { persist: true, record: (...args) => diagnostics.record(...args), get lastKnown() { return diagnostics.lastKnown; } };
  const transfer = mqtt.recordingTransfer;
  client.publish = (topic, raw, options, callback) => {
    const data = JSON.parse(raw); packets.push({ topic, data, options }); callback?.();
    if (topic.endsWith('/program')) {
      assert.ok(transfer.active, 'reservation must survive through actual Program publication');
      assert.throws(() => mqtt.sendProgram([{ type: 'wait', duration: 0 }]), /transfer/);
    }
    if (!topic.endsWith('/asset') || data.op === 'abort') return;
    if (data.id) currentId = data.id;
    if (data.op === 'begin') currentSize = data.size;
    const ack = { transfer_id: data.transfer_id, boot: data.boot, id: currentId, op: data.op, ok: true,
      offset: data.op === 'chunk' ? data.offset + data.data.length / 2 : data.op === 'finish' ? currentSize : 0 };
    queueMicrotask(() => incoming('robot/asset_status', ack));
  };
  const connected = mqtt.connect(); client.emit('connect'); await connected;
  const status = { status: 'ready', application: 'cooperative-v1', build: 'mbot-av-control-v1', boot: 'boot-a',
    sha256: 'firmware-a', device: 'robot1', capabilities: ['recorded_audio_v1', 'play_recording', 'program_indexed_v1', 'wait'],
    armed: true, motion_enabled: true };
  incoming('robot/status', status);
  t.after(() => { transfer.invalidate('test teardown'); clearInterval(mqtt.diagnosticTimer); });
  const run = (selected = clips) => mqtt.sendProgram(selected.map(asset => ({ type: 'play_recording', recording: asset.id, duration: metadata.get(asset.id).duration_ms / 1000 })));
  return { mqtt, transfer, client, registry, metadata, packets, reads, clips, incoming, status, run };
}

test('same-boot repeated Run rehashes trusted bytes and publishes only Program, without asset packets', async t => {
  const f = await fixture(t);
  assert.equal(await f.run(), true);
  assert.deepEqual(f.packets.filter(p => p.data.op && p.data.op !== 'chunk').map(p => p.data.op), ['begin', 'finish']);
  assert.equal(f.packets.filter(p => p.data.op === 'chunk').length, 20);
  f.packets.length = 0;
  assert.equal(await f.run(), true);
  assert.deepEqual(f.reads, [f.clips[0].id, f.clips[0].id]);
  assert.deepEqual(f.packets.map(p => p.topic), ['mbot-studio/robot/program']);
  assert.equal(f.packets[0].data.program.commands[0].recording, f.clips[0].id);
  assert.equal(f.transfer.active, null);
});

test('reuse progress remains consumable by the real client and never invents transferred/ACKed bytes', async t => {
  const f = await fixture(t);
  await f.run();
  const snapshots = [], update = f.transfer.updateProgress.bind(f.transfer);
  f.transfer.updateProgress = (session, values) => { update(session, values); snapshots.push(f.transfer.getProgress()); };
  await f.run();
  for (const snapshot of snapshots) {
    await recordingTransferStatus({ fetcher: async () => ({ ok: true, json: async () => snapshot }) });
    assert.equal(snapshot.ackedBytes, 0);
    assert.equal(snapshot.totalBytes, null);
    assert.ok(!['beginning', 'transferring', 'verifying'].includes(snapshot.phase));
  }
  assert.equal(snapshots.at(-1).phase, 'succeeded');
});

for (const cachedFirst of [true, false]) {
  test(`mixed two-asset Run transfers only the missing clip (cached first: ${cachedFirst})`, async t => {
    const f = await fixture(t, [clip(600), clip(700)]);
    await f.run([f.clips[0]]);
    f.packets.length = 0; f.reads.length = 0;
    const selected = cachedFirst ? f.clips : [...f.clips].reverse();
    assert.equal(await f.run(selected), true);
    assert.deepEqual(f.reads, selected.map(asset => asset.id));
    assert.deepEqual(f.packets.filter(p => p.data.op === 'begin').map(p => p.data.id), [f.clips[1].id]);
    assert.equal(f.packets.filter(p => p.data.op === 'finish').length, 1);
    assert.equal(f.packets.at(-1).topic, 'mbot-studio/robot/program');
    f.packets.length = 0;
    await f.run(selected);
    assert.deepEqual(f.packets.map(p => p.topic), ['mbot-studio/robot/program']);
  });
}

test('receipt stores an immutable trusted metadata snapshot; a changed duration transfers instead of reusing', async t => {
  const f = await fixture(t), asset = f.clips[0];
  await f.run();
  const receipt = f.transfer.verifications.get(asset.id);
  assert.deepEqual(receipt.metadata, f.metadata.get(asset.id));
  assert.equal(Object.isFrozen(receipt.metadata), true);
  f.metadata.get(asset.id).duration_ms = 1500;
  assert.equal(receipt.metadata.duration_ms, 1250);
  f.packets.length = 0;
  const publish = f.client.publish;
  f.client.publish = (topic, raw, ...args) => {
    if (JSON.parse(raw).op === 'begin') assert.equal(f.transfer.getVerification(asset.id), null, 'mismatching receipt revoked before replacement transfer');
    return publish(topic, raw, ...args);
  };
  await f.run();
  assert.equal(f.packets[0].data.op, 'begin');
  assert.equal(f.packets[0].data.duration_ms, 1500);
  assert.equal(f.packets.at(-1).data.program.commands[0].duration, 1.5);
  assert.equal(f.transfer.verifications.get(asset.id).metadata.duration_ms, 1500);
});

for (const field of ['id', 'sha256', 'size', 'duration_ms', 'missing metadata']) {
  test(`incomplete/mismatching receipt ${field} cannot skip transfer`, async t => {
    const f = await fixture(t), asset = f.clips[0];
    await f.run();
    const receipt = f.transfer.verifications.get(asset.id);
    if (field === 'missing metadata') delete receipt.metadata;
    else receipt.metadata = { ...receipt.metadata, [field]: field === 'id' || field === 'sha256' ? 'f'.repeat(64) : 1 };
    f.packets.length = 0;
    await f.run();
    assert.equal(f.packets[0].data.op, 'begin');
    assert.equal(f.packets.at(-1).topic, 'mbot-studio/robot/program');
  });
}

const invalidations = {
  Stop: f => f.mqtt.emergencyStop(),
  offline: f => f.client.emit('offline'),
  close: f => f.client.emit('close'),
  error: f => f.client.emit('error', new Error('fixture transport failure')),
  reboot: f => f.incoming('robot/status', { ...f.status, boot: 'boot-b' }),
  firmware: f => f.incoming('robot/status', { ...f.status, sha256: 'firmware-b' }),
  device: f => f.incoming('robot/status', { ...f.status, device: 'robot2' }),
  application: f => f.incoming('robot/status', { ...f.status, application: 'different-app' }),
  build: f => f.incoming('robot/status', { ...f.status, build: 'different-build' }),
  capability: f => f.incoming('robot/status', { ...f.status, capabilities: ['wait'] }),
  OTA: f => f.incoming('ota/robot1/request', { op: 'begin' }),
  delete: f => f.transfer.delete(f.clips[0].id),
  registry: f => f.mqtt.setRecordingRegistry(f.registry),
  stale: f => { f.mqtt.robotStatusLastSeen = 1; f.transfer.checkStatus(); },
  transport: f => { f.client.connected = false; f.transfer.checkStatus(); },
};
for (const [name, invalidate] of Object.entries(invalidations)) {
  test(`${name} invalidates a completed receipt; restored same identity requires cold transfer`, async t => {
    const f = await fixture(t);
    await f.run();
    await invalidate(f);
    assert.equal(f.transfer.getVerification(f.clips[0].id), null);
    f.client.connected = true; f.mqtt.connected = true;
    f.incoming('robot/status', f.status);
    f.packets.length = 0;
    assert.equal(await f.run(), true);
    assert.equal(f.packets[0].data.op, 'begin');
    assert.equal(f.packets.at(-1).topic, 'mbot-studio/robot/program');
  });
}

for (const cached of [true, false]) {
  test(`all trusted bytes validate before any publication when corrupt clip is cached: ${cached}`, async t => {
    const f = await fixture(t, [clip(600), clip(700)]);
    if (cached) await f.run();
    else await f.run([f.clips[0]]);
    f.packets.length = 0;
    const read = f.registry.read;
    f.registry.read = async id => {
      const bytes = Buffer.from(await read(id));
      if (id === f.clips[1].id) bytes[0] ^= 1;
      return bytes;
    };
    await assert.rejects(f.run(), /digest/);
    assert.deepEqual(f.packets, []);
    assert.equal(f.transfer.getVerification(f.clips[0].id), null);
    f.registry.read = read;
    assert.equal(await f.run(), true);
    assert.equal(f.packets[0].data.op, 'begin');
  });
}

for (const [name, invalidate] of Object.entries(invalidations).filter(([name]) => !['delete', 'registry'].includes(name))) {
  test(`${name} after a cached read resolves fences its continuation and final Program`, async t => {
    const f = await fixture(t);
    await f.run(); f.packets.length = 0;
    const read = f.registry.read; let release;
    f.registry.read = () => new Promise(resolve => { release = resolve; });
    const pending = f.run(), rejected = assert.rejects(pending);
    assert.throws(() => f.mqtt.sendCommand({ type: 'wait', duration: 0 }), /transfer/);
    release(f.clips[0].audio);
    await invalidate(f); // resolved promise has not resumed before synchronous invalidation
    await rejected; await tick();
    assert.equal(f.packets.some(p => p.topic.endsWith('/program') || p.topic.endsWith('/asset')), false);
    f.registry.read = read; f.client.connected = true; f.mqtt.connected = true;
    f.incoming('robot/status', f.status);
    f.packets.length = 0;
    assert.equal(await f.run(), true);
    assert.equal(f.packets[0].data.op, 'begin');
  });
}

for (const state of ['running', 'drive', 'stale', 'capability', 'boot']) {
  test(`cached Run retains ${state} admission fence after read`, async t => {
    const f = await fixture(t); await f.run(); f.packets.length = 0;
    f.registry.read = async () => {
      if (state === 'running') f.mqtt.robotState = 'running';
      if (state === 'drive') f.mqtt.driveHold.active = {};
      if (state === 'stale') f.mqtt.robotStatusLastSeen = 1;
      if (state === 'capability') f.mqtt.robotStatusMetadata.capabilities = [];
      if (state === 'boot') f.mqtt.robotStatusMetadata.boot = 'boot-b';
      return f.clips[0].audio;
    };
    await assert.rejects(f.run());
    assert.deepEqual(f.packets, []);
  });
}

test('request abort after resolved cached read cannot commit or disturb a new owner', async t => {
  const f = await fixture(t), asset = f.clips[0];
  await f.run(); f.packets.length = 0;
  const controller = new AbortController(); let release;
  const old = f.transfer.run([asset.id], () => new Promise(resolve => { release = resolve; }),
    () => assert.fail('canceled cached commit'), { signal: controller.signal });
  const rejected = assert.rejects(old, /cancel|abort/i);
  release(asset); controller.abort();
  const fresh = f.run();
  await rejected; assert.equal(await fresh, true);
  assert.deepEqual(f.packets.map(p => p.topic), ['mbot-studio/robot/program']);
  assert.equal(f.transfer.getVerification(asset.id).verified, true);
});
