import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
async function setup(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'voice-test-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const { RecordingService } = await import('../server/src/services/recording-service.js');
  return { dataDir, service: new RecordingService({ dataDir, ffmpegPath, ...options }) };
}
function wav(seconds = 0.25, frequency = 440) {
  const samples = Math.round(seconds * 16000), data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(16000, 24); data.writeUInt32LE(32000, 28); data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(6000 * Math.sin(i * frequency * Math.PI * 2 / 16000)), 44 + i * 2);
  return data;
}

test('default recording storage matches server DATA_DIR fallback independently of cwd', async t => {
  const { RecordingService } = await import('../server/src/services/recording-service.js');
  const { fileURLToPath } = await import('node:url');
  const previous = process.env.DATA_DIR, cwd = process.cwd();
  const scratch = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'voice-cwd-'));
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));
  try {
    delete process.env.DATA_DIR;
    process.chdir(scratch);
    assert.equal(new RecordingService().root, fileURLToPath(new URL('../server/recordings', import.meta.url)));
    process.env.DATA_DIR = scratch;
    assert.equal(new RecordingService().root, path.join(scratch, 'recordings'));
    assert.equal(new RecordingService({ dataDir: path.join(scratch, 'explicit') }).root, path.join(scratch, 'explicit', 'recordings'));
  } finally {
    process.chdir(cwd);
    if (previous === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous;
  }
});

test('rejects excess upload, bad MIME, invalid decode and overlong input without storing a truncated asset', async t => {
  const { service, dataDir } = await setup(t);
  for (const [audio, contentType, code] of [
    [Buffer.alloc(1048577), 'audio/wav', 'recording_upload_too_large'],
    [wav(), 'text/plain', 'recording_type_unsupported'],
    [wav(), 'constructor', 'recording_type_unsupported'],
    [Buffer.alloc(0), 'audio/wav', 'recording_invalid_audio'],
    [Buffer.from('not audio'), 'audio/wav', 'recording_invalid_audio'],
    [wav(3.01), 'audio/wav', 'recording_too_long'],
  ]) await assert.rejects(service.create({ audio, contentType }), e => e.code === code);
  assert.deepEqual(await service.list(), []);
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'recordings', 'tmp')), []);
  const exact = await service.create({ audio: wav(3), contentType: 'audio/wav' });
  assert.equal(exact.durationMs, 3000);
  const oneSecond = await service.create({ audio: wav(1), contentType: 'audio/wav' });
  assert.equal(oneSecond.bytes, 4176); // Device-proved one-second MPEG1/32kHz/32kbps framing.
});

test('device deletion is verified before local removal and failed deletion preserves the clip', async t => {
  let release, calls = 0;
  const syncAdapter = { delete(id) { calls++; return new Promise(resolve => { release = () => resolve({ op: 'delete', id, ok: true, offset: 0 }); }); } };
  const { service } = await setup(t, { syncAdapter });
  const saved = await service.create({ audio: wav(), contentType: 'audio/wav' });
  const deleting = service.delete(saved.id);
  assert.equal(calls, 1);
  assert.ok(service.get(saved.id));
  assert.ok((await service.read(saved.id)).length);
  await assert.rejects(service.delete(saved.id), e => e.code === 'recording_busy');
  release();
  assert.deepEqual(await deleting, { id: saved.id, deleted: true, deviceDeleted: true });
  assert.equal(service.get(saved.id), null);
  await assert.rejects(service.read(saved.id), e => e.status === 404);

  const again = await service.create({ audio: wav(), contentType: 'audio/wav' });
  syncAdapter.delete = async () => { throw new Error('device offline'); };
  await assert.rejects(service.delete(again.id), /device offline/);
  assert.ok(service.get(again.id));
  assert.equal((await service.list())[0].id, again.id);
  assert.ok((await service.read(again.id)).length);
  delete syncAdapter.delete;
  await assert.rejects(service.delete(again.id), e => e.code === 'recording_delete_unavailable');
  assert.ok((await service.read(again.id)).length);
});

