import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const secret = /password|passwd|token|secret|credential|authorization|ssid|api.?key/i;
function clean(value, depth = 0) {
  if (depth > 12) return '[depth limit]';
  if (typeof value === 'string') return value.slice(0, 8192)
    .replace(/([a-z]+:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/((?:password|passwd|token|secret|ssid|authorization|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]');
  if (Array.isArray(value)) return value.slice(0, 256).map(v => clean(v, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 128).map(([k, v]) => [k, secret.test(k) ? '[redacted]' : clean(v, depth + 1)]));
  return value;
}

/** Passive bounded evidence; no disk waits on Stop and no restored admission grants. */
export class RobotDiagnostics {
  constructor({ dataDir = process.env.DATA_DIR || fileURLToPath(new URL('../../', import.meta.url)), persist = true, maxEntries = 2000, maxBytes = 1024 * 1024 } = {}) {
    this.persist = persist;
    this.eventBytes = 0;
    this.file = path.join(dataDir, 'robot-diagnostics.jsonl');
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.sessionId = randomUUID();
    this.events = [];
    this.lastKnown = {};
    this.pending = Promise.resolve();
    this.dirty = false;
    this.writing = false;
    this.health = { healthy: true, lastError: null, lastPersistedAt: null, corruptLines: 0, droppedEntries: 0 };
    try {
      if (!persist) throw Object.assign(new Error('Memory only'), { code: 'ENOENT' });
      const fd = fs.openSync(this.file, 'r');
      let text;
      try {
        const size = fs.fstatSync(fd).size;
        const buffer = Buffer.alloc(Math.min(size, maxBytes));
        fs.readSync(fd, buffer, 0, buffer.length, Math.max(0, size - maxBytes));
        text = buffer.toString('utf8');
      } finally { fs.closeSync(fd); }
      for (const line of text.split('\n').filter(Boolean)) {
        try {
          const event = JSON.parse(line);
          if (event && Object.hasOwn(event, 'checkpoint')) {
            if (!event.checkpoint || typeof event.checkpoint !== 'object' || Array.isArray(event.checkpoint)) { this.health.corruptLines++; continue; }
            this.lastKnown = {};
            for (const [key, entry] of Object.entries(event.checkpoint)) {
              if (!['status', 'sensors', 'execution', 'log', 'sensorReadState'].includes(key)
                || !entry || typeof entry !== 'object' || Array.isArray(entry)
                || !Number.isFinite(entry.receivedAt) || !Object.hasOwn(entry, 'payload')
                || (['sensors', 'sensorReadState'].includes(key) && (!entry.payload || typeof entry.payload !== 'object' || Array.isArray(entry.payload)))) {
                this.health.corruptLines++;
                continue;
              }
              this.setKnown(key, clean(entry.payload), entry.receivedAt);
            }
          }
          else if (event && typeof event.kind === 'string' && event.kind.length > 0
            && event.data && typeof event.data === 'object' && !Array.isArray(event.data) && Number.isFinite(event.time)
            && (event.kind !== 'incoming' || (typeof event.data.topic === 'string' && Object.hasOwn(event.data, 'payload')))) {
            const safe = clean(event);
            this.apply(safe);
            this.events.push(safe);
          }
          else this.health.corruptLines++;
        } catch { this.health.corruptLines++; }
      }
    } catch (error) { if (error.code !== 'ENOENT') { this.health.healthy = false; this.health.lastError = error.code || 'READ_ERROR'; } }
    if (this.health.corruptLines) { this.health.healthy = false; this.health.lastError = 'CORRUPT_JOURNAL'; }
    this.eventBytes = this.events.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e)) + 1, 0);
    this.record('studio_start', { previousSessionId: this.events.at(-1)?.sessionId ?? null, gap: 'Studio was not recording while stopped; duration/cause unknown' });
  }
  setKnown(key, payload, receivedAt) {
    // Checkpoint has its own budget, independent of the event ring and disk input.
    if (Buffer.byteLength(JSON.stringify({ payload, receivedAt })) > Math.min(16384, this.maxBytes / 12)) {
      payload = { truncated: true };
      this.health.droppedEntries++;
    }
    this.lastKnown[key] = { payload, receivedAt };
    while (Object.keys(this.lastKnown).length && Buffer.byteLength(JSON.stringify({ checkpoint: this.lastKnown }) + '\n') > this.maxBytes / 2) {
      delete this.lastKnown[Object.keys(this.lastKnown)[0]];
      this.health.droppedEntries++;
    }
  }
  apply(event) {
    if (event.kind === 'incoming') {
      const key = event.data.topic?.split('/')[1];
      if (['status', 'sensors', 'execution', 'log'].includes(key)) {
        let payload = event.data.payload;
        if (key === 'sensors') {
          if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.malformedJson) return;
          if (Object.hasOwn(payload, 'sampling')) this.setKnown('sensorReadState', { sampling: payload.sampling }, event.time);
          if (!Object.keys(payload).some(k => !['sampling', 'timestamp', 'run_id', 'boot', 'build', 'sha256'].includes(k))) return;
        }
        if (key === 'status' && payload && typeof payload === 'object') {
          const old = this.lastKnown.status?.payload;
          const metadata = old && (!payload.boot || payload.boot === old.boot)
            ? Object.fromEntries(['boot', 'build', 'sha256', 'capabilities'].filter(k => Object.hasOwn(old, k)).map(k => [k, old[k]])) : {};
          payload = clean({ ...metadata, ...payload });
        }
        this.setKnown(key, payload, event.time);
      }
    }
  }
  record(kind, data = {}) {
    try {
      let safe = clean(data);
      if (Buffer.byteLength(JSON.stringify(safe)) > Math.min(16384, this.maxBytes / 12)) safe = { truncated: true, topic: safe.topic, run_id: safe.run_id };
      const event = { id: randomUUID(), sessionId: this.sessionId, time: Date.now(), monotonicMs: performance.now(), kind, data: safe };
      this.events.push(event);
      this.apply(event);
      this.eventBytes += Buffer.byteLength(JSON.stringify(event)) + 1;
      // Reserve half the byte budget for last-known checkpoint data.
      while (this.events.length && (this.events.length > this.maxEntries || this.eventBytes > this.maxBytes / 2)) {
        this.eventBytes -= Buffer.byteLength(JSON.stringify(this.events.shift())) + 1;
        this.health.droppedEntries++;
      }
      if (!this.persist) return event.id;
      this.dirty = true;
      if (!this.writing) {
        this.writing = true;
        this.pending = this.pending.then(async () => {
          while (this.dirty) {
            this.dirty = false;
            try {
              await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
              await fs.promises.writeFile(this.file + '.tmp', this.serialize(), { mode: 0o600 });
              await fs.promises.rename(this.file + '.tmp', this.file);
              this.health.healthy = this.health.corruptLines === 0;
              this.health.lastError = this.health.corruptLines ? 'CORRUPT_JOURNAL' : null;
              this.health.lastPersistedAt = Date.now();
            } catch (error) { this.health.healthy = false; this.health.lastError = error.code || 'WRITE_ERROR'; }
          }
          this.writing = false;
        });
      }
      return event.id;
    } catch { this.health.healthy = false; this.health.lastError = 'RECORD_ERROR'; return null; }
  }
  serialize() {
    const checkpoint = JSON.stringify({ checkpoint: this.lastKnown }) + '\n';
    const header = Buffer.byteLength(checkpoint) <= this.maxBytes ? checkpoint : '';
    let lines = this.events.map(e => JSON.stringify(e) + '\n');
    let bytes = Buffer.byteLength(header) + lines.reduce((n, line) => n + Buffer.byteLength(line), 0);
    while (lines.length && bytes > this.maxBytes) {
      const removed = Buffer.byteLength(lines.shift()); bytes -= removed; this.eventBytes -= removed; this.events.shift(); this.health.droppedEntries++;
    }
    return header + lines.join('');
  }
  flush() { return this.pending; }
  snapshot() {
    const now = Date.now();
    return { schemaVersion: 1, generatedAt: now, recording: { ...this.health, pending: this.writing, maxEntries: this.maxEntries, maxBytes: this.maxBytes, durability: 'Asynchronous atomic replacement; abrupt Studio/host loss may lose pending writes' },
      lastKnown: Object.fromEntries(Object.entries(this.lastKnown).map(([k, v]) => [k, { ...v, ageMs: Math.max(0, now - v.receivedAt) }])),
      events: this.events.slice(), semantics: { publish_intent: 'Planned publish, not execution', publish_result: 'Transport callback only; not device acknowledgement or execution', execution: 'Only robot/execution messages are device execution evidence', cutoffCause: 'unknown' } };
  }
}
