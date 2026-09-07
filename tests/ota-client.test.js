import test from 'node:test';
import assert from 'node:assert/strict';

import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { Aedes } from 'aedes';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const moduleUrl = new URL('../server/src/services/ota-client.js', import.meta.url);
const otherDigest = '01'.repeat(32);
const config = { brokerUrl: 'mqtt://127.0.0.1:1', prefix: 'isolated-test', device: 'diagnostic' };

test('OtaClient requires explicit validated LAN configuration', async () => {
  const { OtaClient } = await import(moduleUrl);
  for (const options of [{}, { ...config, device: '../robot' },
    { ...config, prefix: 'x/#' }, { ...config, brokerUrl: 'https://example.org' }]) {
    assert.throws(() => new OtaClient(options), /Invalid OTA/);
  }
  const client = new OtaClient(config);
  await client.close();
});

// Deliberately fake protocol peer. This exercises the host and real MQTT transport,
// NOT Python core/runtime compatibility (covered in ota-integration.test.js), or hardware.
function envelope(_channel, fields, body) {
  const envelope = { v: 1, device: config.device, boot: 'ab'.repeat(16), ...fields, body: typeof body === 'string' ? body : JSON.stringify(body) };
  return envelope;
}

async function fixture(t, behavior = {}) {
  const { OtaClient } = await import(moduleUrl);
  const broker = await Aedes.createBroker();
  const server = createServer(broker.handle);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const options = { ...config, brokerUrl: `mqtt://127.0.0.1:${server.address().port}`, timeoutMs: 350, bootTimeoutMs: 350, requestTimeoutMs: 60, retries: 2, pollIntervalMs: 10 };
  t.after(async () => {
    await new Promise(resolve => broker.close(resolve));
    await new Promise(resolve => server.close(resolve));
  });
  const client = new OtaClient(options);
  const topic = `${config.prefix}/ota/${config.device}`;
  const requests = [];
  const peer = {
    broker, client, options, requests, boot: 'ab'.repeat(16), seq: 1,
    state: { confirmed: null, candidate: null, trial: null, selected: null, healthy: false },
    publish(suffix, envelope, retain = false) {
      return new Promise((resolve, reject) => broker.publish({ topic: `${topic}/${suffix}`, payload: Buffer.from(JSON.stringify(envelope)), qos: 0, retain }, err => err ? reject(err) : resolve()));
    },
    hello(retain = false) {
      return peer.publish('hello', envelope('hello', { boot: peer.boot, seq: 0, op: 'hello' }, { protocol: 1, loader: '1', ...peer.state, next_seq: peer.seq }), retain);
    },
    reply(req, result = { ...peer.state, next_seq: peer.seq }, overrides = {}) {
      return peer.publish('response', envelope('response', { ...req, ...overrides }, { ok: true, result }));
    },
  };
  broker.on('subscribe', subscriptions => {
    if (subscriptions.some(sub => sub.topic === `${topic}/hello`) && !behavior.noHello) setImmediate(() => peer.hello().catch(() => {}));
  });
  broker.on('publish', (packet, sender) => {
    if (!sender || packet.topic !== `${topic}/request`) return;
    const raw = packet.payload.toString();
    const req = JSON.parse(raw);
    requests.push({ raw, req, retain: packet.retain, qos: packet.qos });
    assert.deepEqual(Object.keys(req).sort(), ['body', 'boot', 'device', 'op', 'seq', 'v']);
    assert.equal(typeof req.body, 'string');
    peer.seq = req.seq + 1;
    Promise.resolve(behavior.onRequest ? behavior.onRequest(req, peer) : peer.reply(req)).catch(error => { peer.error = error; });
  });
  t.after(async () => {
    await client.close();
    if (peer.error) throw peer.error;
  });
  return peer;
}

test('keyless connect proves hello readiness with a fresh status request', async t => {
  const peer = await fixture(t);
  const status = await peer.client.connect();
  assert.equal(status.healthy, false);
  assert.equal(peer.requests.length, 1);
  assert.deepEqual(JSON.parse(peer.requests[0].req.body), {});
  assert.equal(peer.requests[0].req.op, 'status');
  assert.equal(peer.requests[0].req.seq, 1);
  assert.equal(peer.requests[0].retain, false);
  assert.equal(peer.requests[0].qos, 0);
  await peer.client.request('status', {});
  assert.equal(peer.requests[1].req.seq, 2);
});

