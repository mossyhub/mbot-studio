import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';

export const RECORDING_LIMITS = Object.freeze({ uploadBytes: 1024 * 1024, durationMs: 3000, encodedBytes: 24 * 1024, assets: 8 });

const INPUT_FORMATS = Object.freeze({ 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/webm': 'matroska', 'audio/ogg': 'ogg', 'audio/mp4': 'mov' });
export class RecordingError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

function validName(name) { return typeof name === 'string' && name.trim().length > 0 && [...name].length <= 80 && !/[\x00-\x1f\x7f]/u.test(name); }
function assetId(id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new RecordingError('recording_invalid_id', 'Invalid recording ID.');
  return id;
}

const mutations = new Set(); // One bounded writer per DATA_DIR in this single-process server.
export class RecordingService {
  constructor({ dataDir = process.env.DATA_DIR || fileURLToPath(new URL('../../', import.meta.url)), ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg', timeoutMs = 10000, syncAdapter = null } = {}) {
    this.root = path.resolve(dataDir, 'recordings');
    this.ffmpegPath = ffmpegPath;
    this.timeoutMs = Math.min(10000, Math.max(1, timeoutMs));
    this.syncAdapter = syncAdapter;
    this.registry = new Map();
  }

  async mutate(operation) {
    if (mutations.has(this.root)) throw new RecordingError('recording_busy', 'Another recording operation is in progress.', 409);
    mutations.add(this.root);
    try { return await operation(); }
    finally { mutations.delete(this.root); }
  }

  async create(options) { return this.mutate(() => this.createAsset(options)); }

  async initialize() {
    if (!this.initializing) this.initializing = (async () => {
      await fs.mkdir(path.join(this.root, 'assets'), { recursive: true, mode: 0o700 });
      await fs.mkdir(path.join(this.root, 'tmp'), { recursive: true, mode: 0o700 });
      for (const id of await fs.readdir(path.join(this.root, 'assets'))) {
        try { await this.getAsset(id); }
        catch (error) { if (!(error instanceof RecordingError)) throw error; }
      }
    })().catch(error => { this.initializing = null; throw error; });
    return this.initializing;
  }

  get(id) { return this.registry.get(assetId(id)) || null; }
  async read(id) { return (await this.getAsset(id)).audio; }

  remember(metadata) {
    this.registry.set(metadata.id, Object.freeze({ id: metadata.id, sha256: metadata.id, size: metadata.bytes, duration_ms: metadata.durationMs }));
  }

  isReady(id) {
    try {
      const state = this.syncAdapter?.getStatus();
      const receipt = this.syncAdapter?.getVerification(id);
      return state?.connected === true && !!state.bootId && state.capabilities?.includes('recorded_audio_v1') === true && receipt?.verified === true && receipt.id === id && receipt.sha256 === id && receipt.bootId === state.bootId;
    } catch { return false; }
  }

  async sync(id, { signal } = {}) {
    return this.mutate(async () => {
      signal?.throwIfAborted();
      let cancel;
      const canceled = new Promise((_resolve, reject) => { cancel = () => reject(signal.reason); });
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        const asset = await Promise.race([this.getAsset(id, { signal }), canceled]);
        signal?.throwIfAborted();
        if (typeof this.syncAdapter?.sync !== 'function') throw new RecordingError('recording_sync_unavailable', 'Device recording sync is not configured.', 503);
        const state = this.syncAdapter.getStatus();
        if (state?.connected !== true || !state.bootId) throw new RecordingError('recording_device_unavailable', 'Connect the robot before syncing.', 409);
        if (state.idle !== true) throw new RecordingError('recording_device_busy', 'Robot must be idle before syncing.', 409);
        if (!state.capabilities?.includes('recorded_audio_v1')) throw new RecordingError('recording_capability_missing', 'Robot does not support verified recording playback.', 409);
        const bootId = state.bootId;
        await Promise.race([this.syncAdapter.sync(asset, { bootId, signal }), canceled]);
        signal?.throwIfAborted();
        if (this.syncAdapter.getStatus()?.bootId !== bootId || !this.isReady(id)) throw new RecordingError('recording_sync_invalidated', 'Device verification was not retained for the current boot.', 409);
        // Metadata/bytes were checked under the mutation lock before transfer.
        // Do not reopen an asynchronous read after the verified commit boundary.
        return Object.freeze({ ...asset.metadata, ready: true });
      } finally {
        signal?.removeEventListener('abort', cancel);
      }
    });
  }

  run(args, maxBuffer = 128 * 1024) {
    return new Promise((resolve, reject) => {
      execFile(this.ffmpegPath, ['-nostdin', '-hide_banner', '-v', 'error', ...args],
        { encoding: 'buffer', timeout: this.timeoutMs, maxBuffer, killSignal: 'SIGKILL' },
        (error, stdout) => {
          if (error?.code === 'ENOENT') return reject(new RecordingError('recording_transcoder_unavailable', 'Local audio transcoder is unavailable.', 503));
          if (error?.killed) return reject(new RecordingError('recording_transcode_timeout', 'Local audio transcoder timed out.', 504));
          return error ? reject(error) : resolve(stdout);
        });
    });
  }

  async createAsset({ audio, contentType, name = 'Recording' }) {
    if (!validName(name)) throw new RecordingError('recording_invalid_name', 'Name must contain 1–80 characters without control characters.');
    if (!Buffer.isBuffer(audio) || !audio.length) throw new RecordingError('recording_invalid_audio', 'A nonempty raw audio body is required.');
    if (audio.length > RECORDING_LIMITS.uploadBytes) throw new RecordingError('recording_upload_too_large', 'Recording upload exceeds 1 MiB.', 413);
    const mimeType = String(contentType).split(';')[0].trim().toLowerCase();
    const format = Object.hasOwn(INPUT_FORMATS, mimeType) ? INPUT_FORMATS[mimeType] : null;
    if (!format) throw new RecordingError('recording_type_unsupported', 'Use WebM, Ogg, MP4 or WAV audio.', 415);
    await this.initialize();
    const temp = await fs.mkdtemp(path.join(this.root, 'tmp', 'upload-'));
    try {
      const input = path.join(temp, 'input');
      await fs.writeFile(input, audio, { mode: 0o600 });
      let pcm;
      try {
        // Decode the entire input, never use -t: metadata duration is absent in MediaRecorder WebM.
        // Bounded PCM output rejects long audio instead of silently storing a truncated recording.
        pcm = await this.run(['-xerror', '-err_detect', 'explode', '-protocol_whitelist', 'file,pipe', '-threads', '1', '-f', format, '-i', input, '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '1', '-ar', '32000', '-f', 's16le', 'pipe:1'], 192002);
      } catch (error) {
        if (error instanceof RecordingError) throw error;
        if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && error.message.includes('stdout')) throw new RecordingError('recording_too_long', 'Recordings must be at most 3 seconds.');
        throw new RecordingError('recording_invalid_audio', 'Audio could not be decoded.');
      }
      if (pcm.length > 192000) throw new RecordingError('recording_too_long', 'Recordings must be at most 3 seconds.');
      if (!pcm.length) throw new RecordingError('recording_invalid_audio', 'Audio contains no decoded samples.');
      const raw = path.join(temp, 'audio.pcm'), output = path.join(temp, 'audio.mp3');
      await fs.writeFile(raw, pcm, { mode: 0o600 });
      // Match the device-proved MPEG1 MP3 contract, with no ID3 or Xing/Info headers.
      await this.run(['-f', 's16le', '-ar', '32000', '-ac', '1', '-i', raw, '-c:a', 'libmp3lame', '-b:a', '32k', '-map_metadata', '-1', '-write_xing', '0', '-id3v2_version', '0', output]);
      const encoded = await fs.readFile(output);
      if (!encoded.length || encoded.length > RECORDING_LIMITS.encodedBytes) throw new RecordingError('recording_encoded_too_large', 'Encoded audio exceeds 24 KiB.', 413);
      await fs.chmod(output, 0o600);
      const id = createHash('sha256').update(encoded).digest('hex');
      const entries = await fs.readdir(path.join(this.root, 'assets'));
      if (entries.includes(id)) return (await this.getAsset(id)).metadata;
      if (entries.length >= RECORDING_LIMITS.assets) throw new RecordingError('recording_quota_exceeded', 'Delete a recording before adding another (maximum 8).', 409);
      // durationMs measures source PCM, not unavoidable MP3 frame/encoder padding.
      const metadata = Object.freeze({ id, name, durationMs: Math.ceil(pcm.length / 64), bytes: encoded.length, ready: false });
      await fs.writeFile(path.join(temp, 'metadata.json'), JSON.stringify(metadata), { mode: 0o600 });
      await fs.rm(input); await fs.rm(raw);
      await fs.rename(temp, path.join(this.root, 'assets', id));
      this.remember(metadata);
      return metadata;
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
  }

  async list() {
    await this.initialize();
    const entries = await fs.readdir(path.join(this.root, 'assets'));
    return Promise.all(entries.map(async id => (await this.getAsset(id)).metadata));
  }

  async delete(id) {
    return this.mutate(() => this.deleteAsset(id));
  }

  async deleteAsset(id) {
    assetId(id);
    // The transfer adapter resolves only after a fenced removal/absence ACK.
    // Never discard the local copy when device cleanup failed or is unavailable.
    const deviceDeleted = this.syncAdapter != null;
    if (deviceDeleted) {
      if (typeof this.syncAdapter.delete !== 'function') throw new RecordingError('recording_delete_unavailable', 'Device recording deletion is not configured.', 503);
      try { await this.syncAdapter.delete(id); }
      catch (error) {
        if (error.code === 'RECORDING_TRANSFER_REJECTED') throw new RecordingError('recording_delete_failed', 'Device deletion was not confirmed. The local recording has been kept.', 409);
        throw error;
      }
    }
    try { await fs.rm(path.join(this.root, 'assets', id), { recursive: true }); }
    catch (error) {
      if (error.code === 'ENOENT') throw new RecordingError('recording_not_found', 'Recording not found.', 404);
      throw error;
    }
    this.registry.delete(id);
    return { id, deleted: true, deviceDeleted };
  }

  async getAsset(id, { signal } = {}) {
    signal?.throwIfAborted();
    const dir = path.join(this.root, 'assets', assetId(id));
    let metadata, audio;
    try {
      const metaStat = await fs.lstat(path.join(dir, 'metadata.json'));
      const audioStat = await fs.lstat(path.join(dir, 'audio.mp3'));
      if (!(await fs.lstat(dir)).isDirectory() || !metaStat.isFile() || metaStat.size > 1024 || !audioStat.isFile() || audioStat.size > RECORDING_LIMITS.encodedBytes) throw new Error('invalid files');
      metadata = JSON.parse(await fs.readFile(path.join(dir, 'metadata.json'), 'utf8'));
      audio = await fs.readFile(path.join(dir, 'audio.mp3'));
      if (metadata.id !== id || !validName(metadata.name) || !Number.isFinite(metadata.durationMs) || metadata.durationMs <= 0 || metadata.durationMs > RECORDING_LIMITS.durationMs || !audio.length || metadata.bytes !== audio.length || createHash('sha256').update(audio).digest('hex') !== id) throw new Error('invalid metadata or digest');
    } catch (error) {
      signal?.throwIfAborted(); // A canceled read cannot delete a newer registry entry.
      this.registry.delete(id);
      if (error.code === 'ENOENT') throw new RecordingError('recording_not_found', 'Recording not found.', 404);
      throw new RecordingError('recording_corrupt', 'Recording failed local integrity verification.', 409);
    }
    signal?.throwIfAborted(); // Nor may a late read remember an abandoned snapshot.
    metadata = Object.freeze({ id, name: metadata.name, durationMs: metadata.durationMs, bytes: audio.length, ready: this.isReady(id) });
    this.remember(metadata);
    return { metadata, audio };
  }
}
