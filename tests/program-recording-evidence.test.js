import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { lowerProgram } from '../server/src/services/program-lowering.js';
import { readProgramEvidence, agreesWithServer } from '../web/src/services/program-evidence.js';
import { INDEXED_PROGRAM_PROFILE } from '../server/src/services/program-encoding.js';
import { captureSubmission, acceptSubmission, completeSubmission, cancelSubmission } from '../web/src/services/challenge-progress.js';
import { getStats } from '../web/src/services/achievements.js';

beforeEach(() => {
  const store = new Map();
  globalThis.localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)) };
});

const recording = 'a'.repeat(64);
const clip = { type: 'play_recording', recording, _id: 'voice' };
// Trusted resolver fixture, not browser block metadata or device execution.
const resolveRecording = id => ({ id, sha256: id, size: 100, duration_ms: 2750 });
// Match routes/robot.js: lowered program is deliberately not in the response.
function submitted(blocks, options = {}) {
  const { program, ...result } = lowerProgram(blocks, { resolveRecording, ...options });
  return { sent: true, run_id: 'voice-run', ...result };
}

test('recording evidence matches the real submitted source trace without inventing playback duration', () => {
  const blocks = [clip, { type: 'wait', duration: 0.2, _id: 'pause' }];
  const response = submitted(blocks);
  const evidence = readProgramEvidence(blocks);
  assert.equal(agreesWithServer(evidence, response), true);
  assert.deepEqual(evidence.program, blocks);
  assert.equal(evidence.types.has('play_recording'), true);
  assert.equal(Object.hasOwn(evidence.program[0], 'duration'), false);
  assert.deepEqual(evidence.paths, ['program[0]', 'program[1]']);
  assert.deepEqual(evidence.sourceMap, response.sourceMap);
  assert.equal(evidence.compiledCount, 2);
  assert.equal(Object.hasOwn(response, 'program'), false);
});

test('recording evidence fails closed for malformed recording identifiers', () => {
  for (const id of [undefined, null, '', 'a'.repeat(63), 'a'.repeat(65), recording.toUpperCase(), '../clip.wav',
    { type: 'var_get', name: 'recording' }]) {
    assert.throws(() => readProgramEvidence([{ ...clip, recording: id }]), /recording/i);
    assert.throws(() => readProgramEvidence([{ type: 'play_recording', params: { recording: id } }]), /recording/i);
  }
});

test('browser playback metadata is excluded, including reporter expressions that could claim math skills', () => {
  for (const duration of [999, { type: 'op_add', a: 1, b: 1 }, { type: 'var_get', name: 'untrusted' }]) {
    for (const wrapped of [false, true]) {
      const params = { recording, duration, duration_ms: 999000, metadata: { duration_ms: 999000 } };
      const source = wrapped ? { type: 'play_recording', _id: 'voice', params }
        : { type: 'play_recording', _id: 'voice', ...params };
      const original = structuredClone(source);
      const evidence = readProgramEvidence([source]);
      assert.deepEqual(evidence.program, [clip]);
      assert.deepEqual([...evidence.types], ['play_recording']);
      assert.deepEqual(source, original);
      assert.deepEqual(evidence.sourceMap, submitted([clip]).sourceMap);
    }
  }
});

test('wrapped recordings, reached repeats and selected branches preserve exact ordered server source paths', () => {
  const blocks = [{ type: 'repeat', times: 2, do: [
    { type: 'if_else_predicate', cond: { type: 'op_gt', a: 2, b: 1 }, then: [
      { type: 'play_recording', _id: 'wrapped-voice', params: { recording } },
      { type: 'display_animation', _id: 'frames', frames: ['Ready', 'Go'], interval: 0.1 },
    ], else: [{ ...clip, _id: 'dead-voice' }] },
  ] }];
  for (const encoding of [undefined, 'indexed-v1']) {
    const response = submitted(blocks, encoding ? { profile: INDEXED_PROGRAM_PROFILE } : {});
    const evidence = readProgramEvidence(blocks, encoding);
    assert.equal(agreesWithServer(evidence, response), true);
    assert.equal(evidence.compiledCount, 10);
    assert.equal(evidence.program.filter(b => b.type === 'play_recording').length, 2);
    assert.deepEqual(evidence.paths, [
      'program[0].do[0].then[0]', 'program[0].do[0].then[1]',
      'program[0].do[0].then[0]', 'program[0].do[0].then[1]',
    ]);
    assert.ok(evidence.sourceMap.every(entry => entry.sourceId !== 'dead-voice'));
  }
  const dead = [{ type: 'repeat', times: 0, do: [clip] },
    { type: 'if_else_predicate', cond: false, then: [clip], else: [{ type: 'stop' }] }];
  const evidence = readProgramEvidence(dead);
  assert.equal(agreesWithServer(evidence, submitted(dead)), true);
  assert.equal(evidence.types.has('play_recording'), false);
  assert.deepEqual(evidence.program, [{ type: 'stop' }]);
});

test('indexed playback evidence stays within negotiated instruction budgets', () => {
  const blocks = [{ type: 'repeat', times: 1024, do: [clip] }];
  const response = submitted(blocks, { profile: INDEXED_PROGRAM_PROFILE,
    resolveRecording: id => ({ id, sha256: id, size: 100, duration_ms: 1 }) });
  const evidence = readProgramEvidence(blocks, 'indexed-v1');
  assert.equal(evidence.compiledCount, 1024);
  assert.equal(agreesWithServer(evidence, response), true);
  assert.ok(evidence.program.every(b => !Object.hasOwn(b, 'duration')));
  assert.throws(() => readProgramEvidence(blocks), /repeat/i);
  assert.throws(() => readProgramEvidence(blocks, 'unknown-v2'), /repeat/i);
  assert.throws(() => readProgramEvidence([...blocks, clip], 'indexed-v1'), /instructions/i);
});

