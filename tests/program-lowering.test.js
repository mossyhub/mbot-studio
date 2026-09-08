// Pure lowering and real admission; never connect to MQTT or robot hardware.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Dynamic import lets the first RED assert the missing feature, not a loader error.
let lowerProgram;
try { ({ lowerProgram } = await import('../server/src/services/program-lowering.js')); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

test('literal repeat expands in order and maps each instruction to its editor source', () => {
  assert.equal(typeof lowerProgram, 'function', 'bounded lowering must exist');
  const input = [{ type: 'repeat', _id: 'loop', times: 2, do: [
    { type: 'wait', _id: 'pause', duration: 0.1 }, { type: 'stop', _id: 'stop' },
  ] }];
  const original = structuredClone(input);
  const result = lowerProgram(input);
  assert.deepEqual(result.program, [...input[0].do, ...input[0].do]);
  assert.equal(result.compiledCount, 4);
  assert.deepEqual(result.sourceMap.map(item => item.sourceId), ['pause', 'stop', 'pause', 'stop']);
  assert.equal(result.sourceMap[2].path, 'program[0].do[0]');
  assert.deepEqual(input, original);
});

test('repeat compilation is bounded and rejects the whole invalid tree with source diagnostics', () => {
  const reject = (input, pattern) => assert.throws(() => lowerProgram(input), pattern);
  for (const times of [-1, 1.5, '2', 51, Infinity]) {
    reject([{ type: 'repeat', _id: 'bad-loop', times, do: [] }], /repeat times/);
  }
  reject([{ type: 'repeat', times: 33, do: [{ type: 'wait', duration: 0 }] }], /32/);
  reject([{ type: 'repeat', times: 50, do: [{ type: 'repeat', times: 50, do: [] }] }], /iteration/);
  reject(Array.from({ length: 257 }, () => ({ type: 'repeat', times: 0, do: [] })), /256/);
  let nested = [{ type: 'wait' }];
  for (let i = 0; i < 9; i++) nested = [{ type: 'repeat', times: 0, do: nested }];
  reject(nested, /depth/);
  for (const block of [
    { type: 'repeat_forever', do: [] },
    { type: 'wait', duration: { type: 'sensor_distance' } },
    { type: 'turn_left', angle: 10, speed: 20 },
    { type: 'repeat', times: 0, do: [], speed: 50 },
  ]) {
    assert.throws(() => lowerProgram([{ type: 'repeat', times: 0, do: [{ ...block, _id: 'hidden' }] }]),
      error => error.sourceId === 'hidden' && error.path.startsWith('program[0].do[0]'));
  }
  reject([{ type: 'stop', _id: 12 }], /_id/);
  reject([{ type: 'wait', params: { duration: 1 }, speed: 50 }], /parameter/);
  reject(null, /array/);
});

test('pure numeric reporters fold without coercion or JavaScript rounding/modulo semantics', () => {
  const op = (type, a, b) => ({ type, a, ...(b === undefined ? {} : { b }) });
  const cases = [
    [op('op_add', 1, op('op_mul', 2, 3)), 7], [op('op_sub', 4, 1), 3],
    [op('op_div', 7, 2), 3.5], [op('op_mod', -5, 3), 1], [op('op_mod', 5, -3), -1],
    [op('op_round', 2.5), 2], [op('op_round', 3.5), 4], [op('op_round', -2.5), -2],
    [op('op_abs', -2), 2],
  ];
  for (const [reporter, expected] of cases) {
    assert.equal(lowerProgram([{ type: 'wait', duration: reporter }]).program[0].duration, expected);
  }
  for (const value of [op('op_div', 1, 0), op('op_mod', 1, 0), op('op_add', '1', 2),
    op('op_mul', Number.MAX_SAFE_INTEGER, 2), op('op_add', true, 1),
    { type: 'op_random', min: 1, max: 2 }, { type: 'op_abs', a: 1, hidden: { type: 'sensor_distance' } }]) {
    assert.throws(() => lowerProgram([{ type: 'wait', duration: value }]));
  }
  const reporter = op('op_div', 1, 0); reporter._id = 'division';
  assert.throws(() => lowerProgram([{ type: 'wait', _id: 'pause', duration: reporter }]),
    error => error.sourceId === 'division' && error.path === 'program[0].duration');
});

test('initialized static variables flow through finite loops and only the selected branch changes state', () => {
  const variable = { type: 'var_get', name: 'x' };
  const program = [
    { type: 'set_variable', name: 'x', source: 'number', value: 0 },
    { type: 'repeat', times: 3, do: [
      { type: 'change_variable', name: 'x', by: 1 },
      { type: 'if_else_predicate', cond: { type: 'op_and',
        a: { type: 'op_gt', a: variable, b: 1 }, b: { type: 'op_not', a: false } },
        then: [{ type: 'wait', _id: 'yes', duration: variable }],
        else: [{ type: 'wait', _id: 'no', duration: 0 }] },
    ] },
    { type: 'if_predicate', cond: { type: 'op_eq', a: variable, b: 3 },
      then: [{ type: 'change_variable', name: 'x', by: 1 }],
      else: [{ type: 'change_variable', name: 'x', by: 50 }] },
    { type: 'wait', duration: variable },
  ];
  assert.deepEqual(lowerProgram(program).program.map(block => block.duration), [0, 2, 3, 4]);
  for (const block of [
    { type: 'wait', duration: { type: 'var_get', name: 'undefined_x' } },
    { type: 'set_variable', name: 'x', value: 0, source: 'distance' },
    { type: 'set_variable', name: 'class', value: 0 },
    { type: 'change_variable', name: 'x', by: 1 },
    { type: 'if_predicate', cond: { type: 'op_or', a: true, b: { type: 'sensor_distance' } }, then: [] },
    { type: 'if_predicate', cond: true, then: [], else: [{ type: 'repeat_forever', do: [] }] },
  ]) assert.throws(() => lowerProgram([block]));
  assert.equal(lowerProgram([{ type: 'if_predicate', cond: { type: 'op_or', a: false, b: { type: 'op_lt', a: 1, b: 2 } },
    then: [{ type: 'stop' }] }]).compiledCount, 1);
});

test('animation expansion is counted and mapped without changing its native wire representation', () => {
  const animation = { type: 'display_animation', _id: 'frames', frames: ['one', 'two'], interval: 0.5 };
  const result = lowerProgram([{ type: 'repeat', times: 2, do: [animation, { type: 'stop' }] }]);
  assert.equal(result.program.length, 4);
  assert.equal(result.compiledCount, 10);
  assert.deepEqual(result.sourceMap.slice(0, 4).map(item => item.sourceId), Array(4).fill('frames'));
  assert.deepEqual(result.sourceMap.map(item => item.compiledIndex), Array.from({ length: 10 }, (_, i) => i));
  assert.deepEqual(result.program[0], animation);
  assert.throws(() => lowerProgram([{ type: 'repeat', times: 9, do: [animation] }]), /32/);
});

test('source size, evaluation work and requested holds have independent hard budgets', () => {
  assert.throws(() => lowerProgram([{ type: 'repeat', _id: 'x'.repeat(65536), times: 0, do: [] }]), /source.*65536/i);
  assert.throws(() => lowerProgram([
    { type: 'set_variable', name: 'x', value: 0 },
    { type: 'repeat', times: 50, do: Array.from({ length: 100 }, () => ({ type: 'change_variable', name: 'x', by: 1 })) },
  ]), /4096.*evaluation|evaluation.*4096/i);
  assert.throws(() => lowerProgram([{ type: 'repeat', times: 3, do: [{ type: 'wait', duration: 60 }] }]), /120/);
  assert.equal(lowerProgram([{ type: 'repeat', times: 2, do: [{ type: 'wait', duration: 60 }] }]).requestedHoldSeconds, 120);
  for (const frames of [undefined, null, [], Array(13).fill('x'), [[[[['x']]]]], [{ type: 'sensor_distance' }]]) {
    assert.throws(() => lowerProgram([{ type: 'display_animation', frames }]), /frames/);
  }
});