test('boot timeout defaults to 90 seconds independently of request timeouts', async () => {
  const { OtaClient } = await import(moduleUrl);
  const client = new OtaClient({ ...config, timeoutMs: 50, requestTimeoutMs: 10 });
  assert.equal(client.bootTimeoutMs, 90000);
  await client.close();
});

for (const command of ['activate', 'rollback']) {
  test(`${command} allows reboot beyond ordinary request budget`, async t => {
    const sha256 = 'cd'.repeat(32);
    const selected = { slot: 'a', size: 12, sha256 };
    const peer = await fixture(t, { async onRequest(req, p) {
      if (req.op !== command) return p.reply(req);
      await p.reply(req, { restart: true });
      await new Promise(resolve => setTimeout(resolve, 100));
      p.boot = 'ef'.repeat(16); p.seq = 1;
      p.state = { confirmed: command === 'rollback' ? selected : null,
        candidate: command === 'activate' ? selected : null,
        trial: command === 'activate' ? { ...selected, attempted: true } : null,
        selected, healthy: true };
      await p.hello();
    } });
    if (command === 'rollback') peer.state.confirmed = selected;
    await peer.client.connect();
    peer.client.timeoutMs = 60;
    peer.client.bootTimeoutMs = 350;
    const state = await peer.client[command](sha256);
    assert.deepEqual(state.selected, selected);
  });
}

test('upload hashes exact bytes and retries a dropped chunk ACK with identical envelope', async t => {
  const bytes = Buffer.alloc(2500, 0x5a);
  const digest = createHash('sha256').update(bytes).digest('hex');
  let dropped = false;
  const peer = await fixture(t, { onRequest(req, p) {
    if (req.op === 'chunk' && !dropped) { dropped = true; return; }
    if (req.op === 'finish') { p.state.candidate = { slot: 'a', size: bytes.length, sha256: digest }; return p.reply(req); }
    return p.reply(req);
  } });
  await peer.client.connect();
  const result = await peer.client.upload(bytes);
  assert.equal(result.sha256, digest);
  const chunks = peer.requests.filter(entry => entry.req.op === 'chunk');
  assert.equal(chunks.length, 4);
  assert.equal(chunks[0].raw, chunks[1].raw);
  assert.deepEqual(chunks.map(entry => JSON.parse(entry.req.body).offset), [0, 0, 1024, 2048]);
  assert.deepEqual(Buffer.concat(chunks.filter((_, i) => i !== 1).map(entry => Buffer.from(JSON.parse(entry.req.body).data, 'hex'))), bytes);
  const begin = JSON.parse(peer.requests.find(entry => entry.req.op === 'begin').req.body);
  assert.equal(begin.size, bytes.length);
  assert.equal(begin.sha256, digest);
  assert.match(begin.transfer, /^[0-9a-f]{32}$/);
  assert.equal(peer.requests.some(entry => entry.req.op === 'activate'), false);
});

test('activate requires a different boot and live healthy matching trial', async t => {
  const sha256 = 'cd'.repeat(32);
  const descriptor = { slot: 'a', size: 12, sha256 };
  const peer = await fixture(t, { async onRequest(req, p) {
    if (req.op === 'activate') {
      await p.reply(req, { restart: true });
      p.boot = 'ef'.repeat(16); p.seq = 1;
      p.state = { ...p.state, candidate: descriptor, selected: descriptor, trial: { ...descriptor, attempted: true }, healthy: true };
      await p.hello();
    } else return p.reply(req);
  } });
  await peer.client.connect();
  const state = await peer.client.activate(sha256);
  assert.equal(state.selected.sha256, sha256);
  const last = peer.requests.at(-1).req;
  assert.equal(last.op, 'status');
  assert.equal(last.boot, peer.boot);
  assert.equal(last.seq, 1);
  assert.equal(peer.requests.some(entry => entry.req.op === 'confirm'), false);
});

