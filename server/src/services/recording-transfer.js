import { createHash, randomUUID } from 'node:crypto';

export const RECORDING_ID = /^[0-9a-f]{64}$/;
const error = message => Object.assign(new Error(message), { status: 409, code: 'RECORDING_TRANSFER_REJECTED' });
// Never return device-provided rejection text, paths or raw transport errors.
export function recordingTransferMessage(reason = '') {
  if (/timeout/i.test(reason)) return 'Recording sync timed out waiting for robot confirmation. The clip is still saved on Studio. Try Sync again when the robot is idle.';
  if (/progress|busy|idle robot/i.test(reason)) return 'Another operation is using the robot. Wait for it to finish or choose Stop, then try Sync again.';
  if (/cancel|stop|disconnect|offline|stale|identity|OTA|capability|MQTT/i.test(reason)) return 'Recording sync was canceled or the robot connection changed. The clip is still saved on Studio. Reconnect and try Sync again.';
  return 'The robot did not confirm recording sync. The clip is still saved on Studio. Refresh or try Sync again when the robot is idle.';
}
export function recordingMetadata(value, id) {
  if (typeof id !== 'string' || !RECORDING_ID.test(id) || !value || value.id !== id || value.sha256 !== id ||
      !Number.isInteger(value.size) || value.size < 1 || value.size > 24576 ||
      !Number.isInteger(value.duration_ms) || value.duration_ms < 1 || value.duration_ms > 3000) throw error('Invalid trusted recording metadata');
  return Object.freeze({ id, sha256: id, size: value.size, duration_ms: value.duration_ms });
}

/** Application assets only; never shares OTA application/loader slots. */
export class RecordingTransfer {
  constructor(mqtt, { ackTimeoutMs = 5000, verificationTimeoutMs = 15000, retries = 2, sessionTimeoutMs = 300000 } = {}) {
    if (!Number.isInteger(ackTimeoutMs) || ackTimeoutMs < 1 || ackTimeoutMs > 5000 ||
        !Number.isInteger(retries) || retries < 0 || retries > 3 ||
        !Number.isInteger(verificationTimeoutMs) || verificationTimeoutMs < 1 || verificationTimeoutMs > 15000 ||
        !Number.isInteger(sessionTimeoutMs) || sessionTimeoutMs < 1 || sessionTimeoutMs > 300000) throw error('Invalid recording timeout/retries bounds');
    this.mqtt = mqtt;
    this.ackTimeoutMs = ackTimeoutMs;
    this.verificationTimeoutMs = verificationTimeoutMs;
    this.retries = retries;
    this.sessionTimeoutMs = sessionTimeoutMs;
    this.active = null;
    this.verifications = new Map();
    this.generation = 0;
    this.lastProgress = { active: false, generation: 0, phase: 'idle', ackedBytes: 0, totalBytes: null };
  }

  getProgress() {
    this.checkStatus();
    // Explicit public fields only: never expose session, pending payload or bytes.
    return { ...(this.active?.progress || this.lastProgress) };
  }

  updateProgress(session, values) {
    if (this.active !== session) return;
    Object.assign(session.progress, values, { updatedAt: Date.now() });
  }

  finishProgress(session, phase, reason) {
    if (this.active !== session) return;
    this.updateProgress(session, { active: false, phase, endedAt: Date.now(),
      error: reason ? recordingTransferMessage(reason) : null });
    this.lastProgress = { ...session.progress };
  }

  identity() {
    const s = this.mqtt.robotStatusMetadata;
    return JSON.stringify([s.application, s.build, s.boot, s.sha256, s.device]);
  }

  getVerification(id) {
    this.checkStatus();
    const receipt = this.verifications.get(id), mqtt = this.mqtt;
    if (!mqtt.connected || !mqtt.client?.connected || !mqtt.isRobotOnline() || !mqtt.robotStatusLastSeen ||
        Date.now() - mqtt.robotStatusLastSeen >= mqtt.constructor.ROBOT_TIMEOUT ||
        !this.getStatus().capabilities.includes('recorded_audio_v1') || receipt?.identity !== this.identity()) return null;
    return { verified: true, id, sha256: id, bootId: receipt.boot };
  }

  getStatus() {
    const mqtt = this.mqtt, status = mqtt.robotStatusMetadata;
    return {
      connected: mqtt.connected && mqtt.client?.connected === true && mqtt.isRobotOnline() &&
        !!mqtt.robotStatusLastSeen && Date.now() - mqtt.robotStatusLastSeen < mqtt.constructor.ROBOT_TIMEOUT,
      idle: !this.active && !mqtt.driveHold.active && ['ready', 'idle', 'stopped'].includes(mqtt.robotState),
      bootId: status.boot, capabilities: Array.isArray(status.capabilities) ? status.capabilities : [],
    };
  }

