import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { execFileSync } from 'node:child_process';
import { RecordingService } from '../server/src/services/recording-service.js';

async function fixture(t) {
  const { createRecordingRoutes } = await import('../server/src/routes/recordings.js');
  const dataDir = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'voice-http-'));
  const service = new RecordingService({ dataDir });
  const app = express();
  app.use('/api/robot/recordings', createRecordingRoutes({ service }));
  app.use(express.json({ limit: '10mb' }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { base: `http://127.0.0.1:${server.address().port}/api/robot/recordings`, service };
}
function audio() {
  const data = execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2', '-f', 'wav', 'pipe:1']);
  // Seekless ffmpeg WAV uses unknown RIFF/data lengths; finalize this browser-file fixture.
  data.writeUInt32LE(data.length - 8, 4);
  const chunk = data.indexOf('data'); data.writeUInt32LE(data.length - chunk - 8, chunk + 4);
  return data;
}

test('HTTP stores while disconnected, lists, previews privately, rejects missing sync and explicitly deletes local only', async t => {
  const { base, service } = await fixture(t);
  let response = await fetch(`${base}?name=${encodeURIComponent('Hello 🌍')}`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: audio() });
  assert.equal(response.status, 201);
  const saved = await response.json();
  assert.equal(saved.name, 'Hello 🌍'); assert.equal(saved.ready, false);
  response = await fetch(base);
  assert.deepEqual(await response.json(), { recordings: [saved] });
  response = await fetch(`${base}/${saved.id}/audio`);
  assert.match(response.headers.get('content-type'), /^audio\/mpeg/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), await service.read(saved.id));
  response = await fetch(`${base}/${saved.id}/sync`, { method: 'POST' });
  assert.equal(response.status, 503);
  response = await fetch(`${base}/${saved.id}`, { method: 'DELETE' });
  assert.deepEqual(await response.json(), { id: saved.id, deleted: true, deviceDeleted: false });
  response = await fetch(`${base}/${saved.id}/audio`);
  assert.equal(response.status, 404);
  assert.deepEqual(await (await fetch(base)).json(), { recordings: [] });
});

test('HTTP owns a bounded noninflating raw parser and returns sanitized structured failures', async t => {
  const { base } = await fixture(t);
  for (const [body, headers, status, code] of [
    [Buffer.alloc(1048577), { 'Content-Type': 'audio/wav' }, 413, 'recording_upload_too_large'],
    [audio(), { 'Content-Type': 'text/plain' }, 415, 'recording_type_unsupported'],
    [Buffer.from('garbage'), { 'Content-Type': 'audio/wav' }, 400, 'recording_invalid_audio'],
    [Buffer.from('garbage'), { 'Content-Type': 'audio/wav', 'Content-Encoding': 'gzip' }, 415, 'recording_encoding_unsupported'],
  ]) {
    const response = await fetch(base, { method: 'POST', body, headers });
    assert.equal(response.status, status);
    const result = await response.json(); assert.equal(result.code, code);
    assert.ok(!JSON.stringify(result).includes('voice-http-'));
  }
  const response = await fetch(`${base}/not-a-hash/audio`);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'recording_invalid_id');
});
