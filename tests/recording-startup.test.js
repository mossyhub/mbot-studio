// Real index.js, real HTTP routers/RecordingService/RecordingTransfer, fake MQTT transport.
// No production broker, device, AI, or source-rewritten server is involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { execFileSync, spawnSync } from 'node:child_process';
import { RecordingService } from '../server/src/services/recording-service.js';

function wav() {
  const data = execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2', '-f', 'wav', 'pipe:1']);
  data.writeUInt32LE(data.length - 8, 4);
  const chunk = data.indexOf('data'); data.writeUInt32LE(data.length - chunk - 8, chunk + 4);
  return data;
}

test('actual startup fails closed without listening when recording storage cannot initialize', async t => {
  const dataDir = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'recording-startup-fail-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dataDir, 'recordings'), 'not a directory');
  const script = `
    import http from 'node:http';
    import { MqttService } from ${JSON.stringify(new URL('../server/src/services/mqtt-service.js', import.meta.url).href)};
    MqttService.instance = new MqttService({ mqttConnect() { throw new Error('isolated transport disabled'); } });
    http.Server.prototype.listen = () => { process.stderr.write('UNEXPECTED_LISTEN'); process.exit(42); };
    await import(${JSON.stringify(new URL('../server/src/index.js', import.meta.url).href)});
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, DATA_DIR: dataDir, PORT: '0', HOST: '127.0.0.1', AI_LOCAL_DEBUG: 'true', MQTT_BROKER_URL: 'mqtt://isolated.invalid:1' },
    encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Failed to start server/);
  assert.doesNotMatch(result.stderr, /UNEXPECTED_LISTEN/);
  assert.doesNotMatch(result.stdout, /Server running/);
});

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'recording-startup-'));
  const audio = wav();
  const saved = await new RecordingService({ dataDir }).create({ audio, contentType: 'audio/wav', name: 'Restored clip' });
  const env = { ...process.env };
  Object.assign(process.env, { DATA_DIR: dataDir, PORT: '0', HOST: '127.0.0.1', AI_LOCAL_DEBUG: 'true', MQTT_BROKER_URL: 'mqtt://isolated.invalid:1' });
  const { MqttService } = await import('../server/src/services/mqtt-service.js');
  const { RobotDiagnostics } = await import('../server/src/services/robot-diagnostics.js');
  const client = new EventEmitter(), packets = [];
  client.connected = true; client.subscribe = () => {};
  let mode = 'success', currentId, currentSize;
  const incoming = (topic, data) => client.emit('message', `mbot-studio/${topic}`, Buffer.from(JSON.stringify(data)), {});
  client.publish = (topic, raw, options, callback) => {
    const data = JSON.parse(raw); packets.push({ topic, data, options }); callback?.();
    if (!topic.endsWith('/asset') || data.op === 'abort') return;
    if (data.op === 'begin') { currentId = data.id; currentSize = data.size; }
    if (data.op === 'delete' && mode === 'timeout') return;
    const ack = { transfer_id: data.transfer_id, boot: data.boot, id: data.id || currentId, op: data.op, ok: true,
      offset: data.op === 'chunk' ? data.offset + data.data.length / 2 : data.op === 'finish' ? currentSize : 0 };
    if (data.op === 'delete' && mode === 'missing') Object.assign(ack, { ok: false, error: 'missing' });
    if (data.op === 'delete' && mode === 'reject') Object.assign(ack, { ok: false, error: 'busy' });
    queueMicrotask(() => incoming('robot/asset_status', ack));
  };
  const mqtt = new MqttService({ diagnostics: new RobotDiagnostics({ dataDir }), recordingTransferOptions: { ackTimeoutMs: 25, retries: 0 },
    mqttConnect: () => { queueMicrotask(() => client.emit('connect')); return client; } });
  const previousInstance = MqttService.instance; MqttService.instance = mqtt;
  const initialize = RecordingService.prototype.initialize;
  let release, initialized = false;
  const gate = new Promise(resolve => { release = resolve; }), services = new Set();
  RecordingService.prototype.initialize = async function () {
    services.add(this); await gate;
    await initialize.call(this); initialized = true;
  };
  const createServer = http.createServer;
  let server, listeningReady;
  http.createServer = (...args) => {
    server = createServer(...args);
    server.once('listening', () => { listeningReady = initialized && mqtt.recordingRegistry?.get(saved.id)?.id === saved.id; });
    return server;
  };
  t.after(async () => {
    release(); RecordingService.prototype.initialize = initialize; http.createServer = createServer;
    mqtt.recordingTransfer.invalidate('test cleanup'); clearInterval(mqtt.diagnosticTimer);
    if (server && !server.listening) await once(server, 'listening');
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    MqttService.instance = previousInstance;
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  // Import the actual startup module; its transport factory was replaced above, not its routers.
  await import('../server/src/index.js');
  http.createServer = createServer;
  return { mqtt, client, packets, saved, audio, services, server, release, initialized: () => initialized,
    listeningReady: () => listeningReady, mode: value => { mode = value; }, incoming,
    online(boot = 'boot-a', capabilities = ['recorded_audio_v1', 'play_recording', 'wait']) {
      mqtt.connected = true; client.connected = true;
      incoming('robot/status', { status: 'ready', application: 'cooperative-v1', build: 'mbot-av-control-v1', boot, device: 'robot1', capabilities, armed: true, motion_enabled: true });
    },
  };
}

test('real server waits for its one recording registry before listening and mounts the actual recording API', async t => {
  const f = await fixture(t);
  assert.equal(f.services.size, 1, 'startup must instantiate and initialize a recording service');
  assert.equal(f.server.listening, false, 'HTTP must not listen while recording initialization is pending');
  assert.equal(f.mqtt.recordingRegistry, null);
  f.release(); await once(f.server, 'listening');
  assert.equal(f.listeningReady(), true, 'persisted clips must resolve through MQTT before HTTP admission');
  const [service] = f.services;
  assert.equal(f.mqtt.recordingRegistry, service);
  assert.equal(service.syncAdapter, f.mqtt.recordingTransfer);
  const base = `http://127.0.0.1:${f.server.address().port}/api/robot/recordings`;

  await t.test('stored clips and uploads remain local-only until explicit sync; raw parser precedes JSON', async () => {
    assert.deepEqual(await (await fetch(base)).json(), { recordings: [f.saved] });
    let response = await fetch(`${base}?name=Duplicate`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: f.audio });
    assert.equal(response.status, 201); assert.deepEqual(await response.json(), f.saved);
    assert.equal(f.packets.length, 0, 'storage must not publish');
    response = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{invalid JSON' });
    assert.equal(response.status, 415);
    assert.equal((await response.json()).code, 'recording_type_unsupported');
    response = await fetch(`${base}/${f.saved.id}/audio`);
    assert.match(response.headers.get('content-type'), /^audio\/mpeg/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await service.read(f.saved.id));
    response = await fetch(`${base}/${f.saved.id}/sync`, { method: 'POST' });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'recording_device_unavailable');
  });

  await t.test('actual transfer sync earns boot-fenced readiness; status and Program routes share the registry', async () => {
    f.online();
    let response = await fetch(`${base}/${f.saved.id}/sync`, { method: 'POST' });
    assert.equal(response.status, 200); assert.equal((await response.json()).ready, true);
    assert.equal((await (await fetch(base)).json()).recordings[0].ready, true);
    assert.equal(f.packets.at(-1).data.op, 'finish');
    const robotBase = base.replace(/\/recordings$/, '');
    response = await fetch(`${robotBase}/status`);
    assert.equal(response.status, 200);
    const count = f.packets.length;
    response = await fetch(`${robotBase}/program/validate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ program: [{ type: 'play_recording', recording: f.saved.id }] }) });
    assert.equal(response.status, 200);
    const preflight = await response.json();
    assert.equal(preflight.runnable, true, JSON.stringify(preflight));
    assert.equal(preflight.requestedHoldSeconds, f.saved.durationMs / 1000);
    assert.equal(f.packets.length, count, 'preflight must not transfer or publish');
    f.online('boot-b');
    assert.equal((await (await fetch(base)).json()).recordings[0].ready, false);
    response = await fetch(`${base}/${f.saved.id}/sync`, { method: 'POST' });
    assert.equal(response.status, 200); assert.equal((await response.json()).ready, true);
    f.online('boot-b', ['wait']);
    assert.equal((await (await fetch(base)).json()).recordings[0].ready, false);
    f.online('boot-b');
    assert.equal((await (await fetch(base)).json()).recordings[0].ready, false, 'withdrawn receipt cannot resurrect');
  });

  await t.test('failed device deletes retain local preview and registry; removal requires confirmed device absence', async () => {
    const target = `${base}/${f.saved.id}`;
    for (const mode of ['offline', 'timeout', 'reject']) {
      f.online('boot-b'); f.mode(mode);
      if (mode === 'offline') { f.client.connected = false; f.client.emit('offline'); }
      const response = await fetch(target, { method: 'DELETE' });
      assert.equal(response.status, 409, `device ${mode} must reject deletion`);
      assert.equal((await response.json()).code, 'recording_delete_failed');
      assert.ok(service.get(f.saved.id));
      assert.equal((await fetch(`${target}/audio`)).status, 200);
      assert.equal((await (await fetch(base)).json()).recordings.length, 1);
    }
    f.online('boot-b'); f.mode('missing');
    let response = await fetch(target, { method: 'DELETE' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { id: f.saved.id, deleted: true, deviceDeleted: true });
    assert.equal(service.get(f.saved.id), null);
    assert.equal(f.mqtt.recordingTransfer.getVerification(f.saved.id), null);
    assert.equal((await fetch(`${target}/audio`)).status, 404);
    assert.deepEqual(await (await fetch(base)).json(), { recordings: [] });
    // Successful positive deletion ACK has the same verified meaning as absence.
    response = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: f.audio });
    assert.equal(response.status, 201);
    f.mode('success');
    response = await fetch(target, { method: 'DELETE' });
    assert.deepEqual(await response.json(), { id: f.saved.id, deleted: true, deviceDeleted: true });
    assert.deepEqual(await (await fetch(base)).json(), { recordings: [] });
    assert.equal(f.services.size, 1, 'all HTTP operations use the startup singleton');
  });
});
