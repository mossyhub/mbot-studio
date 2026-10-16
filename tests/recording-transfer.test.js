import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MqttService } from '../server/src/services/mqtt-service.js';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function asset(size = 1100) {
  const audio = Buffer.alloc(size, 37), id = createHash('sha256').update(audio).digest('hex');
  return { id, sha256: id, size, duration_ms: 1000, audio };
}
async function fixture(options = {}) {
  const { RecordingTransfer } = await import('../server/src/services/recording-transfer.js');
  const mqtt = new MqttService(), packets = [];
  mqtt.connected = true; mqtt.robotLastSeen = mqtt.robotStatusLastSeen = Date.now(); mqtt.robotState = 'ready';
  mqtt.robotStatusMetadata = { application: 'cooperative-v1', build: 'mbot-av-control-v1', boot: 'boot-A', capabilities: ['recorded_audio_v1', 'play_recording'] };
  const transfer = new RecordingTransfer(mqtt, { ackTimeoutMs: 20, verificationTimeoutMs: 20, retries: 1, sessionTimeoutMs: 1000, ...options });
  let currentId, currentSize;
  mqtt.client = { connected: true, publish(topic, payload, opts, cb) {
    const data = JSON.parse(payload); packets.push({ topic, data, opts, payload }); cb?.();
    if (data.id) currentId = data.id;
    if (data.op === 'begin') currentSize = data.size;
    if (options.onPacket) return options.onPacket(data, transfer);
    queueMicrotask(() => transfer.handleAck({ transfer_id: data.transfer_id, boot: data.boot, op: data.op, ok: true,
      id: currentId, offset: data.op === 'chunk' ? data.offset + data.data.length / 2 : data.op === 'finish' ? currentSize : 0 }));
  } };
  return { mqtt, transfer, packets };
}

test('bounded immutable bytes transfer completely before commit, explicit QoS0 no retain', async () => {
  const { transfer, packets } = await fixture();
  const clip = asset(); let committed = false;
  await transfer.run([clip.id], async () => clip, () => { committed = true; assert.equal(packets.at(-1).data.op, 'finish'); });
  assert.equal(committed, true);
  assert.deepEqual(packets.map(p => p.data.op), ['begin', 'chunk', 'chunk', 'chunk', 'finish']);
  const begin = packets[0].data;
  assert.deepEqual(Object.keys(begin).sort(), ['op', 'transfer_id', 'boot', 'id', 'size', 'sha256', 'duration_ms'].sort());
  assert.equal(begin.sha256, clip.id);
  for (const packet of packets) {
    assert.equal(packet.topic, 'mbot-studio/robot/asset');
    assert.deepEqual(packet.opts, { qos: 0, retain: false });
    assert.equal(packet.data.boot, 'boot-A');
    if (packet.data.op === 'chunk') assert.ok(packet.data.data.length <= 1024);
  }
  assert.equal(Buffer.concat(packets.filter(p => p.data.op === 'chunk').map(p => Buffer.from(p.data.data, 'hex'))).equals(clip.audio), true);
  assert.equal(transfer.active, null);
});

test('ACK timeout retries exact bytes and bounds failure without committing', async () => {
  const { transfer, packets } = await fixture({ onPacket() {} });
  const clip = asset(); let committed = false;
  const result = transfer.run([clip.id], async () => clip, () => { committed = true; });
  await assert.rejects(Promise.race([result, pause(150).then(() => { throw new Error('unbounded'); })]), /ACK timeout/);
  assert.equal(committed, false);
  assert.deepEqual(packets.slice(0, 2).map(p => p.payload), [packets[0].payload, packets[0].payload]);
  assert.equal(packets.filter(p => p.data.op === 'begin').length, 2);
  const count = packets.length; await pause(60); assert.equal(packets.length, count);
});

test('one exclusive idle reservation fences cancellation even while bytes load', async () => {
  const { transfer, packets } = await fixture();
  const clip = asset(); let release;
  const result = transfer.run([clip.id], () => new Promise(resolve => { release = resolve; }), () => assert.fail('canceled commit'));
  const rejected = assert.rejects(result, /Stop/);
  await assert.rejects(transfer.run([clip.id], async () => clip), /active|busy|progress/i);
  transfer.invalidate('Stop');
  await rejected;
  release(clip); await pause(50);
  assert.equal(packets.length, 0);
  await transfer.run([clip.id], async () => clip);
  assert.equal(packets.at(-1).data.op, 'finish');
});

