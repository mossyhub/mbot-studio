// Host-only catalog checks: evaluate declarative data, never hardware code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { MqttService } from '../server/src/services/mqtt-service.js';
import * as capabilities from '../web/src/services/program-capabilities.js';

const source = readFileSync(new URL('../web/src/components/BlocklyEditor.jsx', import.meta.url), 'utf8');
const catalogSource = source.slice(source.indexOf('const NUM ='), source.indexOf('const CATEGORIES ='));
const catalog = vm.runInNewContext(`${catalogSource}\nJSON.parse(JSON.stringify(BLOCK_DEFS));`, {}, { timeout: 1000 });
const plain = value => JSON.parse(JSON.stringify(value));
const av = { build: 'mbot-av-control-v1', capabilities: ['turn_left', 'servo', 'play_sound'] };
const flatTypes = ['move_forward', 'move_backward', 'turn_left', 'turn_right', 'stop',
  'set_volume', 'stop_sound', 'play_tone', 'play_sound', 'display_animation', 'display_text',
  'set_led', 'wait', 'dc_motor', 'servo'];

const lowerableTypes = ['say', 'repeat', 'set_variable', 'change_variable', 'var_get',
  'if_predicate', 'if_else_predicate', 'op_add', 'op_sub', 'op_mul', 'op_div', 'op_mod',
  'op_round', 'op_abs', 'op_function', 'op_join', 'op_letter', 'op_length',
  'op_gt', 'op_lt', 'op_eq', 'op_and', 'op_or', 'op_not', 'op_contains'];

test('every available AV palette default and finite slot variant passes real server admission without publishing', () => {
  const service = new MqttService(); // No connect, sendCommand or sendProgram.
  service.robotStatusMetadata = { ...av, capabilities: flatTypes, application: 'cooperative-v1', motion_enabled: true, armed: true };
  service.robotLastSeen = service.robotStatusLastSeen = Date.now();
  const rows = capabilities.getProgramPalette(catalog, service.robotStatusMetadata);
  assert.equal(rows.length, 15);
  for (const { type, definition } of rows) {
    const block = { type, _id: 'catalog-test' };
    for (const slot of definition.slots || []) {
      if (slot.default !== undefined && slot.default !== null) block[slot.key] = plain(slot.default);
    }
    assert.doesNotThrow(() => service.validateCooperativeProgram([block]), type);
    for (const slot of definition.slots || []) {
      const variants = slot.options || [slot.min, slot.max].filter(value => value !== undefined);
      for (const value of variants) {
        assert.doesNotThrow(() => service.validateCooperativeProgram([{ ...block, [slot.key]: value }]), `${type}.${slot.key}=${value}`);
      }
    }
  }
  assert.throws(() => service.validateCooperativeProgram([{ type: 'turn_left', speed: 50, angle: 90 }]), /Unknown|angle/);
  assert.throws(() => service.validateCooperativeProgram([{ type: 'servo', port: 'S1', speed: 1 }]), /speed/);
  assert.throws(() => service.validateCooperativeProgram([{ type: 'play_tone', duration: 2.1 }]), /duration/);
  assert.throws(() => service.validateCooperativeProgram([{ type: 'display_text', text: 'hello', size: 33 }]), /size/);
  assert.equal(service.client, null, 'the test never opens a network connection');
});

