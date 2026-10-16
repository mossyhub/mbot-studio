// Actual loopback WebSocket/HTTP; MQTT boundary is in-memory, never a broker/device.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once, EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { MqttService } from '../server/src/services/mqtt-service.js';
import { setupWebSocket } from '../server/src/services/websocket.js';
const require = createRequire(new URL('../server/package.json', import.meta.url));
const { WebSocketServer, WebSocket } = require('ws');
const express = require('express');
const { robotRoutes } = await import('../server/src/routes/robot.js');
const originalLog = console.log;
before(() => { console.log = (...args) => console.error(...args); });
after(() => { console.log = originalLog; });

async function fixture(t) {
  const packets = [];
  const client = new EventEmitter();
  client.connected = true;
  client.publish = (topic, body, options, cb) => {
    packets.push({ topic: topic.replace('mbot-studio/', ''), data: JSON.parse(body), options });
    cb?.();
  };

  const subscriptions = [];
  client.subscribe = topic => subscriptions.push(topic);
  let connectOptions;
  let now = 1000;
  const service = new MqttService({ mqttConnect: (url, options) => { connectOptions = options; return client; }, driveClock: () => now });
  MqttService.instance = service;
  service.client = client;
  service.connected = true;
  service.robotLastSeen = service.robotStatusLastSeen = Date.now();
  service.robotState = 'ready';
  service.robotStatusMetadata = { application: 'cooperative-v1', build: 'mbot-av-control-v1',
    capabilities: ['drive_hold', 'wait', 'stop', 'read_sensors'], boot: 'boot-a', armed: true, motion_enabled: true };
  const app = express();
  app.use(express.json());
  app.use('/api/robot', robotRoutes);
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });
  setupWebSocket(wss);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const sockets = [];
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
    clearInterval(service.diagnosticTimer);
    service.driveHold?.invalidate('test cleanup');
    MqttService.instance = null;
  });
  async function socket() {
    const ws = new WebSocket(base.replace('http', 'ws'));
    const inbox = [];
    ws.on('message', bytes => inbox.push(JSON.parse(bytes)));
    await once(ws, 'open');
    sockets.push(ws);
    return { ws, inbox, async send(message) {
      const from = inbox.length;
      ws.send(JSON.stringify(message));
      await waitFor(() => inbox.slice(from).some(m => ['drive_ack', 'drive_error', 'error', 'ack', 'pong'].includes(m.type)));
      return inbox.slice(from).find(m => ['drive_ack', 'drive_error', 'error', 'ack', 'pong'].includes(m.type));
    } };
  }
  async function connect() {
    // Keep the real message/event handlers, but no disk persistence or broker.
    const diagnostics = service.diagnostics;
    service.diagnostics = { persist: true, record: (...args) => diagnostics.record(...args),
      get lastKnown() { return diagnostics.lastKnown; } };
    const pending = service.connect();
    client.emit('connect');
    await pending;
    return connectOptions;
  }
  const incoming = (topic, data) => client.emit('message', `mbot-studio/${topic}`, Buffer.from(JSON.stringify(data)));
  return { service, client, packets, socket, base, connect, incoming, subscriptions, advance: ms => { now += ms; } };
}
async function waitFor(predicate) {
  const until = Date.now() + 1500;
  while (!predicate()) {
    if (Date.now() > until) assert.fail('Timed out waiting for isolated server response');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
const start = (hold_id = randomUUID(), extra = {}) => ({ type: 'drive_start', hold_id, direction: 'forward', speed: 30, ...extra });

test('async transport failure revokes only its own generation, not a subsequent fresh hold', async t => {
  const f = await fixture(t), a = await f.socket();
  const callbacks = [], publish = f.client.publish;
  f.client.publish = (topic, body, options, cb) => { publish(topic, body, options); callbacks.push(cb); };
  const msg = start();
  await a.send(msg);
  callbacks[0](new Error('async publish failed'));
  assert.equal(f.service.driveHold.active, null);
  assert.equal((await a.send({ type: 'drive_renew', hold_id: msg.hold_id })).type, 'drive_error');
  const fresh = start();
  await a.send(fresh);
  callbacks[0](new Error('late stale error'));
  assert.equal((await a.send({ type: 'drive_renew', hold_id: fresh.hold_id })).type, 'drive_ack');
});

test('a consumed hold ID cannot restart after emergency; a new UUID can', async t => {
  const f = await fixture(t), a = await f.socket(), msg = start();
  await a.send(msg);
  f.service.emergencyStop();
  assert.equal((await a.send(msg)).type, 'drive_error');
  assert.equal((await a.send(start())).type, 'drive_ack');
  const before = f.packets.length;
  assert.equal((await a.send({ type: 'drive_renew', hold_id: msg.hold_id })).type, 'drive_error');
  assert.equal(f.packets.length, before);
});

test('renew checks current status and stale grants cannot extend motion', async t => {
  const f = await fixture(t), a = await f.socket();
  for (const change of [() => { f.service.robotStatusLastSeen = Date.now() - 16000; },
    () => { f.service.robotStatusMetadata.boot = 'new-boot'; }]) {
    const msg = start();
    await a.send(msg);
    change();
    assert.equal((await a.send({ type: 'drive_renew', hold_id: msg.hold_id })).type, 'drive_error');
    assert.equal(f.packets.at(-1).data.op, 'stop');
    f.service.robotStatusLastSeen = Date.now();
    f.service.robotStatusMetadata.boot = 'boot-a';
  }
});

test('matching terminal device drive_status revokes owner; unrelated status cannot cancel a fresh hold', async t => {
  const f = await fixture(t), a = await f.socket();
  await f.connect();
  for (const event of ['rejected', 'stopped']) {
    const msg = start();
    await a.send(msg);
    f.incoming('robot/drive_status', { hold_id: randomUUID(), boot: 'boot-a', event });
    f.incoming('robot/drive_status', { hold_id: msg.hold_id, boot: 'old-boot', event });
    assert.equal((await a.send({ type: 'drive_renew', hold_id: msg.hold_id })).type, 'drive_ack');
    f.incoming('robot/drive_status', { hold_id: msg.hold_id, boot: 'boot-a', event });
    assert.equal((await a.send({ type: 'drive_renew', hold_id: msg.hold_id })).type, 'drive_error');
  }
});

test('publish throw invalidates owner and a failed stop cannot leave a renewable hold', async t => {
  const f = await fixture(t), a = await f.socket();
  const publish = f.client.publish;
  for (const op of ['start', 'renew', 'stop']) {
    const msg = start();
    if (op !== 'start') await a.send(msg);
    f.client.publish = () => { throw new Error('transport failed'); };
    assert.equal((await a.send(op === 'start' ? msg : { type: `drive_${op}`, hold_id: msg.hold_id })).type, 'drive_error');
    f.client.publish = publish;
    assert.equal((await a.send({ type: 'drive_renew', hold_id: msg.hold_id })).type, 'drive_error');
  }
  assert.equal((await a.send(start())).type, 'drive_ack');
});

test('MQTT offline/close/errors invalidate without queuing and reconnect does not resume', async t => {
  const f = await fixture(t), a = await f.socket();
  const options = await f.connect();
  assert.equal(options.queueQoSZero, false);
  for (const event of ['offline', 'close', 'error']) {
    const msg = start();
    await a.send(msg);
    f.client.connected = false;
    f.client.emit(event, new Error('isolated MQTT failure'));
    const count = f.packets.length;
    assert.equal(f.service.driveHold.active, null);
    f.client.connected = true;
    f.client.emit('connect');
    assert.equal((await a.send({ type: 'drive_renew', hold_id: msg.hold_id })).type, 'drive_error');
    assert.equal(f.packets.length, count);
    f.incoming('robot/status', { ...f.service.robotStatusMetadata, status: 'ready' });
  }
});

test('MQTT boot/status invalidation stops the old hold and drive_status is bridged', async t => {
  const f = await fixture(t), a = await f.socket();
  await f.connect();
  assert.ok(f.subscriptions.includes('mbot-studio/robot/drive_status'));
  const metadata = { ...f.service.robotStatusMetadata };
  for (const change of [{ boot: 'boot-b' }, { armed: false }, { motion_enabled: false },
    { capabilities: ['wait'] }, { status: 'offline' }]) {
    f.incoming('robot/status', { ...metadata, status: 'ready' });
    const msg = start();
    await a.send(msg);
    f.incoming('robot/status', change);
    assert.equal(f.packets.at(-1).data.op, 'stop');
    assert.equal(f.packets.at(-1).data.boot, 'boot-a');
    assert.equal((await a.send({ type: 'drive_renew', hold_id: msg.hold_id })).type, 'drive_error');
  }
  const data = { hold_id: randomUUID(), boot: 'boot-a', state: 'stopped' };
  f.incoming('robot/drive_status', data);
  await waitFor(() => a.inbox.some(m => m.type === 'mqtt' && m.topic === 'robot/drive_status'));
  assert.deepEqual(a.inbox.find(m => m.type === 'mqtt' && m.topic === 'robot/drive_status').data, data);
});

test('competing commands/programs stop and invalidate a hold but are rejected, never queued', async t => {
  const f = await fixture(t), a = await f.socket();
  for (const submit of [() => f.service.sendCommand({ type: 'wait', duration: 0 }),
    () => f.service.sendProgram([{ type: 'wait', duration: 0 }])]) {
    const msg = start();
    await a.send(msg);
    assert.throws(submit, /drive/i);
    assert.equal(f.packets.at(-1).data.op, 'stop');
    assert.equal((await a.send({ type: 'drive_renew', hold_id: msg.hold_id })).type, 'drive_error');
  }
  assert.ok(f.packets.every(p => p.topic === 'robot/drive'));
  assert.equal(f.service.sendCommand({ type: 'wait', duration: 0 }), true);
});

test('socket close/error or malformed owner input releases hold without reconnect resume', async t => {
  const f = await fixture(t);
  for (const event of ['close', 'error', 'malformed']) {
    const a = await f.socket(), msg = start();
    await a.send(msg);
    if (event === 'close') a.ws.close();
    else if (event === 'malformed') a.ws.send('{');
    else f.service.driveHold.active.owner.emit('error', new Error('isolated socket error'));
    await waitFor(() => f.packets.at(-1).data.op === 'stop');
    const b = await f.socket();
    assert.equal((await b.send({ type: 'drive_renew', hold_id: msg.hold_id })).type, 'drive_error');
  }
});

test('API and any socket emergency stop invalidate ownership before delayed renewals', async t => {
  const f = await fixture(t), a = await f.socket(), b = await f.socket();
  for (const path of ['http', 'socket', 'offline']) {
    const msg = start();
    await a.send(msg);
    if (path === 'socket') {
      b.ws.send(JSON.stringify({ type: 'emergency_stop' }));
      await b.send({ type: 'ping' });
    } else {
      if (path === 'offline') { f.service.connected = false; f.client.connected = false; }
      const response = await fetch(`${f.base}/api/robot/stop`, { method: 'POST' });
      assert.equal(response.status, 200);
    }
    const count = f.packets.length;
    f.service.connected = f.client.connected = true;
    assert.equal((await a.send({ type: 'drive_renew', hold_id: msg.hold_id })).type, 'drive_error');
    assert.equal(f.packets.length, count, 'delayed renewal is not published');
    if (path !== 'offline') {
      assert.equal(f.packets.at(-2).data.op, 'stop');
      assert.equal(f.packets.at(-1).topic, 'robot/emergency');
    }
  }
  assert.equal((await a.send(start())).type, 'drive_ack');
});

test('500ms monotonic owner lease stops on silence and expired renewal never revives', async t => {
  const f = await fixture(t), a = await f.socket(), msg = start();
  await a.send(msg);
  f.advance(499);
  assert.equal((await a.send({ type: 'drive_renew', hold_id: msg.hold_id })).type, 'drive_ack');
  f.advance(500);
  assert.equal((await a.send({ type: 'drive_renew', hold_id: msg.hold_id })).type, 'drive_error');
  assert.deepEqual(f.packets.map(p => p.data.op), ['start', 'renew', 'stop']);
  const fresh = start();
  await a.send(fresh);
  f.advance(500);
  await waitFor(() => f.packets.at(-1).data.op === 'stop');
  assert.equal((await a.send({ type: 'drive_renew', hold_id: fresh.hold_id })).type, 'drive_error');
  assert.equal((await a.send(start())).type, 'drive_ack');
});

test('one socket owns the hold; strangers and wrong IDs cannot renew, stop or take over', async t => {
  const f = await fixture(t), a = await f.socket(), b = await f.socket(), msg = start();
  await a.send(msg);
  for (const owner of [a, b]) {
    assert.equal((await owner.send(start())).type, 'drive_error');
  }
  for (const type of ['drive_renew', 'drive_stop']) {
    assert.equal((await b.send({ type, hold_id: msg.hold_id })).type, 'drive_error');
    assert.equal((await a.send({ type, hold_id: randomUUID() })).type, 'drive_error');
    assert.equal((await a.send({ type, hold_id: msg.hold_id, speed: 50 })).type, 'drive_error');
  }
  assert.equal(f.packets.length, 1);
  assert.equal((await a.send({ type: 'drive_renew', hold_id: msg.hold_id })).type, 'drive_ack');
  await a.send({ type: 'drive_stop', hold_id: msg.hold_id });
  assert.equal((await a.send({ type: 'drive_renew', hold_id: msg.hold_id })).type, 'drive_error');
  assert.equal((await b.send(start())).type, 'drive_ack');
});

test('start requires exact bounded fields and fresh armed AV capability status', async t => {
  const f = await fixture(t), a = await f.socket();
  for (const extra of [{ hold_id: 'not-a-uuid' }, { direction: 'up' }, { speed: -1 }, { speed: 51 },
    { speed: '30' }, { speed: null }, { direction: null }, { lease_ms: 900 }]) {
    assert.equal((await a.send(start(undefined, extra))).type, 'drive_error', JSON.stringify(extra));
  }
  const original = { ...f.service.robotStatusMetadata };
  for (const override of [{ application: 'legacy' }, { build: 'mbot-motor-control-v1' },
    { capabilities: [] }, { boot: '' }, { boot: null }, { armed: false }, { motion_enabled: false }]) {
    f.service.robotStatusMetadata = { ...original, ...override };
    assert.equal((await a.send(start())).type, 'drive_error', JSON.stringify(override));
  }
  f.service.robotStatusMetadata = original;
  f.service.robotStatusLastSeen = Date.now() - 16000;
  assert.equal((await a.send(start())).type, 'drive_error');
  f.service.robotStatusLastSeen = Date.now();
  for (const state of ['running', 'busy', 'unknown', 'offline']) {
    f.service.robotState = state;
    assert.equal((await a.send(start())).type, 'drive_error', state);
  }
  f.service.robotState = 'ready';
  f.service.connected = false;
  assert.equal((await a.send(start())).type, 'drive_error');
  f.service.connected = true;
  f.client.connected = false;
  assert.equal((await a.send(start())).type, 'drive_error');
  assert.equal(f.packets.length, 0);
  f.client.connected = true;
  for (const speed of [0, 50]) {
    const msg = start(undefined, { speed });
    assert.equal((await a.send(msg)).type, 'drive_ack');
    await a.send({ type: 'drive_stop', hold_id: msg.hold_id });
  }
});

test('WS hold start/renew/stop uses dedicated non-retained QoS0 MQTT and correlated acks', async t => {
  const f = await fixture(t), a = await f.socket(), msg = start();
  assert.deepEqual(await a.send(msg), { type: 'drive_ack', hold_id: msg.hold_id, op: 'start' });
  assert.deepEqual(await a.send({ type: 'drive_renew', hold_id: msg.hold_id }), { type: 'drive_ack', hold_id: msg.hold_id, op: 'renew' });
  assert.deepEqual(await a.send({ type: 'drive_stop', hold_id: msg.hold_id }), { type: 'drive_ack', hold_id: msg.hold_id, op: 'stop' });
  assert.deepEqual(f.packets, ['start', 'renew', 'stop'].map(op => ({ topic: 'robot/drive',
    data: { op, hold_id: msg.hold_id, boot: 'boot-a', ...(op === 'start' ? { direction: 'forward', speed: 30 } : {}) },
    options: { qos: 0, retain: false } })));
  assert.equal((await a.send(start())).type, 'drive_ack', 'a fresh press after release works');
});