test('every send is fenced by boot, transport, capability, freshness and idle state', async () => {
  for (const mutate of [mqtt => { mqtt.connected = false; }, mqtt => { mqtt.client.connected = false; },
    mqtt => { mqtt.robotStatusMetadata.boot = 'boot-B'; }, mqtt => { mqtt.robotStatusMetadata.capabilities = []; },
    mqtt => { mqtt.robotStatusLastSeen = 1; }, mqtt => { mqtt.robotState = 'running'; },
    mqtt => { mqtt.robotStatusMetadata.sha256 = 'new-build'; }, mqtt => { mqtt.driveHold.active = {}; }]) {
    const { transfer, mqtt, packets } = await fixture({ onPacket() {} });
    const clip = asset(); const result = transfer.run([clip.id], async () => clip, () => assert.fail('fenced commit'));
    await pause(1); const begin = packets[0].data;
    mutate(mqtt);
    transfer.handleAck({ ...begin, ok: true, offset: 0 });
    await assert.rejects(result);
    assert.equal(packets.filter(p => p.data.op === 'chunk').length, 0);
  }
});

test('all clips validate before transfer and session loading has an absolute timeout', async () => {
  const { transfer, packets } = await fixture({ sessionTimeoutMs: 25 });
  const clip = asset(), bad = asset(2); bad.audio[0] = 0;
  await assert.rejects(transfer.run([clip.id, bad.id], async id => id === clip.id ? clip : bad), /digest/);
  assert.equal(packets.length, 0);
  await assert.rejects(transfer.run([clip.id], () => new Promise(() => {})), /session timeout/);
  await assert.rejects(transfer.run(Array.from({ length: 9 }, (_, i) => i.toString(16).repeat(64)), async () => clip), /8/);
  assert.equal(packets.length, 0);
});

test('delete and status use bounded identity-fenced idle protocol without asset bytes', async () => {
  const { transfer, packets, mqtt } = await fixture();
  const id = asset().id;
  const deleted = await transfer.delete(id);
  assert.equal(deleted.ok, true);
  assert.deepEqual(Object.keys(packets[0].data).sort(), ['op', 'transfer_id', 'boot', 'id'].sort());
  assert.equal(packets[0].data.op, 'delete');
  const status = await transfer.status(id);
  assert.equal(status.op, 'status');
  mqtt.robotState = 'running';
  await assert.rejects(transfer.delete(id), /idle/);
  assert.equal(packets.length, 2);
});

test('wrong and retained ACKs cannot advance; duplicate chunk retries use identical payload', async () => {
  const clip = asset(600); let chunkAttempts = 0;
  const { transfer, packets } = await fixture({ onPacket(data, target) {
    if (data.op === 'abort') return;
    const ack = { transfer_id: data.transfer_id, boot: data.boot, op: data.op, id: clip.id,
      ok: true, offset: data.op === 'chunk' ? data.offset + data.data.length / 2 : data.op === 'finish' ? clip.size : 0 };
    if (data.op === 'chunk' && data.offset === 0 && ++chunkAttempts === 1) {
      for (const bad of [{ ...ack, boot: 'old' }, { ...ack, transfer_id: 'old' }, { ...ack, id: 'b'.repeat(64) },
        { ...ack, offset: 1 }, { ...ack, op: 'finish' }]) target.handleAck(bad);
      target.handleAck(ack, { retain: true });
      return;
    }
    queueMicrotask(() => target.handleAck(ack));
  } });
  await transfer.run([clip.id], async () => clip);
  const firstChunks = packets.filter(p => p.data.op === 'chunk' && p.data.offset === 0);
  assert.equal(firstChunks.length, 2);
  assert.equal(firstChunks[0].payload, firstChunks[1].payload);
});

test('injected timing options cannot remove transfer bounds', async () => {
  for (const options of [{ retries: Infinity }, { retries: -1 }, { retries: 4 }, { ackTimeoutMs: 0 },
    { ackTimeoutMs: 5001 }, { sessionTimeoutMs: Infinity }, { sessionTimeoutMs: 300001 }]) {
    await assert.rejects(fixture(options), /bounds|timeout|retries/i);
  }
});

test('finish verification has a longer bounded ACK budget than chunk writes', async () => {
  const { RecordingTransfer } = await import('../server/src/services/recording-transfer.js');
  const transfer = new RecordingTransfer(new MqttService());
  assert.equal(transfer.verificationTimeoutMs, 15000);
  assert.equal(transfer.sessionTimeoutMs, 300000);
  assert.throws(() => new RecordingTransfer(new MqttService(), { verificationTimeoutMs: 15001 }), /bounds/);
});