for (const fault of ['same-boot', 'retained-hello', 'unhealthy', 'wrong-digest', 'mismatched-slot', 'stale-status']) {
  test(`activation rejects ${fault} despite a restart ACK`, async t => {
    const sha256 = 'cd'.repeat(32);
    const descriptor = { slot: 'a', size: 12, sha256 };
    let rebooted = false;
    let previousStatus;
    const peer = await fixture(t, { async onRequest(req, p) {
      if (req.op === 'activate') {
        await p.reply(req, { restart: true });
        if (fault !== 'same-boot') { p.boot = 'ef'.repeat(16); p.seq = 1; }
        p.state = { ...p.state, candidate: descriptor, selected: descriptor, trial: { ...descriptor, attempted: true }, healthy: fault !== 'unhealthy' };
        if (fault === 'wrong-digest') p.state.selected = { ...descriptor, sha256: otherDigest };
        if (fault === 'mismatched-slot') p.state.selected = { ...descriptor, slot: 'b' };
        rebooted = true;
        if (fault === 'retained-hello') {
          // Retained delivery bit as seen on a replayed subscription (broker clears it for live delivery).
          p.client._message(`${config.prefix}/ota/${config.device}/hello`, Buffer.from(JSON.stringify(envelope('hello', { boot: p.boot, seq: 0, op: 'hello' }, { protocol: 1, loader: '1', ...p.state, next_seq: 1 }))), { retain: true });
        } else await p.hello();
      } else if (rebooted && fault === 'stale-status') {
        await p.publish('response', previousStatus);
      } else {
        previousStatus = envelope('response', req, { ok: true, result: { ...p.state, next_seq: p.seq } });
        await p.publish('response', previousStatus);
      }
    } });
    await peer.client.connect();
    await assert.rejects(peer.client.activate(sha256), /timeout|verification/);
  });
}

test('confirm reads back matching confirmed state instead of trusting ACK', async t => {
  const sha256 = 'cd'.repeat(32);
  let confirm = false;
  const peer = await fixture(t, { onRequest(req, p) {
    if (req.op === 'confirm') {
      confirm = true;
      p.state.confirmed = { slot: 'a', size: 12, sha256 };
      p.state.trial = null;
    }
    return p.reply(req);
  } });
  await peer.client.connect();
  const state = await peer.client.confirm(sha256);
  assert.equal(confirm, true);
  assert.equal(state.confirmed.sha256, sha256);
  assert.equal(peer.requests.at(-1).req.op, 'status');
  peer.state.confirmed.sha256 = '00'.repeat(32);
  // A lying ACK must not satisfy confirmation; preserve the mismatched readback.
  peer.broker.removeAllListeners('publish');
  peer.broker.on('publish', (packet, sender) => {
    if (!sender || !packet.topic.endsWith('/request')) return;
    const req = JSON.parse(packet.payload);
    peer.seq = req.seq + 1;
    peer.reply(req).catch(() => {});
  });
  await assert.rejects(peer.client.confirm(sha256), /verification/);
});

test('rollback proves a new boot selected the previously confirmed descriptor', async t => {
  const confirmed = { slot: 'b', size: 12, sha256: '12'.repeat(32) };
  const peer = await fixture(t, { async onRequest(req, p) {
    if (req.op === 'rollback') {
      await p.reply(req, { restart: true });
      p.boot = 'ff'.repeat(16); p.seq = 1;
      p.state = { ...p.state, confirmed, candidate: null, selected: confirmed, trial: null, healthy: true };
      await p.hello();
    } else return p.reply(req);
  } });
  peer.state.confirmed = confirmed;
  await peer.client.connect();
  const state = await peer.client.rollback();
  assert.deepEqual(state.selected, confirmed);
  assert.equal(state.trial, null);
  assert.equal(peer.requests.at(-1).req.op, 'status');
  assert.equal(peer.requests.at(-1).req.boot, peer.boot);
});

test('rollback rejects a mismatched selected slot even if the digest matches', async t => {
  const confirmed = { slot: 'b', size: 12, sha256: '12'.repeat(32) };
  const peer = await fixture(t, { async onRequest(req, p) {
    if (req.op === 'rollback') {
      await p.reply(req, { restart: true });
      p.boot = 'ff'.repeat(16); p.seq = 1;
      p.state = { ...p.state, confirmed, candidate: null, selected: { ...confirmed, slot: 'a' }, trial: null };
      await p.hello();
    } else return p.reply(req);
  } });
  peer.state.confirmed = confirmed;
  await peer.client.connect();
  await assert.rejects(peer.client.rollback(), /verification/);
});