test('aborted asset read cannot repopulate registry state after the sync mutex is released', async t => {
  const { service } = await setup(t);
  const saved = await service.create({ audio: wav(), contentType: 'audio/wav' });
  const readFile = fs.readFile;
  let release, reading;
  const started = new Promise(resolve => { reading = resolve; });
  fs.readFile = async (...args) => {
    const value = await readFile(...args);
    if (String(args[0]).endsWith('/audio.mp3')) {
      reading(); await new Promise(resolve => { release = resolve; });
    }
    return value;
  };
  t.after(() => { fs.readFile = readFile; release?.(); });
  const controller = new AbortController();
  const syncing = service.sync(saved.id, { signal: controller.signal });
  const rejected = assert.rejects(syncing, /abort/i);
  await started;
  controller.abort(); await rejected;
  // A subsequent operation owns registry state now, not the abandoned read.
  service.registry.delete(saved.id);
  fs.readFile = readFile;
  release();
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.get(saved.id), null);
});

test('quota never evicts, duplicate hash preserves original name, explicit delete frees space', async t => {
  const { service } = await setup(t);
  const first = await service.create({ audio: wav(), contentType: 'audio/wav', name: 'Original' });
  assert.deepEqual(await service.create({ audio: wav(), contentType: 'audio/wav', name: 'Changed' }), first);
  for (let i = 1; i < 8; i++) await service.create({ audio: wav(0.25, 440 + i), contentType: 'audio/wav' });
  await assert.rejects(service.create({ audio: wav(0.25, 500), contentType: 'audio/wav' }), e => e.code === 'recording_quota_exceeded');
  assert.equal((await service.list()).length, 8);
  await service.delete(first.id);
  await assert.rejects(service.getAsset(first.id), e => e.status === 404);
  await service.create({ audio: wav(0.25, 500), contentType: 'audio/wav' });
  assert.equal((await service.list()).length, 8);
});

test('trusted reads reject traversal and tampering; names are bounded metadata, never paths', async t => {
  const { service, dataDir } = await setup(t);
  for (const id of ['../tmp', '/etc/passwd', 'A'.repeat(64), '', null]) {
    await assert.rejects(service.getAsset(id), e => e.code === 'recording_invalid_id');
    await assert.rejects(service.delete(id), e => e.code === 'recording_invalid_id');
  }
  for (const name of ['x'.repeat(81), '\u0000bad', {}, '']) await assert.rejects(service.create({ audio: wav(), contentType: 'audio/wav', name }), e => e.code === 'recording_invalid_name');
  const asset = await service.create({ audio: wav(), contentType: 'audio/wav', name: '../../name; $(touch no)' });
  const trusted = await service.getAsset(asset.id);
  assert.ok(Object.isFrozen(trusted.metadata));
  trusted.audio.fill(0);
  assert.notDeepEqual((await service.getAsset(asset.id)).audio, trusted.audio);
  const dir = path.join(dataDir, 'recordings', 'assets', asset.id);
  await fs.writeFile(path.join(dir, 'audio.mp3'), Buffer.from('tamper'));
  await assert.rejects(service.getAsset(asset.id), e => e.code === 'recording_corrupt');
  // Corrupt assets still count toward quota, but must remain explicitly deletable.
  await service.delete(asset.id);
  assert.deepEqual(await service.list(), []);
});