  async sync(asset, { bootId, signal } = {}) {
    signal?.throwIfAborted();
    if (bootId !== this.mqtt.robotStatusMetadata.boot) throw error('Recording boot identity changed');
    const id = asset?.metadata?.id;
    const trusted = this.mqtt.resolveRecording(id);
    if (asset.metadata.bytes !== trusted.size || asset.metadata.durationMs !== trusted.duration_ms) throw error('Recording metadata changed');
    return this.run([id], () => ({ ...trusted, audio: asset.audio }), undefined, { signal });
  }

  validateStatus() {
    const mqtt = this.mqtt, status = mqtt.robotStatusMetadata;
    if (!mqtt.connected || !mqtt.client?.connected || !mqtt.isRobotOnline() || !mqtt.robotStatusLastSeen ||
        Date.now() - mqtt.robotStatusLastSeen >= mqtt.constructor.ROBOT_TIMEOUT) throw error('Recording robot is stale or offline');
    if (!mqtt.isCooperativeApp() || status.build !== 'mbot-av-control-v1' ||
        !Array.isArray(status.capabilities) || !status.capabilities.includes('recorded_audio_v1')) throw error('Recording capability unavailable');
    if (typeof status.boot !== 'string' || !status.boot.trim() || status.boot.length > 128) throw error('Recording requires boot identity');
    if (!['ready', 'idle', 'stopped'].includes(mqtt.robotState) || mqtt.driveHold.active) throw error('Recording transfer requires idle robot');
  }

  assertSession(session) {
    session.signal?.throwIfAborted();
    if (this.active !== session) throw error('Recording session canceled');
    this.validateStatus();
    if (session.identity !== this.identity()) throw error('Recording robot identity changed');
  }

  checkStatus() {
    if (!this.getStatus().connected || !this.getStatus().capabilities.includes('recorded_audio_v1') ||
        [...this.verifications.values()].some(receipt => receipt.identity !== this.identity())) this.verifications.clear();
    if (!this.active) return;
    try { this.assertSession(this.active); }
    catch (err) { this.invalidate(err.message); }
  }

  rejectCompetingCommand() {
    if (this.active) throw error('Recording transfer in progress');
  }

  invalidate(reason, abort = true, outcome = 'canceled') {
    this.verifications.clear();
    this.cancelSession(this.active, reason, abort, outcome);
  }

  cancelSession(session, reason, abort = true, outcome = 'canceled') {
    if (!session || this.active !== session) return;
    this.finishProgress(session, outcome, reason);
    this.active = null; // Revoke BEFORE any callback or publication.
    for (const [id, receipt] of this.verifications) {
      if (receipt.owner === session.owner) this.verifications.delete(id);
    }
    clearTimeout(session.timer);
    const err = error(reason);
    if (this.pending?.session === session) this.pending.finish(err);
    session.cancel(err);
    if (abort && session.started && this.mqtt.connected && this.mqtt.client?.connected && session.identity === this.identity()) {
      try { this.mqtt.publishRecorded(`${this.mqtt.topicPrefix}/robot/asset`, JSON.stringify({
        op: 'abort', transfer_id: session.transfer_id, boot: session.boot,
      })); } catch { /* Never retry cancellation or resume a revoked session. */ }
    }
  }

  async run(ids, load, commit = () => true, { signal } = {}) {
    if (!Array.isArray(ids) || ids.length < 1 || new Set(ids).size > 8 || ids.some(id => typeof id !== 'string' || !RECORDING_ID.test(id))) throw error('Recording requires 1..8 valid asset IDs');
    return this.withSession(async (session, canceled) => {
      const assets = [];
      this.updateProgress(session, { assetCount: new Set(ids).size });
      for (const id of new Set(ids)) {
        this.updateProgress(session, { assetId: id });
        const asset = await Promise.race([load(id), canceled]);
        this.assertSession(session);
        const metadata = recordingMetadata(asset, id);
        if (!Buffer.isBuffer(asset.audio)) throw error('Recording bytes unavailable');
        const bytes = Buffer.from(asset.audio);
        if (bytes.length !== metadata.size || createHash('sha256').update(bytes).digest('hex') !== id) throw error('Recording bytes do not match trusted digest');
        assets.push({ metadata, bytes });
      }
      for (const [index, { metadata, bytes }] of assets.entries()) {
        session.id = metadata.id;
        session.transfer_id = randomUUID();
        this.updateProgress(session, { assetId: metadata.id, assetIndex: index + 1, totalBytes: bytes.length, ackedBytes: 0, phase: 'beginning' });
        await this.request(session, { op: 'begin', ...metadata }, 0);
        for (let offset = 0; offset < bytes.length; offset += 512) {
          const chunk = bytes.subarray(offset, offset + 512);
          this.updateProgress(session, { phase: 'transferring' });
          await this.request(session, { op: 'chunk', offset, data: chunk.toString('hex') }, offset + chunk.length);
          this.assertSession(session);
          this.updateProgress(session, { ackedBytes: offset + chunk.length });
        }
        this.updateProgress(session, { phase: 'verifying' });
        await this.request(session, { op: 'finish' }, bytes.length);
        this.assertSession(session);
        if (this.verifications.size >= 8 && !this.verifications.has(metadata.id)) this.verifications.clear();
        this.verifications.set(metadata.id, { boot: session.boot, identity: session.identity, owner: session.owner });
        session.started = false;
      }
      this.assertSession(session);
      this.updateProgress(session, { phase: 'committing' });
      return commit(session);
    }, { signal });
  }