test('request rejects noncontract operations and payloads locally without consuming a sequence', async t => {
  const peer = await fixture(t);
  await peer.client.connect();
  for (const [op, body] of [['status', { surprise: 1 }], ['repl', {}], ['chunk', { transfer: '00'.repeat(16), offset: 0, data: 'AB' }],
    ['begin', { transfer: '00'.repeat(16), size: 131073, sha256: otherDigest }], ['confirm', { sha256: 'bad' }], ['status', []]]) {
    await assert.rejects(peer.client.request(op, body), /Invalid OTA/);
  }
  assert.equal(peer.requests.length, 1);
  await peer.client.request('status', {});
  assert.equal(peer.requests.at(-1).req.seq, 2);
});

test('timeout and retry options must remain finite bounded positive integers', async () => {
  const { OtaClient } = await import(moduleUrl);
  for (const overrides of [{ bootTimeoutMs: 0 }, { bootTimeoutMs: 600001 }, { timeoutMs: Infinity }, { requestTimeoutMs: 0 }, { pollIntervalMs: -1 }, { retries: Infinity }, { retries: 100 }, { timeoutMs: 0.5 }]) {
    assert.throws(() => new OtaClient({ ...config, ...overrides }), /Invalid OTA/);
  }
});

test('response validation rejects wrong identity, boot, sequence, operation, types and oversize', async t => {
  let badMode = false;
  const peer = await fixture(t, { async onRequest(req, p) {
    if (!badMode) return p.reply(req);
    const body = { ok: true, result: { acceptedBad: true } };
    const good = envelope('response', req, body);
    for (const bad of [ envelope('response', { ...req, device: 'other' }, body),
      envelope('response', { ...req, boot: '11'.repeat(16) }, body), envelope('response', { ...req, seq: req.seq + 1 }, body),
      envelope('response', { ...req, op: 'activate' }, body),
      envelope('response', { ...req, seq: String(req.seq) }, body), envelope('response', req, { ...body, padding: 'x'.repeat(8192) }),
      { ...good, body }, { ...good, extra: true }, envelope('response', req, { ok: 'true', result: {} }) ]) {
      await p.publish('response', bad);
    }
    // Accept a Python-style spaced JSON-string body.
    await p.publish('response', envelope('response', req, '{ "ok": true, "result": { "live": true } }'));
  } });
  await peer.client.connect();
  badMode = true;
  assert.deepEqual(await peer.client.request('status', {}), { live: true });
});

test('missing hello and missing response both time out boundedly', async t => {
  const noHello = await fixture(t, { noHello: true });
  await assert.rejects(noHello.client.connect(), /hello timeout/);
  const noReply = await fixture(t, { onRequest() {} });
  await assert.rejects(noReply.client.connect(), /request timeout/);
  assert.equal(noReply.requests.length, 3);
  assert.equal(new Set(noReply.requests.map(entry => entry.raw)).size, 1);
  await assert.rejects(noReply.client.request('status', {}), /not ready/);
});

test('retained hello is not readiness', async t => {
  const peer = await fixture(t, { noHello: true });
  await peer.hello(true);
  await assert.rejects(peer.client.connect(), /hello timeout/);
  assert.equal(peer.requests.length, 0);
});

test('only one request may be outstanding and close rejects pending work', async t => {
  let drop = false;
  const peer = await fixture(t, { onRequest(req, p) { if (!drop) return p.reply(req); } });
  await peer.client.connect();
  drop = true;
  const pending = peer.client.request('status', {});
  const rejected = assert.rejects(pending, /closed/);
  await assert.rejects(peer.client.request('status', {}), /outstanding/);
  await peer.client.close();
  await rejected;
});

function cli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL('../tools/ota-update.mjs', import.meta.url).pathname, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI test timed out')); }, 5000);
    child.once('error', reject);
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