const completion = (event = 'completed', run_id = 'voice-run', type = 'program') => ({ type, event, run_id });
const noAwards = { challenges: [], badges: [] };
function accepted(blocks = [clip], response = submitted(blocks), profileId = 'learner') {
  const run = captureSubmission({ blocks, profileId });
  acceptSubmission(run, response);
  return run;
}

test('recording ACKs never award; a matching whole-program completion can earn only existing applicable badges', () => {
  const run = accepted();
  assert.equal(run.verified, true);
  assert.deepEqual(getStats('learner'), {});
  for (const e of [completion('accepted'), completion('started'), completion('completed', 'other-run'),
    completion('completed', 'voice-run', 'play_recording')]) {
    assert.deepEqual(completeSubmission(run, e, 'learner'), noAwards);
    assert.deepEqual(getStats('learner'), {});
  }
  const result = completeSubmission(run, completion(), 'learner');
  assert.deepEqual(result.challenges, []);
  assert.deepEqual(result.badges.map(b => b.id), ['first_program']);
  assert.equal(getStats('learner').verified_runs, 1);
  assert.deepEqual(completeSubmission(run, completion(), 'learner'), noAwards);
  assert.deepEqual(completeSubmission(accepted(), completion(), 'learner'), noAwards);
});

test('recording failure, device cancellation, local Stop and profile mismatch cannot award later completions', () => {
  for (const mode of ['failed', 'canceled', 'stop', 'profile']) {
    const run = accepted([clip], submitted([clip]), mode);
    if (mode === 'stop') cancelSubmission(run);
    else if (mode !== 'profile') assert.deepEqual(completeSubmission(run, completion(mode), mode), noAwards);
    else assert.deepEqual(completeSubmission(run, completion(), 'other-profile'), noAwards);
    assert.deepEqual(completeSubmission(run, completion(), mode), noAwards);
    assert.deepEqual(getStats(mode), {});
  }
});

test('recordings never bypass exact ordered source-map and sent/count/run-id agreement for awards', () => {
  const blocks = [clip, { type: 'move_forward', speed: 20, duration: 2, _id: 'drive' }];
  const good = submitted(blocks);
  const changes = [
    { sourceMap: good.sourceMap.toReversed() },
    { sourceMap: good.sourceMap.slice(1) },
    ...['sourceId', 'path', 'compiledIndex'].map(key => ({
      sourceMap: good.sourceMap.map((entry, i) => i ? entry : { ...entry, [key]: key === 'compiledIndex' ? 1 : 'wrong' }),
    })),
    { compiledCount: 1 }, { sent: false }, { sent: true, run_id: '' },
  ];
  for (const [i, change] of changes.entries()) {
    const profile = `mismatch-${i}`;
    const run = accepted(blocks, { ...good, ...change }, profile);
    assert.equal(run.verified, false);
    assert.deepEqual(completeSubmission(run, completion(), profile), noAwards);
    assert.deepEqual(getStats(profile), {});
  }
});

test('playback in an immutable submitted program does not prevent valid other mission credit or invent wait credit', () => {
  const blocks = [structuredClone(clip), { type: 'move_forward', speed: 20, duration: 2, _id: 'drive' }];
  const config = { additions: [] };
  const run = captureSubmission({ blocks, profileId: 'learner', robotConfig: config });
  const response = submitted(run.blocks);
  blocks[0].recording = 'b'.repeat(64);
  blocks[0].duration = { type: 'op_add', a: 1, b: 1 };
  blocks[1].duration = 0;
  config.additions.push({ type: 'servo', port: 'S1' });
  acceptSubmission(run, response);
  response.sourceMap[0].sourceId = 'edited-after-acceptance';
  response.run_id = 'edited-run';
  assert.equal(run.blocks[0].recording, recording);
  assert.deepEqual(run.robotConfig, { additions: [] });
  assert.equal(run.response.sourceMap[0].sourceId, 'voice');
  assert.equal(run.verified, true);
  const result = completeSubmission(run, completion(), 'learner');
  assert.deepEqual(result.challenges.map(c => c.id), ['ch_forward']);
  assert.ok(result.badges.some(b => b.id === 'first_program'));
  assert.ok(!result.badges.some(b => ['wait_master', 'used_math', 'played_sound'].includes(b.id)));
  assert.equal(Object.hasOwn(run.evidence.program[0], 'duration'), false);
});

test('even a matching trace cannot turn browser playback duration/reporters into wait or math skill evidence', () => {
  // Defensive evidence-only fixture: the real server rejects these extra source
  // fields. A matching trace still must not convert them into duration credit.
  const run = accepted([{ ...clip, duration: { type: 'op_add', a: 1, b: 1 }, duration_ms: 2000 }], submitted([clip]));
  assert.equal(run.verified, true);
  const result = completeSubmission(run, completion(), 'learner');
  assert.deepEqual(result.challenges, []);
  assert.deepEqual(result.badges.map(b => b.id), ['first_program']);
  assert.deepEqual([...run.evidence.types], ['play_recording']);
});
