// Host-only: compile actual preview source and execute with inert hardware stubs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { blocksToMicroPython } from '../server/src/services/code-generator.js';

function run(blocks) {
  const source = blocksToMicroPython(blocks);
  const result = spawnSync('python3', ['-c', `
import json, sys, types
source = json.load(sys.stdin)
compiled = compile(source, '<preview>', 'exec')
calls = []
def record(name):
    return lambda *args, **kwargs: calls.append([name, list(args)])
for name in ('cyberpi', 'mbot2', 'mbuild', 'time'):
    sys.modules[name] = types.ModuleType(name)
sys.modules['cyberpi'].display = types.SimpleNamespace(show_label=record('display'))
sys.modules['cyberpi'].audio = types.SimpleNamespace(stop=record('audio.stop'))
for name in ('motor_stop', 'EM_stop', 'forward', 'backward'):
    setattr(sys.modules['mbot2'], name, record(name))
sys.modules['time'].sleep = record('sleep')
exited = False
try:
    exec(compiled, {})
except SystemExit:
    exited = True
print(json.dumps({'calls': calls, 'exited': exited}))
`], { input: JSON.stringify(source), encoding: 'utf8', timeout: 3000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('variable names cannot shadow Python keywords, modules or compiler helpers', () => {
  const names = ['class', 'True', 'None', 'async', 'cyberpi', 'mbot2', 'mbuild', 'time',
    'sys', 'str', 'int', 'range', 'bool', 'len', 'abs', 'round', '__import__', '_i', '_s',
    '_sv_target', '_random', '_user_class'];
  const blocks = names.flatMap((name, index) => [
    { type: 'set_variable', name, value: index },
    { type: 'change_variable', name, by: 1 },
    { type: 'display_text', text: { type: 'var_get', name } },
  ]);
  blocks.push({ type: 'wait', duration: 0 }, { type: 'repeat', times: 1, do: [] });
  const result = run(blocks);
  assert.deepEqual(result.calls.filter(([name]) => name === 'display').slice(1, -1).map(([, args]) => args[0]),
    names.map((_, index) => String(index + 1)));
});

test('stop this script compiles and terminates top-level and nested programs', () => {
  for (const stop of [
    { type: 'stop_all', what: 'this script' },
    { type: 'repeat', times: 2, do: [
      { type: 'if_predicate', cond: true, then: [{ type: 'stop_all', what: 'this script' }] },
      { type: 'display_text', text: 'unreachable nested' },
    ] },
  ]) {
    const result = run([stop, { type: 'display_text', text: 'unreachable' }]);
    assert.equal(result.exited, true);
    assert.deepEqual(result.calls, [['display', ['Running...', 16, 'center']]]);
  }
});

test('independent or dynamic wheel speeds fail explicitly instead of averaging', () => {
  for (const [left, right] of [[50, -50], [20, 40], [{ type: 'var_get', name: 'speed' }, 50],
    ['speed', 'speed'], [NaN, NaN], [Infinity, Infinity]]) {
    assert.throws(() => blocksToMicroPython([{ type: 'set_speed', left, right }]),
      /set_speed.*unsupported.*equal finite literal/i);
  }
  for (const [speed, expected] of [[50, 'forward'], [-30, 'backward'], [0, 'EM_stop']]) {
    const result = run([{ type: 'set_speed', left: speed, right: speed }]);
    assert.deepEqual(result.calls[1], [expected, speed ? [Math.abs(speed)] : []]);
  }
});

test('NUL text compiles and retains exact text in Python', () => {
  const text = 'before\0after "\\\n\r\t雪😀';
  const result = run([{ type: 'display_text', text }, { type: 'say', text }]);
  assert.deepEqual(result.calls.filter(([name]) => name === 'display').map(([, args]) => args[0]),
    ['Running...', text, text, 'Done! ✓']);
});