  async withSession(work, { signal } = {}) {
    signal?.throwIfAborted();
    this.rejectCompetingCommand();
    this.validateStatus();
    const session = { boot: this.mqtt.robotStatusMetadata.boot, identity: this.identity(), signal, owner: Symbol('recording session') };
    session.progress = { active: true, generation: ++this.generation, sessionId: randomUUID(), bootId: session.boot,
      assetId: null, assetIndex: 0, assetCount: 0, phase: 'loading', ackedBytes: 0, totalBytes: null,
      startedAt: Date.now(), updatedAt: Date.now(), endedAt: null, error: null };
    const canceled = new Promise((resolve, reject) => { session.cancel = reject; });
    canceled.catch(() => {});
    this.active = session;
    const cancel = () => this.cancelSession(session, 'Recording sync request canceled');
    signal?.addEventListener('abort', cancel, { once: true });
    session.timer = setTimeout(() => this.active === session && this.invalidate('Recording session timeout', true, 'failed'), this.sessionTimeoutMs);
    try {
      const result = await Promise.race([work(session, canceled), canceled]);
      this.finishProgress(session, 'succeeded');
      return result;
    } catch (err) {
      if (this.active === session) this.invalidate(err.message, true, 'failed');
      throw err;
    } finally {
      signal?.removeEventListener('abort', cancel);
      clearTimeout(session.timer);
      if (this.active === session) this.active = null;
    }
  }

  async control(op, id) {
    if (typeof id !== 'string' || !RECORDING_ID.test(id)) throw error('Invalid recording ID');
    return this.withSession(async session => {
      session.id = id;
      session.transfer_id = randomUUID();
      this.updateProgress(session, { assetId: id, assetIndex: 1, assetCount: 1, phase: op === 'delete' ? 'deleting' : 'checking' });
      const ack = await this.request(session, { op, id }, op === 'status' ? null : 0);
      this.assertSession(session);
      if (op === 'delete') this.verifications.delete(id);
      return ack;
    });
  }

  delete(id) { return this.control('delete', id); }
  status(id) { return this.control('status', id); }

  request(session, body, offset) {
    // A resolved old ACK can resume after cancellation and a new owner starts.
    // Fence BEFORE installing pending state, not only at the publish boundary.
    this.assertSession(session);
    return new Promise((resolve, reject) => {
      const finish = (err, data) => {
        if (this.pending !== pending) return;
        this.pending = null;
        clearTimeout(pending.timer);
        if (err) reject(err); else resolve(data);
      };
      const pending = { session, op: body.op, offset, finish };
      this.pending = pending;
      const payload = JSON.stringify({ ...body, transfer_id: session.transfer_id, boot: session.boot });
      let attempts = 0;
      const send = () => {
        if (this.pending !== pending) return;
        if (attempts++ > this.retries) return finish(error('Recording ACK timeout'));
        // Finish/status need a 15s total hash/ACK budget, but firmware expires
        // inactive transfers at 10s. Its duplicate-job coalescing refreshes that
        // lease, so retransmit the EXACT request at 5s/10s (default two retries).
        const delay = ['finish', 'status'].includes(body.op)
          ? Math.ceil(this.verificationTimeoutMs / (this.retries + 1)) : this.ackTimeoutMs;
        pending.timer = setTimeout(send, delay);
        try {
          this.assertSession(session);
          session.started = true;
          this.mqtt.publishRecorded(`${this.mqtt.topicPrefix}/robot/asset`, payload, err => { if (err) finish(err); });
        } catch (err) { finish(err); }
      };
      send();
    });
  }

  handleAck(data, packet = {}) {
    const p = this.pending;
    if (packet.retain || !p || data?.transfer_id !== p.session.transfer_id || data.boot !== p.session.boot ||
        data.op !== p.op || data.id !== p.session.id || typeof data.ok !== 'boolean' ||
        !Number.isInteger(data.offset) || data.offset < 0 || data.offset > 24576 ||
        (data.ok && p.offset !== null && data.offset !== p.offset)) return;
    if (data.ok) p.finish(null, data);
    else if (p.op === 'delete' && data.error === 'missing' && data.offset === 0) p.finish(null, data);
    else p.finish(error(`Recording device rejected ${p.op}: ${data.error || 'unknown'}`));
  }
}
