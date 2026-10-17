// Real router/service/transfer -> serialized packets -> actual Python firmware -> real ACK matcher.
// Adapted from the independent contract reproduction. No broker/hardware; bytes are not playable audio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { MqttService } from '../server/src/services/mqtt-service.js';
import { RecordingService } from '../server/src/services/recording-service.js';
import { createRecordingRoutes } from '../server/src/routes/recordings.js';
import { robotRoutes } from '../server/src/routes/robot.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate) {
  for (let i = 0; i < 400; i++) { if (predicate()) return; await pause(5); }
  assert.fail('isolated operation did not reach expected state');
}
async function fixture(t) {
  const child = spawn(process.env.PYTHON || 'python3', [fileURLToPath(new URL('./fixtures/recording-contract-bridge.py', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] });
  const replies = []; let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  child.on('error', err => { for (const waiter of replies.splice(0)) waiter.reject(err); });
  child.on('exit', code => { for (const waiter of replies.splice(0)) waiter.reject(new Error(`bridge exit ${code}: ${stderr}`)); });
  createInterface({ input: child.stdout }).on('line', line => {
    const value = JSON.parse(line), waiter = replies.shift();
    if (value.bridge_error) waiter.reject(new Error(value.bridge_error)); else waiter.resolve(value);
  });
  const wire = input => new Promise((resolve, reject) => { replies.push({ resolve, reject }); child.stdin.write(JSON.stringify(input) + '\n'); });
  const dataDir = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'sync-cancel-'));
  const mqtt = new MqttService({ recordingTransferOptions: { ackTimeoutMs: 5000 } });
  const transfer = mqtt.recordingTransfer, packets = [], acks = [];
  mqtt.connected = true; mqtt.robotLastSeen = mqtt.robotStatusLastSeen = Date.now(); mqtt.robotState = 'ready';
  mqtt.robotStatusMetadata = { application: 'cooperative-v1', build: 'mbot-av-control-v1', boot: 'boot', capabilities: ['recorded_audio_v1', 'play_recording'] };
  let chain = Promise.resolve(), heldOp = 'begin', heldAck;
  mqtt.client = { connected: true, publish(topic, payload, opts, callback) {
    const data = JSON.parse(payload); packets.push({ topic, data, payload }); callback?.();
    chain = chain.then(async () => {
      const result = await wire({ payload, topic: topic.split('/').at(-1) });
      for (const event of result.events) if (event.topic.endsWith('/asset_status')) {
        acks.push(event.data);
        if (event.data.op === heldOp) heldAck = event.data;
        else transfer.handleAck(event.data);
      }
    });
  } };
  const drain = async () => {
    for (let i = 0; i < 100; i++) {
      await new Promise(resolve => setImmediate(resolve));
      const previous = chain; await previous;
      if (chain === previous) return;
    }
    assert.fail('wire did not drain');
  };
  const service = new RecordingService({ dataDir, syncAdapter: transfer });
  const audio = Buffer.alloc(600, 37), id = createHash('sha256').update(audio).digest('hex');
  const dir = path.join(service.root, 'assets', id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'audio.mp3'), audio);
  await fs.writeFile(path.join(dir, 'metadata.json'), JSON.stringify({ id, name: 'fixture', durationMs: 3000, bytes: audio.length }));
  await service.initialize(); mqtt.setRecordingRegistry(service);
  await wire({ ticks: 1 });
  t.after(async () => {
    transfer.invalidate('test cleanup'); await drain();
    child.stdin.end(); await once(child, 'exit');
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const router = createRecordingRoutes({ service });
  const request = (properties = {}) => {
    const req = Object.assign(new EventEmitter(), { method: 'POST', url: `/${id}/sync`, headers: {}, ...properties });
    const res = Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false,
      set() {}, status(code) { this.statusCode = code; return this; },
      json(value) { this.body = value; this.writableEnded = true; this.emit('close'); return this; },
    });
    router.handle(req, res, err => { if (err) throw err; });
    return { req, res };
  };
  return { mqtt, transfer, service, id, audio, packets, acks, wire, drain, request,
    hold(op) { heldOp = op; heldAck = undefined; }, held: () => heldAck,
    release() { const ack = heldAck; heldOp = null; heldAck = undefined; if (ack) transfer.handleAck(ack); },
  };
}

