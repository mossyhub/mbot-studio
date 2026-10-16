import test from 'node:test';
import assert from 'node:assert/strict';
import { lowerProgram } from '../server/src/services/program-lowering.js';

const repeated = (times, block = { type: 'wait', duration: 0.1, _id: 'pause' }) => [{ type: 'repeat', times, do: [block] }];
test('indexed source work, source bytes, depth and instruction budgets stay independently bounded', () => {
  const options = { profile: 'indexed-v1' };
  assert.throws(() => lowerProgram([{ type: 'repeat', times: 5, do: [{ type: 'repeat', times: 1024, do: [] }] }], options), /4096 total iterations/);
  assert.throws(() => lowerProgram([{ type: 'repeat', times: 1024, do: Array.from({ length: 33 }, () => ({ type: 'set_variable', name: 'x', value: 1 })) }], options), /32768 evaluation/);
  assert.throws(() => lowerProgram(Array(257).fill({ type: 'stop' }), options), /256 source/);
  let deep = [{ type: 'stop' }];
  for (let i = 0; i < 8; i++) deep = [{ type: 'repeat', times: 0, do: deep }];
  assert.throws(() => lowerProgram(deep, options), /depth exceeds 8/);
  assert.throws(() => lowerProgram(Array(128).fill({ type: 'display_text', text: '😀'.repeat(128) }), options), /65536/);
  assert.throws(() => lowerProgram([...repeated(1024, { type: 'stop' }), { type: 'stop' }], options), /1024 expanded/);
});

test('indexed metadata bounds cover dead branches/reporters and escaped source-map response bytes', () => {
  const profile = 'indexed-v1';
  assert.equal(lowerProgram(repeated(1, { type: 'wait', duration: 0, _id: '😀'.repeat(32) }), { profile }).compiledCount, 1);
  for (const program of [
    repeated(1, { type: 'wait', duration: 0, _id: '😀'.repeat(33) }),
    [{ type: 'repeat', times: 0, _id: 'x'.repeat(129), do: [] }],
    [{ type: 'wait', duration: { type: 'op_add', a: 0, b: 0, _id: 'x'.repeat(129) } }],
  ]) assert.throws(() => lowerProgram(program, { profile }), /128.*UTF-8|UTF-8.*128/);
  assert.throws(() => lowerProgram(repeated(1024, { type: 'wait', duration: 0, _id: '\u0001'.repeat(128) }), { profile }), /source.map.*262144/i);
  assert.throws(() => lowerProgram(repeated(1), { profile: { encoding: 'indexed-v1', limits: { instructions: Infinity } } }), /profile/);
});

test('exact 120-second indexed source boundary is not rejected by floating point drift', () => {
  const result = lowerProgram(repeated(600, { type: 'wait', duration: 0.2 }), { profile: 'indexed-v1' });
  assert.equal(result.requestedHoldSeconds, 120);
});

test('indexed lowering admits 1024 steps with ordered source evidence; legacy remains 32', () => {
  const result = lowerProgram(repeated(1024), { profile: 'indexed-v1' });
  assert.equal(result.compiledCount, 1024);
  assert.equal(result.sourceMap.length, 1024);
  assert.deepEqual(result.sourceMap[1023], { sourceId: 'pause', path: 'program[0].do[0]', compiledIndex: 1023 });
  assert.throws(() => lowerProgram(repeated(33)), /32 expanded/);
  assert.throws(() => lowerProgram(repeated(1025), { profile: 'indexed-v1' }), /0\.\.1024/);
});
