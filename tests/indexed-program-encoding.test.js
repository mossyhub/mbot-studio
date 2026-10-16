import test from 'node:test';
import assert from 'node:assert/strict';
import * as encoding from '../server/src/services/program-encoding.js';
const options = { profile: 'indexed-v1', runId: '11111111-1111-4111-8111-111111111111', timestamp: 1700000000000 };

test('encoder independently bounds source metadata and full envelope types', () => {
  const program = [{ type: 'wait', duration: 0 }];
  for (const extra of [{ runId: 'x'.repeat(129) }, { runId: 123 }, { timestamp: NaN }, { timestamp: 'bad' }]) {
    assert.throws(() => encoding.encodeProgram(program, { ...options, ...extra }), /envelope|run_id|timestamp/);
  }
  assert.throws(() => encoding.encodeProgram([{ type: 'stop', _id: 'x'.repeat(129) }], options), /128/);
  assert.throws(() => encoding.encodeProgram(program, { ...options, sourceMap: [] }), /source.map/i);
  const sourceMap = Array.from({ length: 1024 }, (_, compiledIndex) => ({ sourceId: '\u0001'.repeat(128), path: 'program[0]', compiledIndex }));
  assert.throws(() => encoding.encodeProgram(Array(1024).fill(program[0]), { ...options, sourceMap }), /262144/);
});

test('exact repeated 12-second animation budget does not reject through float drift', () => {
  const result = encoding.encodeProgram(Array(40).fill({ type: 'display_animation', frames: ['a', 'b'], interval: 0.15 }), options);
  assert.equal(result.expandedCount, 160);
  assert.equal(result.requestedHoldSeconds, 12);
});

test('animations become exact display/wait primitives with executed aggregate budgets', () => {
  const result = encoding.encodeProgram(Array(4).fill({ type: 'display_animation', frames: ['a', 'b'], interval: 0.25 }), options);
  assert.deepEqual(result.program.commands, [{ type: 'display_text', size: 24, text: 'a' }, { type: 'wait', duration: 0.25 }, { type: 'display_text', size: 24, text: 'b' }]);
  assert.equal(result.program.order, '00010201000102010001020100010201');
  assert.equal(result.expandedCount, 16);
  assert.equal(result.requestedHoldSeconds, 2);
  assert.throws(() => encoding.encodeProgram(Array(7).fill({ type: 'display_animation', frames: ['a'], interval: 2 }), options), /animation.*12/);
});

test('pure encoder rejects unknown keys, invalid literals and malformed indexed dictionaries before serialization', () => {
  const wrap = (commands, order = '00') => ({ format: 'indexed-v1', commands, order });
  for (const block of [{ type: 'wait', surprise: 1 }, { type: 'wait', duration: null },
    { type: 'wait', duration: true }, { type: 'wait', duration: NaN }, { type: 'wait', duration: Infinity },
    { type: 'wait', params: { type: 'stop' } }, { type: 'wait', params: {}, duration: 1 },
    { type: 'wait', params: { _id: 'hidden' } }, { type: 'wait', timestamp: 1 },
    { type: 'repeat', times: 1, do: [] }, { type: 'display_text' },
    { type: 'display_text', text: 'a'.repeat(129) }, { type: 'servo', port: 'S1', speed: 1 },
    { type: 'turn_left', angle: 361 }, { type: 'play_sound', sound: 'x' }, { type: 'set_led', color: 'magenta' },
    { type: 'display_animation', frames: ['a'], interval: 0.1 },
  ]) assert.throws(() => encoding.encodeProgram([block], options), undefined, JSON.stringify(block));
  for (const program of [
    wrap([{ type: 'wait', duration: 0 }], ''), wrap([{ type: 'stop' }], '0'), wrap([{ type: 'stop' }], 'zz'),
    wrap([{ type: 'stop' }], '01'), wrap([{ type: 'stop' }], '00'.repeat(1025)), wrap([]),
    wrap(Array(33).fill({ type: 'stop' })), wrap([{ type: 'display_animation', frames: ['x'] }]),
    wrap([{ type: 'stop', _id: 'x' }]), wrap([{ type: 'wait', params: { duration: 0 } }]),
    { ...wrap([{ type: 'stop' }]), extra: true }, { ...wrap([{ type: 'stop' }]), format: 'unknown' },
  ]) assert.throws(() => encoding.encodeProgram(program, options));
  const result = encoding.encodeProgram(wrap([{ type: 'wait', duration: 0.1 }, { type: 'stop' }], '000100'), options);
  assert.equal(result.expandedCount, 3);
  assert.equal(result.requestedHoldSeconds, 0.2);
  assert.throws(() => encoding.encodeProgram(wrap([{ type: 'stop' }]), { ...options, profile: 'flat' }), /capability|indexed/i);
});

test('instruction, dictionary, requested hold and complete UTF-8 wire budgets are independent', () => {
  assert.equal(encoding.encodeProgram(Array(1024).fill({ type: 'wait', duration: 0.1 }), options).expandedCount, 1024);
  assert.throws(() => encoding.encodeProgram(Array(1025).fill({ type: 'wait', duration: 0 }), options), /1024/);
  assert.equal(encoding.encodeProgram(Array.from({ length: 32 }, (_, i) => ({ type: 'wait', duration: i / 100 })), options).uniqueCount, 32);
  assert.throws(() => encoding.encodeProgram(Array.from({ length: 33 }, (_, i) => ({ type: 'wait', duration: i / 100 })), options), /32.*unique|unique.*32/);
  assert.equal(encoding.encodeProgram([{ type: 'wait', duration: 60 }, { type: 'wait', duration: 60 }], options).requestedHoldSeconds, 120);
  assert.throws(() => encoding.encodeProgram(Array(3).fill({ type: 'wait', duration: 60 }), options), /120/);
  assert.throws(() => encoding.encodeProgram(Array.from({ length: 16 }, (_, i) => ({ type: 'display_text', text: String(i) + '😀'.repeat(126) })), options), /8192/);
  assert.throws(() => encoding.encodeProgram([], options), /empty|1\.\./i);
});

test('pure indexed encoder interns equivalent defaults and wrappers without mutating source', () => {
  assert.equal(typeof encoding.encodeProgram, 'function');
  const input = [{ type: 'wait', _id: 'one' }, { type: 'wait', run_id: 'metadata', params: { duration: 1 } }];
  const snapshot = structuredClone(input);
  const result = encoding.encodeProgram(input, options);
  assert.deepEqual(result.program, { format: 'indexed-v1', commands: [{ type: 'wait', duration: 1 }], order: '0000' });
  assert.equal(result.expandedCount, 2);
  assert.equal(result.uniqueCount, 1);
  assert.equal(result.requestedHoldSeconds, 2);
  assert.equal(result.wireBytes, Buffer.byteLength(result.payload));
  assert.deepEqual(JSON.parse(result.payload), { program: result.program, timestamp: options.timestamp, run_id: options.runId });
  assert.deepEqual(input, snapshot);
});
