// Pure compiler/CPython artifact checks. No hardware code is executed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { blocksToMicroPython } from '../server/src/services/code-generator.js';

const helper = fileURLToPath(new URL('./helpers/compiler-python.py', import.meta.url));
function inspect(blocks, options = {}) {
  const source = blocksToMicroPython(blocks);
  const result = spawnSync('python3', [helper], {
    input: JSON.stringify([{ source, ...options }]), encoding: 'utf8', timeout: 10000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return { source, ...JSON.parse(result.stdout)[0] };
}

test('AV volume and audio stop emit explicit native calls, including zero volume', () => {
  const blocks = [{ type: 'set_volume', volume: 0 }, { type: 'stop_sound' },
    { type: 'set_volume', volume: 60 }];
  const result = inspect(blocks, { call: 'cyberpi.audio.set_vol', indices: [0] });
  assert.deepEqual(result.args, [[0], [60]]);
  assert.match(result.source, /cyberpi\.audio\.set_vol\(0\)\ncyberpi\.audio\.stop\(\)\ncyberpi\.audio\.set_vol\(60\)/);
});

test('AV text animation emits literal frames at size 24 with a wait after every frame', () => {
  const frames = ['word', '001', '', 'quote" slash\\\n\r雪😀', '\u0000\b\f\t', '__import__("os").system("false")'];
  const blocks = [{ type: 'display_animation', frames, interval: 0.15 }];
  const labels = inspect(blocks, { call: 'cyberpi.display.show_label', indices: [0, 1, 2] });
  assert.deepEqual(labels.args, frames.map(frame => [frame, 24, 'center']));
  const sleeps = inspect(blocks, { call: 'time.sleep', indices: [0] });
  assert.deepEqual(sleeps.args, frames.map(() => [0.15]));
  for (const frame of frames) {
    assert.ok(labels.source.includes(`cyberpi.display.show_label(${JSON.stringify(frame)}, 24, "center", index=0)\ntime.sleep(0.15)`));
  }
  inspect([{ type: 'repeat', times: 2, do: blocks }]);
});

test('animation rejects strings and reporter objects instead of guessing a frame array', () => {
  for (const frames of ['a\nb', '["a","b"]', null, undefined, [42], [{ type: 'var_get', name: 'text' }]]) {
    assert.throws(() => blocksToMicroPython([{ type: 'display_animation', frames }]), /frames must be an array of strings/);
  }
  const result = inspect([{ type: 'display_animation', frames: [''] }], { call: 'time.sleep', indices: [0] });
  assert.deepEqual(result.args, [[0.5]]);
});

test('AV catalog defaults compile alongside all unchanged legacy block defaults', () => {
  const editor = readFileSync(new URL('../web/src/components/BlocklyEditor.jsx', import.meta.url), 'utf8');
  const source = editor.slice(editor.indexOf('const NUM ='), editor.indexOf('const CATEGORIES ='));
  const context = vm.createContext({});
  vm.runInContext(source + '\nthis.definitions = BLOCK_DEFS;', context, { timeout: 1000 });
  const definitions = context.definitions;
  const newTypes = ['set_volume', 'stop_sound', 'display_animation'];
  assert.equal(Object.keys(definitions).filter(type => !newTypes.includes(type)).length, 70);
  assert.equal(definitions.play_tone.slots.find(slot => slot.key === 'duration').max, 5);
  assert.ok(definitions.play_sound.slots[0].options.includes('magic'), 'legacy options remain available');
  assert.ok(Array.isArray(definitions.display_animation.slots[0].default));
  const cases = Object.entries(definitions).map(([type, definition]) => {
    const block = { type };
    for (const slot of definition.slots || []) block[slot.key] = slot.default ?? null;
    for (const mouth of definition.mouths || []) block[mouth.key] = [];
    const blocks = ['reporter', 'predicate'].includes(definition.shape)
      ? [{ type: 'set_variable', name: 'catalog_result', value: block }] : [block];
    return { source: blocksToMicroPython(blocks) };
  });
  const result = spawnSync('python3', [helper], { input: JSON.stringify(cases), encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).filter(item => item.compiled).length, 73);
});