test('palette filtering is non-destructive and unknown runtimes retain the full editor', () => {
  assert.equal(typeof capabilities.getProgramPalette, 'function');
  const { getProgramPalette } = capabilities;
  const original = plain(catalog);
  const runtime = { ...av, capabilities: flatTypes };
  const supported = getProgramPalette(catalog, runtime);
  assert.deepEqual(supported.map(row => row.type).sort(), [...flatTypes].sort());
  const all = getProgramPalette(catalog, runtime, { includeUnavailable: true });
  assert.equal(all.length, 66);
  assert.equal(all.find(row => row.type === 'sensor_distance').capability.status, 'requires-runtime');
  assert.equal(all.find(row => row.type === 'turn_left').definition.slots.length, 1);
  const lowered = getProgramPalette(catalog, runtime, { loweredTypes: ['repeat', 'op_add'] });
  assert.deepEqual(lowered.filter(row => row.capability.status === 'server-lowered').map(row => row.type).sort(), ['op_add', 'repeat']);
  assert.deepEqual(getProgramPalette(catalog, { ...av, capabilities: [] }), []);
  for (const status of [null, {}, { build: 'legacy' }, { build: 'mbot-motor-control-v1' }]) {
    const rows = getProgramPalette(catalog, status);
    assert.equal(rows.length, all.length);
    assert.strictEqual(rows.find(row => row.type === 'turn_left').definition, catalog.turn_left);
    assert.ok(rows.every(row => row.capability.status === 'unknown'));
  }
  assert.deepEqual(plain(catalog), original, 'palette filtering must not delete catalog definitions');
  assert.ok(catalog.if_obstacle.hidden, 'hidden legacy definitions are retained, not offered as new blocks');
});

test('inventory covers every catalog entry and gates lowering on the verified server subset', () => {
  assert.ok(capabilities.PROGRAM_BLOCK_INVENTORY, 'an explicit inventory is required');
  const inventory = capabilities.PROGRAM_BLOCK_INVENTORY;
  assert.deepEqual(Object.keys(inventory).sort(), Object.keys(catalog).sort());
  assert.equal(Object.keys(inventory).length, 73);
  for (const [type, entry] of Object.entries(inventory)) {
    const expected = flatTypes.includes(type) ? 'flat'
      : lowerableTypes.includes(type) ? 'server-lowered' : 'requires-runtime';
    assert.equal(entry.mode, expected, type);
    assert.ok(entry.reason.length > 15, type);
    const result = capabilities.getProgramBlockCapability(type, { ...av, capabilities: flatTypes }, { loweredTypes: lowerableTypes });
    assert.equal(result.supported, expected !== 'requires-runtime', type);
    assert.equal(result.status, expected === 'flat' ? 'supported' : expected, type);
  }
  for (const type of lowerableTypes) {
    assert.equal(capabilities.getProgramBlockCapability(type, av).supported, false, type);
    assert.match(capabilities.getProgramBlockCapability(type, av).reason, /server.*lower/i);
    assert.equal(capabilities.getProgramBlockCapability(type, av, { loweredTypes: [type] }).status, 'server-lowered');
    assert.equal(capabilities.getProgramBlockCapability(type, av, { loweredTypes: 'repeat' }).supported, false);
  }
  for (const type of ['sensor_distance', 'sensor_timer', 'sensor_battery', 'sensor_button_pressed']) {
    assert.match(inventory[type].reason, /live|snapshot|runtime/i);
  }
  for (const type of ['sensor_distance', 'repeat_forever', 'while_block', 'op_random', 'read_sensors']) {
    assert.equal(capabilities.getProgramBlockCapability(type, av, { loweredTypes: [type] }).supported, false, type);
  }
});

test('AV support requires an advertised flat Program command, not merely a capability string', () => {
  assert.equal(typeof capabilities.getProgramBlockCapability, 'function');
  const { getProgramBlockCapability } = capabilities;
  for (const type of flatTypes) {
    const result = getProgramBlockCapability(type, { ...av, capabilities: flatTypes });
    assert.equal(result.status, 'supported', type);
    assert.equal(result.supported, true, type);
    assert.ok(result.reason.length > 15, type);
    for (const advertised of [[], undefined, 'move_forward', null]) {
      const unavailable = getProgramBlockCapability(type, { ...av, capabilities: advertised });
      assert.equal(unavailable.status, 'requires-runtime', type);
      assert.equal(unavailable.supported, false, type);
      assert.match(unavailable.reason, /advertis/i);
    }
  }
  for (const type of ['read_sensors', 'status']) {
    const result = getProgramBlockCapability(type, { ...av, capabilities: [type] });
    assert.equal(result.status, 'requires-runtime');
    assert.match(result.reason, /command.only|not.*Program/i);
  }
  for (const type of ['future_block', 'toString', '__proto__', 'sensor_distance', 'repeat_forever']) {
    assert.equal(getProgramBlockCapability(type, { ...av, capabilities: [type] }).supported, false, type);
  }
  for (const runtime of [undefined, null, {}, { build: 'legacy', capabilities: flatTypes }]) {
    const result = getProgramBlockCapability('move_forward', runtime);
    assert.equal(result.status, 'unknown');
    assert.equal(result.supported, false, 'unknown must not claim execution support');
  }
});