test('finish retries keep firmware inactivity alive throughout its 15-second verification budget', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clip = asset(1);
  const { transfer, packets } = await fixture({ verificationTimeoutMs: 15000, retries: 2, sessionTimeoutMs: 300000,
    onPacket(data, target) {
      if (data.op === 'finish' || data.op === 'abort') return;
      queueMicrotask(() => target.handleAck({ transfer_id: data.transfer_id, boot: data.boot, id: clip.id, op: data.op, ok: true,
        offset: data.op === 'chunk' ? 1 : 0 }));
    },
  });
  const result = transfer.run([clip.id], async () => clip);
  for (let i = 0; i < 20 && transfer.pending?.op !== 'finish'; i++) await Promise.resolve();
  assert.equal(transfer.pending.op, 'finish');
  t.mock.timers.tick(5000);
  assert.equal(packets.filter(p => p.data.op === 'finish').length, 2);
  t.mock.timers.tick(5000);
  assert.equal(packets.filter(p => p.data.op === 'finish').length, 3);
  t.mock.timers.tick(1000);
  const finish = packets.at(-1).data;
  transfer.handleAck({ ...finish, id: clip.id, offset: 1, ok: true });
  await result;
});

test('lost begin and finish ACK retries preserve exact metadata and complete only once', async () => {
  const clip = asset(), seen = new Map(); let committed = 0;
  const { transfer, packets } = await fixture({ onPacket(data, target) {
    if (data.op === 'abort') return;
    const key = data.op + (data.offset ?? '');
    seen.set(key, (seen.get(key) || 0) + 1);
    if (['begin', 'finish'].includes(data.op) && seen.get(key) === 1) return;
    queueMicrotask(() => target.handleAck({ transfer_id: data.transfer_id, boot: data.boot, id: clip.id, op: data.op, ok: true,
      offset: data.op === 'chunk' ? data.offset + data.data.length / 2 : data.op === 'finish' ? clip.size : 0 }));
  } });
  await transfer.run([clip.id], async () => clip, () => { committed++; });
  assert.equal(committed, 1);
  for (const op of ['begin', 'finish']) {
    const matching = packets.filter(p => p.data.op === op);
    assert.equal(matching.length, 2);
    assert.equal(matching[0].payload, matching[1].payload);
  }
});

test('resolved old ACK continuation cannot overwrite the pending request of a newer owner', async () => {
  const { transfer, packets } = await fixture({ ackTimeoutMs: 1000, onPacket() {} });
  const clip = asset(), controller = new AbortController();
  const old = transfer.run([clip.id], async () => clip, undefined, { signal: controller.signal });
  const rejected = assert.rejects(old, /cancel/i);
  await pause(1);
  const begin = packets[0].data;
  transfer.handleAck({ ...begin, ok: true, offset: 0 }); // Resolve, but don't run its continuation yet.
  controller.abort();
  const fresh = transfer.status(clip.id);
  const status = packets.at(-1).data, owner = transfer.active;
  const finished = fresh.then(() => null, error => error);
  await rejected;
  try {
    assert.equal(transfer.active, owner);
    assert.equal(transfer.pending?.op, 'status', 'old continuation must never replace another owner pending ACK');
  } finally {
    transfer.handleAck({ ...status, ok: true, offset: clip.size });
    await pause(1);
    if (transfer.active === owner) transfer.invalidate('test cleanup');
  }
  assert.equal(await finished, null);
});

test('request-scoped cancellation during transfer loading preserves other verified assets', async () => {
  const { transfer, packets } = await fixture();
  const first = asset(1), second = asset(2);
  await transfer.run([first.id], async () => first);
  const controller = new AbortController(); let release;
  const result = transfer.run([second.id], () => new Promise(resolve => { release = resolve; }),
    () => assert.fail('canceled commit'), { signal: controller.signal });
  const rejected = assert.rejects(result, /cancel/i);
  controller.abort();
  assert.equal(transfer.active, null);
  await rejected;
  assert.equal(transfer.getVerification(first.id)?.verified, true, 'request cancellation must not erase another completed owner');
  assert.equal(transfer.getVerification(second.id), null);
  const count = packets.length;
  release(second); await pause(5);
  assert.equal(packets.length, count);
  await transfer.run([second.id], async () => second);
  assert.equal(transfer.getVerification(second.id).verified, true);
  transfer.invalidate('Stop');
  assert.equal(transfer.getVerification(first.id), null);
  assert.equal(transfer.getVerification(second.id), null);
});

test('eight clips including exact 24KiB boundary synchronize before commit with separate transfer identities', async () => {
  const { transfer, packets } = await fixture();
  const clips = Array.from({ length: 8 }, (_, i) => asset(i === 0 ? 24576 : i));
  await transfer.run(clips.map(clip => clip.id), async id => clips.find(clip => clip.id === id), () => {
    assert.equal(packets.filter(p => p.data.op === 'finish').length, 8);
  });
  assert.equal(new Set(packets.filter(p => p.data.op === 'begin').map(p => p.data.transfer_id)).size, 8);
  assert.equal(packets.filter(p => p.data.op === 'chunk' && p.data.data.length === 1024).length, 48);
  for (const clip of clips) assert.equal(transfer.getVerification(clip.id).verified, true);
});