async function operatorConfig(t, options) {
  const dir = await mkdtemp(join(tmpdir(), 'ota-host-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'operator.json');
  const { brokerUrl, prefix, device } = options;
  await writeFile(path, JSON.stringify({ brokerUrl, prefix, device }), { mode: 0o600 });
  return path;
}

test('CLI status uses explicit keyless configuration and accepts ordinary file permissions', async t => {
  const peer = await fixture(t);
  const path = await operatorConfig(t, peer.options);
  const result = await cli(['--config', path, '--boot-timeout-ms', '90000', '--request-timeout-ms', '200', 'status']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).healthy, false);
  assert.equal(result.stdout.includes(otherDigest), false);
  assert.equal(result.stderr.includes(otherDigest), false);
  assert.deepEqual(peer.requests.map(entry => entry.req.op), ['status']);
  await chmod(path, 0o644);
  const ordinary = await cli(['--config', path, 'status']);
  assert.equal(ordinary.code, 0, ordinary.stderr);
  assert.equal(peer.requests.length, 2);
  const absent = await cli(['status']);
  assert.notEqual(absent.code, 0);
  assert.match(absent.stderr, /config|Usage/);
});

test('CLI upload stages only the explicitly named file and verifies its digest', async t => {
  const bytes = Buffer.from('OTA_APP_PROTOCOL = 1\n');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const peer = await fixture(t, { onRequest(req, p) {
    if (req.op === 'finish') p.state.candidate = { slot: 'a', size: bytes.length, sha256 };
    return p.reply(req);
  } });
  const path = await operatorConfig(t, peer.options);
  const app = join(path, '..', 'diagnostic.py');
  await writeFile(app, bytes);
  const result = await cli(['--config', path, 'upload', app]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).sha256, sha256);
  assert.deepEqual(peer.requests.map(entry => entry.req.op), ['status', 'begin', 'chunk', 'finish', 'status']);
  assert.equal(result.stdout.includes(otherDigest), false);
  const bad = await cli(['--config', path, 'upload']);
  assert.notEqual(bad.code, 0);
});

for (const command of ['activate', 'confirm', 'rollback']) {
  test(`CLI ${command} runs only the explicitly requested control and verifies state`, async t => {
    const sha256 = 'cd'.repeat(32);
    const descriptor = { slot: 'a', size: 12, sha256 };
    const peer = await fixture(t, { async onRequest(req, p) {
      if (req.op === 'activate' || req.op === 'rollback') {
        await p.reply(req, { restart: true });
        p.boot = 'ef'.repeat(16); p.seq = 1;
        p.state = { ...p.state, confirmed: command === 'rollback' ? descriptor : null, candidate: command === 'activate' ? descriptor : null,
          selected: descriptor, trial: command === 'activate' ? { ...descriptor, attempted: true } : null, healthy: true };
        await p.hello();
      } else {
        if (req.op === 'confirm') p.state = { ...p.state, confirmed: descriptor, candidate: null, trial: null, selected: descriptor, healthy: true };
        await p.reply(req);
      }
    } });
    if (command === 'rollback') peer.state.confirmed = descriptor;
    const path = await operatorConfig(t, peer.options);
    const result = await cli(['--config', path, command, ...(command === 'rollback' ? [] : [sha256])]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(peer.requests.filter(entry => entry.req.op === command).length, 1);
    assert.equal(peer.requests.at(-1).req.op, 'status');
    assert.equal(result.stdout.includes(otherDigest), false);
  });
}

test('consumed errors advance sequence while protocol errors require reconnect', async t => {
  let code = null;
  const peer = await fixture(t, { onRequest(req, p) {
    return code ? p.publish('response', envelope('response', req, { ok: false, error: code })) : p.reply(req);
  } });
  await peer.client.connect();
  code = 'no_candidate';
  await assert.rejects(peer.client.request('activate', { sha256: otherDigest }), /no_candidate/);
  code = null;
  await peer.client.request('status', {});
  assert.equal(peer.requests.at(-1).req.seq, 3);
  code = 'sequence';
  await assert.rejects(peer.client.request('status', {}), /sequence/);
  code = null;
  await assert.rejects(peer.client.request('status', {}), /not ready/);
});