test('runtime definition overlays are pure and leave unknown and legacy definitions intact', () => {
  assert.equal(typeof capabilities.getProgramBlockDefinition, 'function');
  const { getProgramBlockDefinition } = capabilities;
  const original = plain(catalog);
  const turn = getProgramBlockDefinition('turn_left', catalog.turn_left, av);
  assert.deepEqual(plain(turn.slots.map(slot => slot.key)), ['angle']);
  assert.deepEqual(plain(turn.slots[0]), {
    key: 'angle', kind: 'number', control: 'number', min: 0, max: 30, step: 1, default: 30, label: 'native angle',
  });
  assert.equal(getProgramBlockDefinition('servo', catalog.servo, av).slots.at(-1).default, 0);
  assert.equal(getProgramBlockDefinition('stop', catalog.stop, av).shape, 'stack');
  for (const runtime of [undefined, null, {}, { build: 'legacy' }, { build: 'mbot-av-control-v10' }]) {
    assert.strictEqual(getProgramBlockDefinition('turn_left', catalog.turn_left, runtime), catalog.turn_left);
    assert.strictEqual(getProgramBlockDefinition('play_sound', catalog.play_sound, runtime), catalog.play_sound);
  }
  assert.equal(getProgramBlockDefinition('future', undefined, av), undefined);
  assert.deepEqual(plain(catalog), original);
});

test('AV literal slot overrides match installed motor, servo, audio and text bounds', () => {
  for (const type of ['move_forward', 'move_backward', 'dc_motor']) {
    assert.ok(catalog[type].av, `${type} requires installed bounds`);
    assert.equal(catalog[type].av.slots.speed.max, 50);
    assert.equal(catalog[type].av.slots.speed.min, type === 'dc_motor' ? -50 : 0);
    assert.equal(catalog[type].av.slots.duration.min, 0);
    assert.equal(catalog[type].av.slots.duration.max, 5);
  }
  assert.deepEqual(plain(catalog.servo.av.slots.speed), {
    key: 'speed', kind: 'number', control: 'number', min: 0, max: 0, step: 1, default: 0, label: 'native speed',
  });
  assert.equal(catalog.play_tone.av.slots.duration.min, 0);
  assert.equal(catalog.play_tone.av.slots.duration.max, 2);
  assert.equal(catalog.display_text.av.slots.size.max, 32);
  assert.equal(catalog.display_text.av.slots.text.maxCodePoints, 128);
  assert.deepEqual(plain(catalog.play_sound.av.slots.sound.options), ['hello', 'beeps', 'laugh', 'score']);
  assert.equal(catalog.stop.av.shape, 'stack', 'in-program stop continues, unlike emergency Stop');
});

test('AV turn catalog overrides remove unsupported speed and bound native angle', () => {
  for (const type of ['turn_left', 'turn_right']) {
    assert.ok(catalog[type].av, `${type} requires an AV-specific definition`);
    assert.equal(catalog[type].av.slots.speed, null);
    assert.deepEqual(plain(catalog[type].av.slots.angle), {
      min: 0, max: 30, default: 30, label: 'native angle',
    });
    // Do not narrow the legacy definition or lose imported 90-degree turns.
    assert.equal(catalog[type].slots.find(slot => slot.key === 'angle').max, 360);
  }
});
