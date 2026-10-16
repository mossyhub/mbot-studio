import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lowerProgram } from '../server/src/services/program-lowering.js';
import { encodeProgram, INDEXED_PROGRAM_PROFILE } from '../server/src/services/program-encoding.js';
const id = 'a'.repeat(64);
const resolveRecording = key => key === id ? { id, sha256: id, size: 100, duration_ms: 2750 } : null;

test('recording source resolves trusted duration without mutating source; indexed holds count every playback', () => {
  const source = [{ type: 'repeat', times: 40, do: [{ type: 'play_recording', _id: 'voice', params: { recording: id } }] }];
  const original = structuredClone(source);
  const lowered = lowerProgram(source, { profile: INDEXED_PROGRAM_PROFILE, resolveRecording });
  assert.deepEqual(source, original);
  assert.deepEqual(lowered.program[0], { type: 'play_recording', _id: 'voice', params: { recording: id, duration: 2.75 } });
  assert.equal(lowered.requestedHoldSeconds, 110);
  const encoded = encodeProgram(lowered.program, { profile: INDEXED_PROGRAM_PROFILE, runId: 'voice-test', timestamp: 1 });
  assert.equal(encoded.requestedHoldSeconds, 110);
  assert.deepEqual(encoded.program.commands, [{ type: 'play_recording', duration: 2.75, recording: id }]);
  assert.equal(lowered.sourceMap.length, 40);
});

test('recording source rejects user duration, paths, data and unavailable metadata with source diagnostics', () => {
  for (const params of [{ recording: '../x' }, { recording: id.toUpperCase() }, { recording: 'b'.repeat(64) },
    { recording: id, duration_ms: 1 }, { recording: id, duration: 1 }, { recording: id, data: 'aa' }, { recording: id, path: '/music/x' }]) {
    assert.throws(() => lowerProgram([{ type: 'play_recording', _id: 'bad', params }], { resolveRecording }), error => error.sourceId === 'bad' && error.path === 'program[0]');
  }
  assert.throws(() => lowerProgram([{ type: 'play_recording', recording: id }]), /recording/i);
});

test('whole wire admission limits recordings to eight distinct clips including unused dictionary entries', () => {
  const commands = Array.from({ length: 9 }, (_, i) => ({ type: 'play_recording', recording: i.toString(16).repeat(64), duration: 1 }));
  for (const input of [commands, { format: 'indexed-v1', commands, order: '00' }]) {
    assert.throws(() => encodeProgram(input, { profile: INDEXED_PROGRAM_PROFILE, runId: 'quota', timestamp: 1 }), /8.*recording|recording.*8/i);
  }
});
