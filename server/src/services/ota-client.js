import mqtt from 'mqtt';
import { createHash, randomBytes } from 'node:crypto';

const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const descriptor = value => object(value) && ['a', 'b'].includes(value.slot) && typeof value.sha256 === 'string' && HEX64.test(value.sha256) && Number.isInteger(value.size) && value.size >= 1 && value.size <= 131072;
const sameDescriptor = (a, b) => a === null && b === null || descriptor(a) && descriptor(b) && a.slot === b.slot && a.sha256 === b.sha256 && a.size === b.size;

function validConfig({ brokerUrl, prefix, device }) {
  let url;
  try { url = new URL(brokerUrl); } catch { throw new Error('Invalid OTA broker URL'); }
  if (!['mqtt:', 'mqtts:', 'ws:', 'wss:'].includes(url.protocol)) throw new Error('Invalid OTA broker URL');
  if (typeof prefix !== 'string' || !prefix.length || prefix.length > 128 || /[+#\x00-\x1f]/.test(prefix) || prefix.endsWith('/')) throw new Error('Invalid OTA topic prefix');
  if (typeof device !== 'string' || !/^[A-Za-z0-9_-]{1,48}$/.test(device)) throw new Error('Invalid OTA device');
}

function validPayload(op, body) {
  const keys = { status: [], begin: ['transfer', 'size', 'sha256'], chunk: ['transfer', 'offset', 'data'], finish: ['transfer'], abort: ['transfer'], activate: ['sha256'], confirm: ['sha256'], rollback: [] };
  const expected = Object.hasOwn(keys, op) ? keys[op] : null;
  if (!object(body) || !expected || Object.keys(body).sort().join(',') !== [...expected].sort().join(',')) throw new Error('Invalid OTA payload');
  if (expected.includes('transfer') && (typeof body.transfer !== 'string' || !HEX32.test(body.transfer))) throw new Error('Invalid OTA transfer');
  if (expected.includes('sha256') && (typeof body.sha256 !== 'string' || !HEX64.test(body.sha256))) throw new Error('Invalid OTA digest');
  if (op === 'begin' && (!Number.isInteger(body.size) || body.size < 1 || body.size > 131072)) throw new Error('Invalid OTA size');
  if (op === 'chunk' && (!Number.isInteger(body.offset) || body.offset < 0 || body.offset > 131072 || typeof body.data !== 'string' || !/^(?:[0-9a-f]{2}){1,1024}$/.test(body.data))) throw new Error('Invalid OTA chunk');
}

/** Trusted-LAN OTA client, without authentication. IDs and sequencing correlate replies. */
export class OtaClient {
  constructor(options = {}) {
    validConfig(options);
    this.brokerUrl = options.brokerUrl;
    this.device = options.device;
    this.topic = `${options.prefix}/ota/${options.device}`;
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.bootTimeoutMs = options.bootTimeoutMs ?? 90000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 1500;
    this.retries = options.retries ?? 3;
    this.pollIntervalMs = options.pollIntervalMs ?? 200;
    for (const value of [this.timeoutMs, this.bootTimeoutMs, this.requestTimeoutMs, this.pollIntervalMs]) {
      if (!Number.isInteger(value) || value < 1 || value > 600000) throw new Error('Invalid OTA timeout');
    }
    if (!Number.isInteger(this.retries) || this.retries < 0 || this.retries > 10) throw new Error('Invalid OTA retries');
    this._seenBoots = new Set();
    this._boot = null;
    this._seq = null;
    this._ready = false;
    this._closed = false;
    this._pending = null;
  }

  _decode(payload) {
    try {
      if (payload.length > 8192) return null;
      const e = JSON.parse(payload.toString('utf8'));
      if (!object(e) || Object.keys(e).sort().join(',') !== 'body,boot,device,op,seq,v' || e.v !== 1 || e.device !== this.device ||
        typeof e.boot !== 'string' || !HEX32.test(e.boot) || !Number.isSafeInteger(e.seq) || e.seq < 0 ||
        typeof e.op !== 'string' || !/^[a-z]{1,16}$/.test(e.op) || typeof e.body !== 'string') return null;
      const body = JSON.parse(e.body);
      return object(body) ? { envelope: e, body } : null;
    } catch { return null; }
  }

  _message(topic, payload, packet) {
    if (packet.retain) return;
    if (topic === `${this.topic}/hello`) {
      const decoded = this._decode(payload);
      if (!decoded) return;
      const { envelope: e, body } = decoded;
      if (e.op !== 'hello' || e.seq !== 0 || body.protocol !== 1 || body.loader !== '1' || !Number.isSafeInteger(body.next_seq) || body.next_seq < 1) return;
      if (e.boot === this._boot || this._seenBoots.has(e.boot)) return;
      if (this._boot) this._seenBoots.add(this._boot);
      this._boot = e.boot;
      this._seq = body.next_seq;
      this._ready = false;
      this._pending?.reject(new Error('OTA boot changed during request'));
      return;
    }
    if (topic !== `${this.topic}/response` || !this._pending) return;
    const decoded = this._decode(payload);
    if (!decoded) return;
    const { envelope: e, body } = decoded;
    const p = this._pending;
    if (e.boot !== p.boot || e.seq !== p.seq || e.op !== p.op || typeof body.ok !== 'boolean') return;
    if (body.ok && object(body.result)) p.resolve(body.result);
    else if (!body.ok && typeof body.error === 'string' && /^[a-zA-Z0-9_]{1,64}$/.test(body.error)) {
      const error = new Error(`OTA rejected: ${body.error}`);
      error.code = body.error;
      error.consumed = !['sequence', 'envelope'].includes(body.error);
      p.reject(error);
    }
  }

  async _wait(predicate, deadline, message) {
    while (!predicate()) {
      if (this._closed) throw new Error('OTA client closed');
      if (this._failure) throw this._failure;
      if (Date.now() >= deadline) throw new Error(message);
      await pause(Math.min(this.pollIntervalMs, Math.max(1, deadline - Date.now())));
    }
  }

  async connect() {
    if (this._closed || this._mqtt) throw new Error('OTA client already connected or closed');
    const deadline = Date.now() + this.timeoutMs;
    this._mqtt = mqtt.connect(this.brokerUrl, { reconnectPeriod: 0, connectTimeout: this.timeoutMs, clean: true, queueQoSZero: false });
    this._mqtt.on('message', (topic, payload, packet) => this._message(topic, payload, packet));
    const fail = () => {
      this._failure = new Error('OTA broker disconnected');
      this._ready = false;
      this._pending?.reject(this._failure);
    };
    this._mqtt.on('error', fail);
    this._mqtt.on('close', fail);
    this._mqtt.on('connect', () => {
      this._mqtt.subscribe([`${this.topic}/hello`, `${this.topic}/response`], { qos: 0 }, error => {
        if (error) fail();
      });
    });
    await this._wait(() => this._boot !== null, deadline, 'OTA hello timeout');
    return this._request('status', {}, deadline);
  }

  async request(op, body = {}) {
    if (!this._ready) throw new Error('OTA client is not ready');
    return this._request(op, body, Date.now() + this.timeoutMs);
  }

  async _request(op, body, deadline) {
    validPayload(op, body);
    if (this._closed || this._failure || !this._mqtt?.connected || !this._boot) throw new Error('OTA client is not connected');
    if (this._pending) throw new Error('OTA request already outstanding');
    const envelope = { v: 1, device: this.device, boot: this._boot, seq: this._seq, op, body: JSON.stringify(body) };
    const raw = JSON.stringify(envelope);
    if (Buffer.byteLength(raw) > 8192) throw new Error('OTA envelope too large');
    return new Promise((resolve, reject) => {
      let timer;
      let attempts = 0;
      const finish = (error, result) => {
        if (this._pending !== pending) return;
        clearTimeout(timer);
        this._pending = null;
        if (!error || error.consumed) this._seq = envelope.seq + 1;
        else this._ready = false;
        if (error) reject(error);
        else { this._ready = true; resolve(result); }
      };
      const pending = { boot: envelope.boot, seq: envelope.seq, op, resolve: result => finish(null, result), reject: error => finish(error) };
      this._pending = pending;
      const send = () => {
        if (Date.now() >= deadline || attempts > this.retries) return finish(new Error('OTA request timeout; outcome unknown'));
        attempts++;
        timer = setTimeout(send, Math.min(this.requestTimeoutMs, deadline - Date.now()));
        this._mqtt.publish(`${this.topic}/request`, raw, { qos: 0, retain: false }, error => {
          if (error) finish(new Error('OTA publish failed; outcome unknown'));
        });
      };
      send();
    });
  }

  async upload(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 131072) throw new Error('OTA upload requires 1..131072 bytes');
    bytes = Buffer.from(bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const transfer = randomBytes(16).toString('hex');
    await this.request('begin', { transfer, size: bytes.length, sha256 });
    for (let offset = 0; offset < bytes.length; offset += 1024) {
      await this.request('chunk', { transfer, offset, data: bytes.subarray(offset, offset + 1024).toString('hex') });
    }
    await this.request('finish', { transfer });
    const status = await this.request('status', {});
    if (status.candidate?.sha256 !== sha256 || status.candidate?.size !== bytes.length || !['a', 'b'].includes(status.candidate?.slot)) throw new Error('OTA staged candidate verification failed');
    return status.candidate;
  }

  async activate(sha256) {
    if (typeof sha256 !== 'string' || !HEX64.test(sha256)) throw new Error('Invalid OTA digest');
    if (!this._ready) throw new Error('OTA client is not ready');
    const oldBoot = this._boot;
    const ack = await this.request('activate', { sha256 });
    if (ack.restart !== true) throw new Error('OTA activation did not acknowledge restart');
    const deadline = Date.now() + this.bootTimeoutMs;
    await this._wait(() => this._boot !== oldBoot, deadline, 'OTA new boot timeout; activation unverified');
    while (Date.now() < deadline) {
      const state = await this._request('status', {}, deadline);
      if (state.healthy === true && state.selected?.sha256 === sha256 && sameDescriptor(state.selected, state.trial) && sameDescriptor(state.selected, state.candidate) && state.trial?.attempted === true) return state;
      await pause(Math.min(this.pollIntervalMs, Math.max(1, deadline - Date.now())));
    }
    throw new Error('OTA healthy trial timeout; activation unverified');
  }

  async confirm(sha256) {
    if (typeof sha256 !== 'string' || !HEX64.test(sha256)) throw new Error('Invalid OTA digest');
    await this.request('confirm', { sha256 });
    const state = await this.request('status', {});
    if (state.confirmed?.sha256 !== sha256 || state.trial !== null) throw new Error('OTA confirmation verification failed');
    return state;
  }

  async rollback() {
    if (!this._ready) throw new Error('OTA client is not ready');
    const before = await this.request('status', {});
    const oldBoot = this._boot;
    const ack = await this.request('rollback', {});
    if (ack.restart !== true) throw new Error('OTA rollback did not acknowledge restart');
    const deadline = Date.now() + this.bootTimeoutMs;
    await this._wait(() => this._boot !== oldBoot, deadline, 'OTA new boot timeout; rollback unverified');
    const state = await this._request('status', {}, deadline);
    const expected = before.confirmed;
    if (state.trial !== null || state.candidate !== null || !sameDescriptor(state.confirmed, expected) ||
      !sameDescriptor(state.selected, expected)) throw new Error('OTA rollback verification failed');
    return state;
  }

  async close() {
    this._closed = true;
    this._ready = false;
    this._pending?.reject(new Error('OTA client closed'));
    if (this._mqtt) await this._mqtt.endAsync(true);
  }
}