test('real emergency Stop route returns a clear409 to pending Sync and keeps the local clip', async t => {
  const f=await fixture(t), previous=MqttService.instance;MqttService.instance=f.mqtt;
  const app=express();app.use('/api/robot/recordings',createRecordingRoutes({service:f.service}));app.use('/api/robot',robotRoutes);
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{MqttService.instance=previous;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const base=`http://127.0.0.1:${server.address().port}/api/robot`;
  const sync=fetch(`${base}/recordings/${f.id}/sync`,{method:'POST'});await waitFor(()=>f.held());
  assert.equal((await fetch(`${base}/stop`,{method:'POST'})).status,200);
  const response=await sync;assert.equal(response.status,409);const failure=await response.json();
  assert.equal(failure.code,'RECORDING_TRANSFER_REJECTED');assert.match(failure.error,/canceled/);assert.doesNotMatch(failure.error,/sync-cancel-|audio\.mp3|Traceback/);
  const progress=await (await fetch(`${base}/recordings/transfer-status`)).json();assert.equal(progress.active,false);assert.equal(progress.phase,'canceled');
  assert.equal((await f.service.getAsset(f.id)).metadata.ready,false);
  f.release();await f.drain();const recovered=await fetch(`${base}/recordings/${f.id}/sync`,{method:'POST'});assert.equal(recovered.status,200);assert.equal((await recovered.json()).ready,true);
});

test('loopback HTTP disconnect cancels sync; a fresh HTTP sync survives normal response close', async t => {
  const f = await fixture(t), app = express();
  app.use('/recordings', createRecordingRoutes({ service: f.service }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/recordings/${f.id}/sync`;
  const request = http.request(url, { method: 'POST' });
  request.on('error', () => {}); request.end();
  await waitFor(() => f.held());
  request.destroy();
  await waitFor(() => f.transfer.active === null);
  f.release(); await f.drain();
  assert.equal(f.transfer.getVerification(f.id), null);
  assert.equal(f.packets.some(p => p.data.op === 'chunk'), false);
  const response = await fetch(url, { method: 'POST' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ready, true);
  await f.drain();
  assert.equal(f.transfer.getVerification(f.id).verified, true);
  assert.equal(f.packets.filter(p => p.data.op === 'abort').length, 1);
});

for (const stage of ['chunk', 'finish', 'resolved finish']) {
  test(`response-close alone fences a ${stage} ACK without installing readiness`, async t => {
    const f = await fixture(t); f.hold(stage === 'chunk' ? 'chunk' : 'finish');
    const { req, res } = f.request();
    await waitFor(() => f.held());
    const ack = f.held();
    if (stage === 'resolved finish') f.transfer.handleAck(ack);
    res.destroyed = true; res.emit('close');
    assert.equal(f.transfer.active, null);
    const count = f.packets.length;
    f.release(); await f.drain();
    await waitFor(() => req.listenerCount('aborted') === 0);
    assert.equal(f.transfer.pending, null);
    assert.equal(f.transfer.getVerification(f.id), null);
    assert.equal(f.service.isReady(f.id), false);
    assert.equal(res.body, undefined);
    assert.equal(f.packets.length, count, 'late ACK must not publish another operation');
    // Firmware may have committed finish before the ACK was lost; this is not
    // rollback. The server must withhold readiness until a new intentional sync.
    const fresh = f.request();
    await waitFor(() => fresh.res.writableEnded);
    assert.equal(fresh.res.body.ready, true, JSON.stringify(fresh.res.body));
  });
}

test('canceling a request still loading cannot cancel an independent transfer owner', async t => {
  const f = await fixture(t), getAsset = f.service.getAsset.bind(f.service);
  const asset = await getAsset(f.id);
  const other = f.transfer.sync(asset, { bootId: 'boot' });
  await waitFor(() => f.held());
  const owner = f.transfer.active;
  let release;
  f.service.getAsset = () => new Promise(resolve => { release = () => resolve(asset); });
  const { req, res } = f.request();
  req.emit('aborted');
  await waitFor(() => res.listenerCount('close') === 0);
  assert.equal(f.transfer.active, owner);
  assert.equal(f.packets.some(p => p.data.op === 'abort'), false);
  release(); f.service.getAsset = getAsset;
  f.release(); await other;
  assert.equal(f.transfer.getVerification(f.id).verified, true);
});

test('an already aborted request never starts its asset read', async t => {
  const f = await fixture(t);
  f.service.getAsset = () => assert.fail('aborted request read asset');
  const { req, res } = f.request({ aborted: true });
  await waitFor(() => req.listenerCount('aborted') === 0);
  assert.equal(res.body, undefined);
  assert.equal(f.packets.length, 0);
  assert.equal(f.transfer.active, null);
});

test('sync returns verified metadata without reopening an asynchronous read after finish', async t => {
  const f = await fixture(t), getAsset = f.service.getAsset.bind(f.service);
  let reads = 0;
  f.service.getAsset = id => ++reads === 1 ? getAsset(id) : new Promise(() => {});
  f.hold(null);
  const { req, res } = f.request();
  await waitFor(() => res.writableEnded);
  assert.equal(reads, 1);
  assert.equal(res.body.ready, true);
  assert.equal(f.transfer.getVerification(f.id).verified, true);
  assert.equal(req.listenerCount('aborted'), 0);
  assert.equal(res.listenerCount('close'), 0);
  const count = f.packets.length;
  req.emit('aborted'); res.emit('close');
  await f.drain();
  assert.equal(f.packets.length, count);
  assert.equal(f.transfer.getVerification(f.id).verified, true);
});

test('request abort during asset loading releases mutation lock and late read cannot touch a newer sync', async t => {
  const f = await fixture(t), getAsset = f.service.getAsset.bind(f.service);
  const asset = await getAsset(f.id);
  let release;
  f.service.getAsset = () => new Promise(resolve => { release = () => resolve(asset); });
  const old = f.request();
  assert.equal(typeof release, 'function');
  old.req.emit('aborted'); // req.aborted alone, without a response-close event.
  await waitFor(() => old.req.listenerCount('aborted') === 0 && old.res.listenerCount('close') === 0);
  assert.equal(f.transfer.active, null);
  assert.equal(f.packets.length, 0);
  assert.equal(old.res.body, undefined);
  f.service.getAsset = getAsset;
  const fresh = f.request();
  await waitFor(() => f.held());
  const owner = f.transfer.active;
  release(); old.res.emit('close'); old.req.emit('aborted');
  await pause(10); await f.drain();
  assert.equal(f.transfer.active, owner);
  assert.equal(f.packets.filter(p => p.data.op === 'begin').length, 1);
  assert.equal(f.packets.some(p => p.data.op === 'abort'), false);
  f.release();
  await waitFor(() => fresh.res.writableEnded);
  assert.equal(fresh.res.body.ready, true, JSON.stringify(fresh.res.body));
  assert.equal(f.transfer.getVerification(f.id).verified, true);
});

test('actual sync router disconnect revokes its session before a delayed genuine firmware ACK', async t => {
  const f = await fixture(t), { req, res } = f.request();
  await waitFor(() => f.held());
  assert.equal(f.held().ok, true);
  const ack = f.held(), session = f.transfer.active;
  res.destroyed = true; res.emit('close'); req.emit('aborted');
  assert.equal(f.transfer.active, null, 'disconnected sync request must synchronously revoke ownership');
  f.release(); await f.drain();
  await waitFor(() => req.listenerCount('aborted') === 0);
  assert.equal(f.transfer.getVerification(f.id), null);
  assert.equal(f.packets.some(p => ['chunk', 'finish'].includes(p.data.op)), false);
  assert.equal(res.body, undefined, 'no successful/error response on an abandoned socket');
  const state = await f.wire({ ticks: 1 });
  assert.equal(state.assets[f.id], undefined);
  assert.equal(state.transfer, false);
  assert.equal(f.packets.filter(p => p.data.op === 'abort' && p.data.transfer_id === session.transfer_id).length, 1);
  // Recovery is intentional, not an old ACK resurrecting the canceled operation.
  const fresh = f.request();
  f.transfer.handleAck(ack); req.emit('aborted'); res.emit('close');
  await waitFor(() => fresh.res.writableEnded);
  assert.equal(fresh.res.body.ready, true, JSON.stringify(fresh.res.body));
  assert.equal(f.transfer.getVerification(f.id).verified, true);
  assert.equal((await f.wire({ ticks: 1 })).assets[f.id].size, f.audio.length);
});