test('concurrent uploads are bounded and transcode failures clean temporary files', async t => {
  const { service, dataDir } = await setup(t);
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => service.create({ audio: wav(0.25, 440 + i), contentType: 'audio/wav' })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.code === 'recording_busy'));
  const run = service.run.bind(service);
  service.run = async (args, ...rest) => {
    if (args.includes('libmp3lame')) { await fs.writeFile(args.at(-1), Buffer.alloc(24577)); return Buffer.alloc(0); }
    return run(args, ...rest);
  };
  await assert.rejects(service.create({ audio: wav(), contentType: 'audio/wav' }), e => e.code === 'recording_encoded_too_large');
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'recordings', 'tmp')), []);
  service.run = run;
  await service.create({ audio: wav(), contentType: 'audio/wav' });
  const { service: missing } = await setup(t, { ffmpegPath: '/nonexistent/ffmpeg' });
  await assert.rejects(missing.create({ audio: wav(), contentType: 'audio/wav' }), e => e.code === 'recording_transcoder_unavailable');
  const sleeper = path.join(dataDir, 'sleeper');
  await fs.writeFile(sleeper, `#!${process.execPath}\nsetTimeout(() => {}, 60000);\n`, { mode: 0o700 });
  const { service: timed, dataDir: timedDir } = await setup(t, { ffmpegPath: sleeper, timeoutMs: 40 });
  await assert.rejects(timed.create({ audio: wav(), contentType: 'audio/wav' }), e => e.code === 'recording_transcode_timeout');
  assert.deepEqual(await fs.readdir(path.join(timedDir, 'recordings', 'tmp')), []);
});

test('registry exposes trusted synchronous metadata; readiness is current-boot verified and sync is idle gated', async t => {
  let state = { connected: false, idle: true, bootId: 'boot-a', capabilities: ['recorded_audio_v1'] }, receipt;
  let calls = 0;
  const syncAdapter = { getStatus: () => state, getVerification: () => receipt,
    async sync(asset, { bootId }) { calls++; receipt = { verified: true, id: asset.metadata.id, sha256: asset.metadata.id, bootId }; }
  };
  const { service, dataDir } = await setup(t, { syncAdapter });
  const saved = await service.create({ audio: wav(), contentType: 'audio/wav' });
  assert.deepEqual(service.get(saved.id), { id: saved.id, sha256: saved.id, size: saved.bytes, duration_ms: saved.durationMs });
  assert.deepEqual(await service.read(saved.id), (await service.getAsset(saved.id)).audio);
  await assert.rejects(service.sync(saved.id), e => e.code === 'recording_device_unavailable');
  state.connected = true; state.idle = false;
  await assert.rejects(service.sync(saved.id), e => e.code === 'recording_device_busy');
  state.idle = true; state.capabilities = [];
  await assert.rejects(service.sync(saved.id), e => e.code === 'recording_capability_missing');
  assert.equal(calls, 0);
  state.capabilities = ['recorded_audio_v1'];
  assert.equal((await service.sync(saved.id)).ready, true);
  assert.equal((await service.list())[0].ready, true);
  state.bootId = 'boot-b';
  assert.equal((await service.list())[0].ready, false);
  syncAdapter.sync = async () => { receipt = { ...receipt, bootId: 'boot-b' }; state.bootId = 'boot-c'; };
  await assert.rejects(service.sync(saved.id), e => e.code === 'recording_sync_invalidated');
  state.connected = false;
  assert.equal((await service.list())[0].ready, false);
  const { RecordingService } = await import('../server/src/services/recording-service.js');
  const restored = new RecordingService({ dataDir, ffmpegPath });
  await restored.initialize();
  assert.deepEqual(restored.get(saved.id), service.get(saved.id));
  assert.equal((await restored.list())[0].ready, false);
  await restored.delete(saved.id);
  assert.equal(restored.get(saved.id), null);
});

