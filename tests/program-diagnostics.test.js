import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lowerProgram } from '../server/src/services/program-lowering.js';

test('unfilled predicate sockets identify the required condition and its source', () => {
  for (const type of ['if_predicate', 'if_else_predicate']) {
    for (const missing of [undefined, null]) {
      const block = { type, _id: 'condition-block', then: [], ...(missing === null ? { cond: null } : {}) };
      assert.throws(() => lowerProgram([block]), error =>
        /condition is required/i.test(error.message) && error.sourceId === 'condition-block' && error.path === 'program[0].cond');
    }
  }
  for (const type of ['op_and', 'op_or', 'op_not']) {
    const cond = { type, _id: 'predicate' };
    assert.throws(() => lowerProgram([{ type: 'if_predicate', cond, then: [] }]), error =>
      /condition is required/i.test(error.message) && error.sourceId === 'predicate' && error.path === 'program[0].cond.a');
  }
  assert.equal(lowerProgram([{ type: 'if_predicate', cond: false, then: [], else: [{ type: 'wait', duration: 0 }] }]).compiledCount, 1);
  assert.throws(() => lowerProgram([{ type: 'if_predicate', cond: 0, then: [] }]), /condition must be boolean/);
});
