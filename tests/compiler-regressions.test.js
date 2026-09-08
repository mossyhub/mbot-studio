// Run: node --test tests/compiler-regressions.test.js (requires python3).
// Real generator, CPython parse/compile, whitelisted pure expressions only.
// No generated hardware calls, server, MQTT, firmware or robot execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { blocksToMicroPython } from '../server/src/services/code-generator.js';

const helper = fileURLToPath(new URL('./helpers/compiler-python.py', import.meta.url));
test('catalog: every editor default generates a compilable Python artifact', () => {
  // Read the actual declarative catalog, as in the original compiler audit.
  const editor = readFileSync(new URL('../web/src/components/BlocklyEditor.jsx', import.meta.url), 'utf8');
  const source = editor.slice(editor.indexOf('const NUM ='), editor.indexOf('const CATEGORIES ='));
  assert.ok(source.startsWith('const NUM ='));
  const context = vm.createContext({});
  vm.runInContext(source + '\nthis.definitions = BLOCK_DEFS;', context, { timeout: 1000 });
  const definitions = Object.entries(context.definitions);
  assert.equal(definitions.length, 73, 'review this sweep when the catalog changes');
  const cases = definitions.map(([type, definition]) => {
    const block = { type };
    for (const slot of definition.slots || []) block[slot.key] = slot.default ?? null;
    for (const mouth of definition.mouths || []) block[mouth.key] = [];
    return { blocks: ['reporter', 'predicate'].includes(definition.shape)
      ? [{ type: 'set_variable', name: 'catalog_result', value: block }] : [block] };
  });
  assert.equal(check(cases).filter(r => r.compiled).length, definitions.length);
});
test('Python helper rejects hardware expressions instead of executing them', () => {
  assert.throws(() => check([{ assignments: true, blocks: [
    { type: 'set_variable', name: 'answer', value: { type: 'sensor_distance' } },
  ] }]), /Unsafe attribute/);
  assert.throws(() => check([{ assignments: true, blocks: [{ type: 'wait', duration: 0 }] }]),
    /Only isolated assignments may execute/);
});
function check(cases) {
  const result = spawnSync('python3', [helper], {
    input: JSON.stringify(cases.map(({ blocks, config, ...options }) => ({
      source: blocksToMicroPython(blocks, config), ...options,
    }))), encoding: 'utf8', timeout: 10000,
  });
  assert.ifError(result.error); // python3 is an explicit dev prerequisite, never silently skipped.
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
const servoCall = 'mbot2.starter_shield.servo_set_angle';
const displayCall = 'cyberpi.display.show_label';
const addition = { type: 'op_add', a: 10, b: 20 };
test('C3: servo angle evaluates numeric and variable reporter operands', () => {
  const angles = [addition, { type: 'op_mul', a: addition, b: 2 }, { type: 'var_get', name: 'angle' }, 'angle', '30'];
  const results = check(angles.map(angle => ({
    blocks: [{ type: 'servo', port: 'S2', angle }], call: servoCall, indices: [0, 1], scope: { angle: 45 },
  })));
  assert.deepEqual(results.map(r => r.args), [[[2, 30]], [[2, 60]], [[2, 45]], [[2, 45]], [[2, 30]]]);
  // Slow-servo source compiles too; its hardware-dependent loop is never run.
  check([{ blocks: [{ type: 'servo', port: 'S1', angle: addition, speed: 50 }] }]);
});
function counter(angle, initial = 90, samples = []) {
  const [result] = check([{ slowServo: true, initial, samples,
    blocks: [{ type: 'servo', port: 'S1', angle, speed: 50 }],
  }]);
  assert.doesNotMatch(result.counter.pureSource, /mbot2|cyberpi|mbuild|time\.sleep|__import__/);
  return result.counter;
}
test('C3 slow servo: dynamic reporter is sampled once and the generated counter terminates', () => {
  const result = counter({ type: 'op_random', min: 30, max: 31 }, 90, [30, 31]);
  assert.deepEqual({ terminated: result.terminated, samples: result.sampleCount,
    current: result.current, steps: result.iterations },
  { terminated: true, samples: 1, current: 30, steps: 60 });
  assert.deepEqual(result.angles, Array.from({ length: 60 }, (_, i) => 89 - i));
});
test('C3 slow servo: fractional reporter target truncates to a reachable integer degree', () => {
  for (const initial of [0, 90]) {
    const result = counter({ type: 'op_div', a: 61, b: 2 }, initial);
    assert.deepEqual({ terminated: result.terminated, current: result.current, steps: result.iterations },
      { terminated: true, current: 30, steps: Math.abs(initial - 30) });
    assert.equal(result.angles.at(-1), 30);
    assert.ok(result.angles.every(Number.isInteger));
  }
});
for (const [label, initial, target] of [
  ['upward', 30, 120], ['downward to zero', 90, 0], ['upper boundary', 0, 180],
]) {
  test(`C3 slow servo: ${label} generated steps reach the target without overshoot`, () => {
    const result = counter(target, initial);
    const count = Math.abs(target - initial);
    const direction = target > initial ? 1 : -1;
    assert.equal(result.terminated, true);
    assert.equal(result.current, target);
    assert.equal(result.iterations, count);
    assert.deepEqual(result.angles, Array.from({ length: count }, (_, i) => initial + (i + 1) * direction));
  });
}
test('C3 slow servo: already at the sampled target emits no steps', () => {
  const result = counter({ type: 'op_random', min: 30, max: 31 }, 30, [30, 31]);
  assert.deepEqual({ terminated: result.terminated, current: result.current,
    samples: result.sampleCount, steps: result.iterations, angles: result.angles },
  { terminated: true, current: 30, samples: 1, steps: 0, angles: [] });
});
test('C3 slow servo: existing invalid-read fallback and fractional current normalization are preserved', () => {
  for (const initial of [null, -1, 181, 90.9]) {
    const result = counter(92, initial);
    assert.equal(result.terminated, true);
    assert.deepEqual(result.angles, [91, 92]);
  }
});
test('C3 no-speed servo: direct dynamic and fractional reporter expressions are unchanged', () => {
  const random = { type: 'op_random', min: 30, max: 31 };
  for (const speed of [undefined, 0]) {
    const source = blocksToMicroPython([{ type: 'servo', angle: random, speed }]);
    const body = source.split('# --- Program Start ---\n')[1].split('\n# Program complete')[0].trim();
    assert.equal(body, `${servoCall}(1, __import__('random').randint(30, 31))`);
    const [result] = check([{ blocks: [{ type: 'servo', speed, angle: { type: 'op_div', a: 61, b: 2 } }],
      call: servoCall, indices: [1] }]);
    assert.deepEqual(result.args, [[30.5]]);
    check([{ blocks: [{ type: 'servo', angle: random, speed }] }]);
  }
});
test('Python counter helper rejects retained hardware expressions and unapproved statements', () => {
  assert.throws(() => counter({ type: 'sensor_distance' }), /Forbidden counter call|Forbidden hardware attribute/);
  assert.throws(() => check([{ slowServo: true, initial: 90,
    blocks: [{ type: 'if_predicate', cond: false, then: [{ type: 'move_forward' }] }],
  }]), /Forbidden hardware statement/);
});
test('C3: display size evaluates nested numeric reporters', () => {
  const sizes = [addition, { type: 'op_mul', a: addition, b: 2 }, { type: 'var_get', name: 'size' }, 'size', undefined];
  const results = check(sizes.map(size => ({
    blocks: [{ type: 'display_text', text: 'Hello!', size }], call: displayCall, indices: [0, 1], scope: { size: 24 },
  })));
  assert.deepEqual(results.map(r => r.args), [[['Hello!', 30]], [['Hello!', 60]], [['Hello!', 24]], [['Hello!', 24]], [['Hello!', 16]]]);
});
test('C3: display text evaluates string reporters and explicit variables, not object debug strings', () => {
  const texts = [
    { type: 'op_join', a: 'apple ', b: 'banana' },
    { type: 'op_join', a: { type: 'var_get', name: 'word' }, b: '!' },
    { type: 'var_get', name: 'word' }, addition, 'word', '', 0, undefined, 'quote" slash\\\n',
  ];
  const results = check(texts.map(text => ({
    blocks: [{ type: 'display_text', text, size: 16 }], call: displayCall, indices: [0], scope: { word: 'fruit' },
  })));
  assert.deepEqual(results.map(r => r.args), [[['apple banana']], [['fruit!']], [['fruit']], [['30']], [['word']], [['']], [['0']], [['Hello!']], [['quote" slash\\\n']]]);
});
for (const kind of ['reporter', 'legacy']) {
  test(`C5: ${kind} floor rounds down for negatives and preserves integer boundaries`, () => {
    const samples = [-1.2, -0.2, -2, 0, 1.2, 2, '-1.2'];
    const results = check(samples.map(a => ({ assignments: true, blocks: [kind === 'reporter'
      ? { type: 'set_variable', name: 'answer', value: { type: 'op_function', fn: 'floor', a } }
      : { type: 'math_function', result: 'answer', fn: 'floor', a }],
    })));
    assert.deepEqual(results.map(r => r.values.answer), [-2, -1, -2, 0, 1, 2, -2]);
  });
}
test('C5: floor accepts nested numeric reporters', () => {
  const [result] = check([{ assignments: true, blocks: [
    { type: 'set_variable', name: 'answer', value: { type: 'op_function', fn: 'floor', a: { type: 'op_div', a: -6, b: 5 } } },
  ] }]);
  assert.equal(result.values.answer, -2);
});
const assign = (name, value) => ({ type: 'set_variable', name, value });
const variable = name => ({ type: 'var_get', name });
const stringCases = [
  ['length', { type: 'op_length', a: 'apple' }, 5, { type: 'op_length', a: variable('apple') }, 3],
  ['join', { type: 'op_join', a: 'apple ', b: 'banana' }, 'apple banana', { type: 'op_join', a: variable('apple'), b: variable('banana') }, '123456'],
  ['letter', { type: 'op_letter', n: 2, a: 'apple' }, 'p', { type: 'op_letter', n: 2, a: variable('apple') }, '2'],
  ['contains', { type: 'op_contains', a: 'apple', b: 'p' }, true, { type: 'op_contains', a: variable('apple'), b: variable('p') }, false],
];
for (const [name, literal, expectedLiteral, reference, expectedReference] of stringCases) {
  test(`C4: ${name} distinguishes literal STR operands from explicit var_get`, () => {
    const [result] = check([{ assignments: true, blocks: [
      assign('apple', 123), assign('banana', 456), assign('p', 9),
      assign('literal_result', literal), assign('variable_result', reference),
    ] }]);
    assert.equal(result.values.literal_result, expectedLiteral);
    assert.equal(result.values.variable_result, expectedReference);
  });
}
test('C4: nested STR reporters preserve escaped, empty and numeric-looking literals', () => {
  const text = 'quote" slash\\ newline\nreturn\r☃';
  const expressions = [
    { type: 'op_join', a: text, b: '' },
    { type: 'op_join', a: '001', b: 'True' },
    { type: 'op_length', a: '' },
    { type: 'op_length' },
    { type: 'op_join', a: { type: 'op_letter', n: 1, a: 'apple' }, b: { type: 'op_join', a: 'b', b: 'c' } },
    { type: 'op_letter', n: 0, a: 'apple' },
    { type: 'op_letter', n: 20, a: 'apple' },
  ];
  const results = check(expressions.map(expr => ({ assignments: true, blocks: [assign('answer', expr)] })));
  assert.deepEqual(results.map(r => r.values.answer), [text, '001True', 0, 0, 'abc', '', '']);
});
test('C4 compatibility: primitive identifiers in numeric slots and legacy operands remain variables', () => {
  const [result] = check([{ assignments: true, blocks: [assign('apple', 123),
    assign('answer', { type: 'op_add', a: 'apple', b: 2 }),
    { type: 'math_operation', result: 'legacy', operator: '+', a: 'apple', b: 2 },
    { type: 'string_length', result: 'legacy_text', a: 'apple' },
  ] }]);
  assert.equal(result.values.answer, 125);
  assert.equal(result.values.legacy, 125);
  assert.equal(result.values.legacy_text, 3);
});
const positionConfig = { additions: [{ type: 'dc_motor', port: 'M3', homeState: 'home', actions: [
  { targetState: 'out', duration: 2, speed: 40 },
  { targetState: 'home', duration: 3, speed: 40, motorDirection: 'reverse' },
] }] };
const suiteTypes = ['repeat', 'repeat_forever', 'repeat_until', 'while_block', 'while_sensor',
  'if_obstacle', 'if_line', 'if_color', 'if_predicate', 'if_else_predicate', 'if_button', 'if_sensor_range'];
function suite(type, children) {
  return { type, times: 2, cond: true, do: children, then: children, else: children };
}
for (const type of suiteTypes) {
  test(`C2: ${type} compiles comment-only, empty, mixed and nested suites`, () => {
    const melody = { type: 'play_melody', melody: 'birthday' };
    const leaves = [
      [melody],
      [{ type: 'dc_motor_position', port: 'M3', position: 0 }],
      [{ type: 'dc_motor_position', port: 'M4', position: 0 }],
      [{ type: 'unrecognized_test_block' }],
      [],
      [melody, { type: 'wait', duration: 0 }],
      [suite('repeat', [melody])],
    ];
    const results = check(leaves.map(children => ({ blocks: [suite(type, children)], config: positionConfig })));
    assert.ok(results.slice(0, 5).every(r => r.compiled && r.passCount > 0));
    assert.equal(results[5].passCount, 0, 'executable mixed suite needs no pass');
    assert.ok(results[6].passCount > 0, 'nested comment-only suite receives pass');
  });
}

test('B2 compiler: servo zero is preserved; only absent angles default to 90', () => {
  const angles = [0, 90, 180, undefined, null];
  const results = check(angles.map(angle => ({
    blocks: [{ type: 'servo', port: 'S1', angle }], call: servoCall, indices: [0, 1],
  })));
  assert.deepEqual(results.map(r => r.args), [[[1, 0]], [[1, 90]], [[1, 180]], [[1, 90]], [[1, 90]]]);
});