test('real WebM/Opus, Ogg and MP4 decode locally and final MP3 matches proved mono MPEG1 32kHz 32kbps without ID3/Xing', async t => {
  const { service, dataDir } = await setup(t);
  for (const [format, codec, contentType] of [['webm', 'libopus', 'audio/webm;codecs=opus'], ['ogg', 'libopus', 'audio/ogg'], ['mp4', 'aac', 'audio/mp4']]) {
    const input = path.join(dataDir, `fixture.${format}`);
    execFileSync(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=700:duration=0.3', '-c:a', codec, input]);
    const saved = await service.create({ audio: await fs.readFile(input), contentType });
    assert.ok(saved.durationMs > 0 && saved.durationMs <= 1000);
    const file = path.join(dataDir, 'recordings', 'assets', saved.id, 'audio.mp3');
    const ffprobe = process.env.FFPROBE_PATH || path.join(path.dirname(ffmpegPath), 'ffprobe');
    const info = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels,bit_rate', '-of', 'json', file]));
    assert.deepEqual(info.streams, [{ codec_name: 'mp3', sample_rate: '32000', channels: 1, bit_rate: '32000' }]);
    const encoded = await fs.readFile(file);
    assert.equal(encoded.readUInt16BE(0) & 0xfffe, 0xfffa); // MPEG1 Layer III frame, either CRC bit.
    assert.notEqual(encoded.subarray(0, 3).toString(), 'ID3');
    assert.equal(encoded.includes(Buffer.from('Xing')), false);
    assert.equal(encoded.includes(Buffer.from('Info')), false);
    await assert.rejects(service.create({ audio: await fs.readFile(input), contentType: 'audio/wav' }), e => e.code === 'recording_invalid_audio');
  }
  // A streaming WebM has no format duration; decoded samples still enforce the limit.
  const streamed = execFileSync(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=4', '-c:a', 'libopus', '-f', 'webm', 'pipe:1']);
  await assert.rejects(service.create({ audio: streamed, contentType: 'audio/webm' }), e => e.code === 'recording_too_long');
});

test('GitHub test job explicitly installs ffmpeg before running audio tests', async () => {
  const workflow = await fs.readFile(new URL('../.github/workflows/docker.yml', import.meta.url), 'utf8');
  const testJob = workflow.split('  test:')[1].split('  build-and-push:')[0];
  assert.match(testJob, /sudo apt-get install[^\n]*\bffmpeg\b/);
  assert.ok(testJob.indexOf('sudo apt-get install') < testJob.indexOf('npm run test:unit'));
});

test('production Alpine image installs the local ffmpeg executable', async () => {
  const dockerfile = await fs.readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /FROM node:[^\s]+-alpine AS production/);
  assert.match(dockerfile.split('AS production')[1], /RUN apk add --no-cache[^\n]*\bffmpeg\b/);
});

test('local WAV becomes a bounded immutable MP3 with trusted bytes and never claims device readiness', async t => {
  const { service, dataDir } = await setup(t);
  const saved = await service.create({ audio: wav(), contentType: 'audio/wav', name: 'Hello' });
  assert.deepEqual(Object.keys(saved).sort(), ['id', 'name', 'durationMs', 'bytes', 'ready'].sort());
  assert.equal(saved.name, 'Hello'); assert.equal(saved.ready, false); assert.equal(saved.durationMs, 250);
  assert.ok(saved.bytes > 0 && saved.bytes <= 24576);
  const asset = await service.getAsset(saved.id);
  assert.equal((await fs.stat(path.join(dataDir, 'recordings', 'assets', saved.id))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(dataDir, 'recordings', 'assets', saved.id, 'audio.mp3'))).mode & 0o777, 0o600);
  assert.equal(createHash('sha256').update(asset.audio).digest('hex'), saved.id);
  assert.equal(asset.audio.length, saved.bytes);
  const probe = execFileSync(ffmpegPath, ['-v', 'error', '-i', 'pipe:0', '-f', 's16le', '-ac', '1', '-ar', '16000', 'pipe:1'], { input: asset.audio });
  assert.ok(probe.length > 0);
  assert.deepEqual(await service.list(), [saved]);
  const { RecordingService } = await import('../server/src/services/recording-service.js');
  assert.deepEqual(await new RecordingService({ dataDir, ffmpegPath }).list(), [saved]);
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'recordings', 'tmp')), []);
});
