// Pure, network-free companion to editor-parameter-repairs.mjs (real JSX).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { getProgramBlockDefinition } from '../web/src/services/program-capabilities.js';

const source = readFileSync(new URL('../web/src/components/BlocklyEditor.jsx', import.meta.url), 'utf8');
const catalog = vm.runInNewContext(`${source.slice(source.indexOf('const NUM ='), source.indexOf('const CATEGORIES ='))}\nJSON.parse(JSON.stringify(BLOCK_DEFS))`, {}, { timeout: 1000 });
const runtime = { build: 'mbot-av-control-v1', capabilities: [] };
const definition = (type, status = runtime) => getProgramBlockDefinition(type, catalog[type], status);

test('repeat overlays distinguish legacy and indexed contracts without modifying catalog defaults', () => {
  const before = JSON.stringify(catalog);
  for (const [status, max] of [[runtime, 50], [{ ...runtime, capabilities: ['program_indexed_v1'] }, 1024]]) {
    const slot = definition('repeat', status).slots[0];
    assert.equal(slot.min, 0);
    assert.equal(slot.max, max);
    assert.equal(slot.default, 3);
    assert.equal(slot.literalOnly, true);
  }
  assert.equal(definition('repeat', null).slots[0].max, 100);
  assert.equal(JSON.stringify(catalog), before);
});

test('effective omission defaults stay separate from new palette defaults and required values', () => {
  assert.equal(definition('move_forward').effectiveDefaults.speed, 20);
  assert.equal(definition('move_forward').slots.find(s => s.key === 'speed').default, 50);
  assert.equal(definition('turn_left').effectiveDefaults.angle, 0);
  assert.equal(definition('turn_left').slots[0].default, 30);
  for (const [type, key] of [['play_sound', 'sound'], ['set_led', 'color'], ['display_text', 'text'], ['servo', 'port']]) {
    assert(!Object.hasOwn(definition(type).effectiveDefaults, key));
  }
  assert.equal(definition('move_forward', null).effectiveDefaults, undefined);
});

test('literal-only AV fields and Unicode text limits match editor socket metadata', () => {
  for (const [type, key] of [['set_led', 'color'], ['servo', 'port'], ['set_variable', 'name'], ['display_text', 'text'], ['repeat', 'times']]) {
    assert.equal(definition(type).slots.find(s => s.key === key).literalOnly, true);
  }
  assert.notEqual(definition('wait').slots[0].literalOnly, true);
  for (const type of ['display_text', 'say']) assert.equal(definition(type).slots.find(s => s.key === 'text').maxCodePoints, 128);
  assert(definition('set_led').slots[0].options.includes('cyan'));
  assert(definition('set_led').slots[0].options.includes('orange'));
  assert(!definition('set_led', null).slots[0].options.includes('cyan'));
});
