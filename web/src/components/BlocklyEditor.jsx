import React, { useEffect, useMemo, useRef, useState } from 'react';
import './BlocklyEditor.css';

/**
 * Scratch-style block editor with reporter blocks (slot-based expressions).
 *
 *   ┌────────┬──────────────┬─────────────────────────────────┐
 *   │ Cats   │  Palette     │  Workspace                      │
 *   └────────┴──────────────┴─────────────────────────────────┘
 *
 * BLOCK SHAPES
 *   hat       — rounded top, notch bottom        (event/start)
 *   stack     — notch top + bump bottom          (action statement)
 *   c         — opens one mouth                  (loop)
 *   e         — opens two mouths (then/else)     (if/else)
 *   cap       — notched top, flat bottom         (terminator)
 *   reporter  — oval                             (number/string value)
 *   predicate — hexagon                          (boolean value)
 *
 * SLOT MODEL
 *   Stack & reporter blocks declare typed slots in `slots: [{ key, kind, ... }]`.
 *   A slot value can be:
 *     • a primitive   → rendered as a literal input (number / text / select / range)
 *     • a reporter    → rendered as a nested oval/hexagon block, dragable
 *   This lets kids write `move forward (X * 2)` or `if (distance < 10) and (button A pressed)`.
 *
 * IDENTITY
 *   Each block carries a stable `_id` (assigned on hydrate). All edit operations
 *   (move, delete, set-slot) work by id, so the operation is independent of the
 *   tree path. `_id` is preserved in the JSON program — code-generator and AI
 *   service both ignore unknown fields.
 *
 * BACKWARDS COMPAT
 *   Old programs (no _id, primitive-only slot values) hydrate cleanly. AI-emitted
 *   primitives continue to work unchanged.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Block catalog
// ─────────────────────────────────────────────────────────────────────────────

const NUM = 'number', STR = 'string', BOOL = 'boolean';

const BLOCK_DEFS = {
  // ── Movement (blue) ──
  move_forward: { cat: 'movement', shape: 'stack', icon: '⬆️', label: 'move forward',
    slots: [
      { key: 'speed', kind: NUM, control: 'range', min: 0, max: 100, step: 5, default: 50, label: 'speed' },
      { key: 'duration', kind: NUM, control: 'number', min: 0.1, max: 30, step: 0.1, default: 1, label: 'for sec' },
    ],
    format: (b) => `${fmt(b.speed)}% · ${fmt(b.duration)}s` },
  move_backward: { cat: 'movement', shape: 'stack', icon: '⬇️', label: 'move backward',
    slots: [
      { key: 'speed', kind: NUM, control: 'range', min: 0, max: 100, step: 5, default: 50, label: 'speed' },
      { key: 'duration', kind: NUM, control: 'number', min: 0.1, max: 30, step: 0.1, default: 1, label: 'for sec' },
    ],
    format: (b) => `${fmt(b.speed)}% · ${fmt(b.duration)}s` },
  turn_left: { cat: 'movement', shape: 'stack', icon: '↩️', label: 'turn left',
    slots: [
      { key: 'speed', kind: NUM, control: 'range', min: 0, max: 100, step: 5, default: 50, label: 'speed' },
      { key: 'angle', kind: NUM, control: 'number', min: 1, max: 360, step: 1, default: 90, label: 'angle' },
    ],
    format: (b) => `${fmt(b.angle)}°` },
  turn_right: { cat: 'movement', shape: 'stack', icon: '↪️', label: 'turn right',
    slots: [
      { key: 'speed', kind: NUM, control: 'range', min: 0, max: 100, step: 5, default: 50, label: 'speed' },
      { key: 'angle', kind: NUM, control: 'number', min: 1, max: 360, step: 1, default: 90, label: 'angle' },
    ],
    format: (b) => `${fmt(b.angle)}°` },
  set_speed: { cat: 'movement', shape: 'stack', icon: '🏎️', label: 'set motor speed',
    slots: [
      { key: 'left', kind: NUM, control: 'range', min: -100, max: 100, step: 5, default: 50, label: 'left' },
      { key: 'right', kind: NUM, control: 'range', min: -100, max: 100, step: 5, default: 50, label: 'right' },
    ],
    format: (b) => `L:${fmt(b.left)} R:${fmt(b.right)}` },
  stop: { cat: 'movement', shape: 'cap', icon: '🛑', label: 'stop motors' },

  // ── Sensing (orange) ── conditional statement blocks ──
  if_obstacle: { cat: 'sensor', shape: 'e', icon: '👀', label: 'if obstacle within', hidden: true,
    mouths: [{ key: 'then' }, { key: 'else' }],
    slots: [{ key: 'distance', kind: NUM, control: 'number', min: 1, max: 200, step: 1, default: 20, label: 'cm' }],
    format: (b) => `${fmt(b.distance)}cm` },
  if_line: { cat: 'sensor', shape: 'e', icon: '➖', label: 'if line detected', hidden: true,
    mouths: [{ key: 'then' }, { key: 'else' }],
    slots: [
      { key: 'sensor', kind: STR, control: 'select', options: ['left', 'right', 'both'], default: 'both', label: 'sensor' },
      { key: 'color', kind: STR, control: 'select', options: ['black', 'white'], default: 'black', label: 'color' },
    ],
    format: (b) => `${fmt(b.sensor)} · ${fmt(b.color)}` },
  if_color: { cat: 'sensor', shape: 'e', icon: '🎨', label: 'if color is', hidden: true,
    mouths: [{ key: 'then' }, { key: 'else' }],
    slots: [
      { key: 'color', kind: STR, control: 'select', options: ['red','green','blue','yellow','white','black'], default: 'red', label: 'color' },
    ],
    format: (b) => fmt(b.color) },
  if_sensor_range: { cat: 'sensor', shape: 'e', icon: '📐', label: 'if sensor between', hidden: true,
    mouths: [{ key: 'then' }, { key: 'else' }],
    slots: [
      { key: 'sensor', kind: STR, control: 'select', options: ['distance','line','brightness','loudness','angle'], default: 'distance', label: 'sensor' },
      { key: 'min', kind: NUM, control: 'number', min: 0, max: 400, step: 1, default: 10, label: 'min' },
      { key: 'max', kind: NUM, control: 'number', min: 0, max: 400, step: 1, default: 30, label: 'max' },
    ],
    format: (b) => `${fmt(b.sensor)} ∈ [${fmt(b.min)},${fmt(b.max)}]` },
  if_predicate: { cat: 'sensor', shape: 'e', icon: '🧪', label: 'if',
    mouths: [{ key: 'then' }, { key: 'else' }],
    slots: [{ key: 'cond', kind: BOOL, control: null, default: null, label: '' }] },
  display_value: { cat: 'sensor', shape: 'stack', icon: '📊', label: 'show sensor value',
    slots: [
      { key: 'sensor', kind: STR, control: 'select', options: ['distance','line','brightness','loudness','angle'], default: 'distance', label: 'sensor' },
      { key: 'label', kind: STR, control: 'text', default: 'Distance', label: 'label' },
    ],
    format: (b) => fmt(b.sensor) },

  // ── Sound (magenta) ──
  play_tone: { cat: 'sound', shape: 'stack', icon: '🎵', label: 'play tone',
    slots: [
      { key: 'frequency', kind: NUM, control: 'number', min: 100, max: 2000, step: 10, default: 440, label: 'Hz' },
      { key: 'duration', kind: NUM, control: 'number', min: 0.1, max: 5, step: 0.1, default: 0.5, label: 'sec' },
    ],
    format: (b) => `${fmt(b.frequency)}Hz` },
  play_sound: { cat: 'sound', shape: 'stack', icon: '🔊', label: 'play sound',
    slots: [{ key: 'sound', kind: STR, control: 'select',
      options: ['hello','hi','bye','yeah','wow','laugh','hum','sad','sigh','annoyed','angry','surprised','yummy','curious','embarrassed','ready','sprint','sleepy','meow','start','switch','beeps','buzzing','explosion','jump','laser','level-up','low-energy','prompt-tone','right','wrong','ring','score','wake','warning','metal-clash','shot','glass-clink','inflator','running-water','clockwork','click','current','wood-hit','iron','drop','bubble','wave','magic','spitfire','heartbeat','load'],
      default: 'laugh', label: 'sound' }],
    format: (b) => fmt(b.sound) },
  play_melody: { cat: 'sound', shape: 'stack', icon: '🎶', label: 'play melody',
    slots: [{ key: 'melody', kind: STR, control: 'select',
      options: ['birthday','twinkle','jingle','ode','scale','fanfare','alert','win','lose','power_up','power_down','level_up','score'],
      default: 'birthday', label: 'melody' }],
    format: (b) => fmt(b.melody) },

  // ── Display & Lights (purple) ──
  display_text: { cat: 'display', shape: 'stack', icon: '📝', label: 'show text',
    slots: [
      { key: 'text', kind: STR, control: 'text', default: 'Hello!', label: 'text' },
      { key: 'size', kind: NUM, control: 'number', min: 8, max: 48, step: 2, default: 16, label: 'size' },
    ],
    format: (b) => `"${fmt(b.text)}"` },
  display_image: { cat: 'display', shape: 'stack', icon: '🖼️', label: 'show image',
    slots: [{ key: 'image', kind: STR, control: 'select',
      options: ['happy','sad','heart','star','arrow_up','arrow_down'], default: 'happy', label: 'image' }] },
  say: { cat: 'display', shape: 'stack', icon: '💬', label: 'say',
    slots: [{ key: 'text', kind: STR, control: 'text', default: 'Hi!', label: 'text' }],
    format: (b) => `"${fmt(b.text)}"` },
  set_led: { cat: 'display', shape: 'stack', icon: '💡', label: 'set LEDs',
    slots: [{ key: 'color', kind: STR, control: 'select',
      options: ['red','green','blue','yellow','purple','white','off'], default: 'green', label: 'color' }] },
  led_effect: { cat: 'display', shape: 'stack', icon: '🌈', label: 'LED effect',
    slots: [{ key: 'effect', kind: STR, control: 'select',
      options: ['rainbow','breathe_red','breathe_green','breathe_blue'], default: 'rainbow', label: 'effect' }] },

  // ── Control (yellow) ──
  wait: { cat: 'control', shape: 'stack', icon: '⏱️', label: 'wait',
    slots: [{ key: 'duration', kind: NUM, control: 'number', min: 0.1, max: 60, step: 0.1, default: 1, label: 'sec' }],
    format: (b) => `${fmt(b.duration)}s` },
  repeat: { cat: 'control', shape: 'c', icon: '🔄', label: 'repeat',
    mouths: [{ key: 'do' }],
    slots: [{ key: 'times', kind: NUM, control: 'number', min: 1, max: 100, step: 1, default: 3, label: 'times' }],
    format: (b) => `${fmt(b.times)}×` },
  repeat_forever: { cat: 'control', shape: 'c', icon: '♾️', label: 'forever',
    mouths: [{ key: 'do' }] },
  repeat_until: { cat: 'control', shape: 'c', icon: '⏳', label: 'repeat until',
    mouths: [{ key: 'do' }],
    slots: [{ key: 'cond', kind: BOOL, control: null, default: null, label: '' }] },
  // Generic if / if-else — drop a hexagon predicate (Sensing or Operators)
  // into the slot. Replaces the older specialized if_obstacle/if_color etc.
  if_predicate: { cat: 'control', shape: 'c', icon: '🤔', label: 'if',
    mouths: [{ key: 'then' }],
    slots: [{ key: 'cond', kind: BOOL, control: null, default: null, label: '' }] },
  if_else_predicate: { cat: 'control', shape: 'e', icon: '🤔', label: 'if',
    mouths: [{ key: 'then' }, { key: 'else' }],
    slots: [{ key: 'cond', kind: BOOL, control: null, default: null, label: '' }] },
  // Wait until a predicate is true (blocks until condition met).
  wait_until: { cat: 'control', shape: 'stack', icon: '⏳', label: 'wait until',
    slots: [{ key: 'cond', kind: BOOL, control: null, default: null, label: '' }] },
  // Cap block — terminates the program.
  stop_all: { cat: 'control', shape: 'cap', icon: '⛔', label: 'stop',
    slots: [{ key: 'what', kind: STR, control: 'select', options: ['all', 'this script'], default: 'all', label: '' }] },
  while_block: { cat: 'control', shape: 'c', icon: '🔁', label: 'while',
    mouths: [{ key: 'do' }],
    slots: [{ key: 'cond', kind: BOOL, control: null, default: null, label: '' }] },
  if_button: { cat: 'control', shape: 'c', icon: '🔘', label: 'if button pressed', hidden: true,
    mouths: [{ key: 'then' }],
    slots: [{ key: 'button', kind: STR, control: 'select', options: ['a','b'], default: 'a', label: 'button' }],
    format: (b) => fmt(b.button).toUpperCase() },
  while_sensor: { cat: 'control', shape: 'c', icon: '🔁', label: 'while sensor', hidden: true,
    mouths: [{ key: 'do' }],
    slots: [
      { key: 'sensor', kind: STR, control: 'select', options: ['distance','line','brightness','loudness','angle','timer'], default: 'distance', label: 'sensor' },
      { key: 'operator', kind: STR, control: 'select', options: ['>','<','>=','<=','==','between'], default: '>', label: 'op' },
      { key: 'value', kind: NUM, control: 'number', min: 0, max: 400, step: 1, default: 20, label: 'value' },
      { key: 'min', kind: NUM, control: 'number', min: 0, max: 400, step: 1, default: 10, label: 'min' },
      { key: 'max', kind: NUM, control: 'number', min: 0, max: 400, step: 1, default: 30, label: 'max' },
    ] },
  move_until: { cat: 'control', shape: 'stack', icon: '🎯', label: 'move until', hidden: true,
    slots: [
      { key: 'direction', kind: STR, control: 'select', options: ['forward','backward'], default: 'forward', label: 'dir' },
      { key: 'speed', kind: NUM, control: 'range', min: 10, max: 100, step: 5, default: 50, label: 'speed' },
      { key: 'sensor', kind: STR, control: 'select', options: ['distance','line','brightness','loudness','angle'], default: 'distance', label: 'sensor' },
      { key: 'operator', kind: STR, control: 'select', options: ['<','>','<=','>=','between'], default: '<', label: 'op' },
      { key: 'value', kind: NUM, control: 'number', min: 0, max: 400, step: 1, default: 15, label: 'value' },
      { key: 'min', kind: NUM, control: 'number', min: 0, max: 400, step: 1, default: 10, label: 'min' },
      { key: 'max', kind: NUM, control: 'number', min: 0, max: 400, step: 1, default: 30, label: 'max' },
    ] },

  // ── Variables (red) ──
  set_variable: { cat: 'variable', shape: 'stack', icon: '📦', label: 'set',
    slots: [
      { key: 'name', kind: STR, control: 'text', default: 'my_var', label: 'name' },
      { key: 'value', kind: NUM, control: 'number', min: -9999, max: 9999, step: 1, default: 0, label: 'to' },
    ],
    format: (b) => `${fmt(b.name)} = ${fmtSlot(b.value)}` },
  change_variable: { cat: 'variable', shape: 'stack', icon: '➕', label: 'change',
    slots: [
      { key: 'name', kind: STR, control: 'text', default: 'my_var', label: 'name' },
      { key: 'by', kind: NUM, control: 'number', min: -9999, max: 9999, step: 1, default: 1, label: 'by' },
    ],
    format: (b) => `${fmt(b.name)} += ${fmtSlot(b.by)}` },

  // ── Hardware (green) ──
  dc_motor: { cat: 'hardware', shape: 'stack', icon: '⚡', label: 'DC motor',
    slots: [
      { key: 'port', kind: STR, control: 'select', options: ['M1','M2','M3','M4'], default: 'M3', label: 'port' },
      { key: 'speed', kind: NUM, control: 'range', min: -100, max: 100, step: 5, default: 50, label: 'speed' },
      { key: 'duration', kind: NUM, control: 'number', min: 0.1, max: 30, step: 0.1, default: 1, label: 'sec' },
    ],
    format: (b) => `${fmt(b.port)} · ${fmt(b.speed)}% · ${fmt(b.duration)}s` },
  servo: { cat: 'hardware', shape: 'stack', icon: '🦾', label: 'move servo',
    slots: [
      { key: 'port', kind: STR, control: 'select', options: ['S1','S2','S3','S4'], default: 'S1', label: 'port' },
      { key: 'angle', kind: NUM, control: 'number', min: 0, max: 180, step: 1, default: 90, label: 'angle' },
    ],
    format: (b) => `${fmt(b.port)} · ${fmt(b.angle)}°` },

  // ── Operators — reporters (oval = number/string) ──
  op_add: { cat: 'operator', shape: 'reporter', kind: NUM, infix: '+',
    slots: [
      { key: 'a', kind: NUM, control: 'number', default: 0, inline: true },
      { key: 'b', kind: NUM, control: 'number', default: 0, inline: true },
    ] },
  op_sub: { cat: 'operator', shape: 'reporter', kind: NUM, infix: '−',
    slots: [
      { key: 'a', kind: NUM, control: 'number', default: 0, inline: true },
      { key: 'b', kind: NUM, control: 'number', default: 0, inline: true },
    ] },
  op_mul: { cat: 'operator', shape: 'reporter', kind: NUM, infix: '×',
    slots: [
      { key: 'a', kind: NUM, control: 'number', default: 0, inline: true },
      { key: 'b', kind: NUM, control: 'number', default: 0, inline: true },
    ] },
  op_div: { cat: 'operator', shape: 'reporter', kind: NUM, infix: '÷',
    slots: [
      { key: 'a', kind: NUM, control: 'number', default: 0, inline: true },
      { key: 'b', kind: NUM, control: 'number', default: 1, inline: true },
    ] },
  op_mod: { cat: 'operator', shape: 'reporter', kind: NUM, infix: 'mod',
    slots: [
      { key: 'a', kind: NUM, control: 'number', default: 0, inline: true },
      { key: 'b', kind: NUM, control: 'number', default: 2, inline: true },
    ] },
  op_random: { cat: 'operator', shape: 'reporter', kind: NUM, label: 'pick random',
    slots: [
      { key: 'min', kind: NUM, control: 'number', default: 1, inline: true, prefix: '' },
      { key: 'max', kind: NUM, control: 'number', default: 10, inline: true, prefix: 'to' },
    ] },
  op_round: { cat: 'operator', shape: 'reporter', kind: NUM, label: 'round',
    slots: [{ key: 'a', kind: NUM, control: 'number', default: 0, inline: true }] },
  op_abs: { cat: 'operator', shape: 'reporter', kind: NUM, label: 'abs',
    slots: [{ key: 'a', kind: NUM, control: 'number', default: 0, inline: true, prefix: 'of' }] },
  op_function: { cat: 'operator', shape: 'reporter', kind: NUM, label: 'fn',
    slots: [
      { key: 'fn', kind: STR, control: 'select', options: ['floor','ceil','sqrt','sin','cos','tan','log','neg'], default: 'sqrt', inline: true },
      { key: 'a', kind: NUM, control: 'number', default: 0, inline: true, prefix: 'of' },
    ] },
  op_join: { cat: 'operator', shape: 'reporter', kind: STR, label: 'join',
    slots: [
      { key: 'a', kind: STR, control: 'text', default: 'apple ', inline: true },
      { key: 'b', kind: STR, control: 'text', default: 'banana', inline: true },
    ] },
  op_letter: { cat: 'operator', shape: 'reporter', kind: STR, label: 'letter',
    slots: [
      { key: 'n', kind: NUM, control: 'number', default: 1, inline: true },
      { key: 'a', kind: STR, control: 'text', default: 'apple', inline: true, prefix: 'of' },
    ] },
  op_length: { cat: 'operator', shape: 'reporter', kind: NUM, label: 'length of',
    slots: [{ key: 'a', kind: STR, control: 'text', default: 'apple', inline: true }] },

  // ── Operators — predicates (hexagon = boolean) ──
  op_gt: { cat: 'operator', shape: 'predicate', kind: BOOL, infix: '>',
    slots: [
      { key: 'a', kind: NUM, control: 'number', default: 0, inline: true },
      { key: 'b', kind: NUM, control: 'number', default: 50, inline: true },
    ] },
  op_lt: { cat: 'operator', shape: 'predicate', kind: BOOL, infix: '<',
    slots: [
      { key: 'a', kind: NUM, control: 'number', default: 0, inline: true },
      { key: 'b', kind: NUM, control: 'number', default: 50, inline: true },
    ] },
  op_eq: { cat: 'operator', shape: 'predicate', kind: BOOL, infix: '=',
    slots: [
      { key: 'a', kind: NUM, control: 'number', default: 0, inline: true },
      { key: 'b', kind: NUM, control: 'number', default: 50, inline: true },
    ] },
  op_and: { cat: 'operator', shape: 'predicate', kind: BOOL, infix: 'and',
    slots: [
      { key: 'a', kind: BOOL, control: null, default: null, inline: true },
      { key: 'b', kind: BOOL, control: null, default: null, inline: true },
    ] },
  op_or: { cat: 'operator', shape: 'predicate', kind: BOOL, infix: 'or',
    slots: [
      { key: 'a', kind: BOOL, control: null, default: null, inline: true },
      { key: 'b', kind: BOOL, control: null, default: null, inline: true },
    ] },
  op_not: { cat: 'operator', shape: 'predicate', kind: BOOL, label: 'not',
    slots: [{ key: 'a', kind: BOOL, control: null, default: null, inline: true }] },
  op_contains: { cat: 'operator', shape: 'predicate', kind: BOOL, label: 'contains',
    slots: [
      { key: 'a', kind: STR, control: 'text', default: 'apple', inline: true },
      { key: 'b', kind: STR, control: 'text', default: 'a', inline: true, prefix: '?' },
    ] },

  // ── Sensing — reporters ──
  sensor_distance: { cat: 'sensor', shape: 'reporter', kind: NUM, icon: '📏', label: 'distance' },
  sensor_line: { cat: 'sensor', shape: 'reporter', kind: NUM, icon: '➖', label: 'line' },
  sensor_brightness: { cat: 'sensor', shape: 'reporter', kind: NUM, icon: '☀️', label: 'brightness' },
  sensor_loudness: { cat: 'sensor', shape: 'reporter', kind: NUM, icon: '🔊', label: 'loudness' },
  sensor_angle: { cat: 'sensor', shape: 'reporter', kind: NUM, icon: '🧭', label: 'angle (yaw)' },
  sensor_pitch: { cat: 'sensor', shape: 'reporter', kind: NUM, icon: '📐', label: 'pitch' },
  sensor_roll: { cat: 'sensor', shape: 'reporter', kind: NUM, icon: '🌀', label: 'roll' },
  sensor_timer: { cat: 'sensor', shape: 'reporter', kind: NUM, icon: '⏲️', label: 'timer' },
  sensor_button_pressed: { cat: 'sensor', shape: 'predicate', kind: BOOL, icon: '🔘', label: 'button',
    slots: [{ key: 'button', kind: STR, control: 'select', options: ['a','b'], default: 'a', inline: true, prefix: 'pressed?' }] },
  sensor_obstacle_close: { cat: 'sensor', shape: 'predicate', kind: BOOL, icon: '👀', label: 'obstacle within',
    slots: [{ key: 'distance', kind: NUM, control: 'number', default: 20, min: 1, max: 200, step: 1, inline: true, prefix: 'cm' }] },
  // Motion-sensing predicates (gyro/accel-based, mBlock parity)
  sensor_is_shaking: { cat: 'sensor', shape: 'predicate', kind: BOOL, icon: '🤳', label: 'is shaking?' },
  sensor_is_upside_down: { cat: 'sensor', shape: 'predicate', kind: BOOL, icon: '🔃', label: 'is upside down?' },
  sensor_is_tilted: { cat: 'sensor', shape: 'predicate', kind: BOOL, icon: '📐', label: 'is tilted',
    slots: [{ key: 'direction', kind: STR, control: 'select', options: ['forward','backward','left','right'], default: 'forward', inline: true, prefix: '?' }] },
  // Battery + WiFi
  sensor_battery: { cat: 'sensor', shape: 'reporter', kind: NUM, icon: '🔋', label: 'battery %' },
  sensor_wifi_connected: { cat: 'sensor', shape: 'predicate', kind: BOOL, icon: '📡', label: 'wifi connected?' },

  // ── Variables — reporters ──
  var_get: { cat: 'variable', shape: 'reporter', kind: NUM, icon: '📦', label: '',
    slots: [{ key: 'name', kind: STR, control: 'text', default: 'my_var', inline: true }] },
};

const CATEGORIES = [
  { id: 'movement', label: 'Motion',    color: '#4c97ff', dot: '🚗' },
  { id: 'sensor',   label: 'Sensing',   color: '#ff8c1a', dot: '👀' },
  { id: 'sound',    label: 'Sound',     color: '#cf63cf', dot: '🎵' },
  { id: 'display',  label: 'Display',   color: '#9966ff', dot: '🖥️' },
  { id: 'control',  label: 'Control',   color: '#ffab19', dot: '🔄' },
  { id: 'operator', label: 'Operators', color: '#59c059', dot: '⚖️' },
  { id: 'variable', label: 'Variables', color: '#ff6680', dot: '📦' },
  { id: 'hardware', label: 'Hardware',  color: '#0fbd8c', dot: '⚙️' },
];
const CAT_COLOR = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.color]));

function fmt(v) {
  if (isReporter(v)) return '◯';
  if (v === undefined || v === null) return '';
  return String(v);
}
function fmtSlot(v) { return fmt(v); }

// ─────────────────────────────────────────────────────────────────────────────
// Tree helpers — id-based
// ─────────────────────────────────────────────────────────────────────────────

function isReporter(v) {
  return v && typeof v === 'object' && !Array.isArray(v)
    && typeof v.type === 'string'
    && BLOCK_DEFS[v.type]
    && (BLOCK_DEFS[v.type].shape === 'reporter' || BLOCK_DEFS[v.type].shape === 'predicate');
}

function genId() {
  return 'b' + Math.random().toString(36).slice(2, 9);
}

/** Walk a block tree; assign _id to every block (statement and reporter) that lacks one. */
function hydrate(blocks) {
  return (blocks || []).map(hydrateOne).filter(Boolean);
}
function hydrateOne(b) {
  if (!b || typeof b !== 'object' || !b.type) return b;
  const out = { ...b };
  if (!out._id) out._id = genId();
  // Mouth arrays (then/else/do)
  for (const k of ['then', 'else', 'do']) {
    if (Array.isArray(out[k])) out[k] = out[k].map(hydrateOne);
  }
  // Reporter slots
  for (const k of Object.keys(out)) {
    if (k === '_id' || k === 'type') continue;
    const v = out[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.type === 'string') {
      out[k] = hydrateOne(v);
    }
  }
  return out;
}

/** Find a block by id; return { block, parent, container, key, index } describing how to remove it.
 *  - container 'top'  → blocks is the top array, index = position
 *  - container 'arr'  → parent[key] is an array, index = position
 *  - container 'slot' → parent[key] is the reporter itself
 */
function findById(blocks, id, parent = null) {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b._id === id) return { block: b, parent, container: parent ? 'arr' : 'top', key: parent ? '__top__' : null, index: i, arr: blocks };
    const inside = findInBlock(b, id);
    if (inside) return inside;
  }
  return null;
}
function findInBlock(parent, id) {
  if (!parent || typeof parent !== 'object') return null;
  for (const k of ['then', 'else', 'do']) {
    if (Array.isArray(parent[k])) {
      for (let i = 0; i < parent[k].length; i++) {
        const child = parent[k][i];
        if (child._id === id) return { block: child, parent, container: 'arr', key: k, index: i, arr: parent[k] };
        const deep = findInBlock(child, id);
        if (deep) return deep;
      }
    }
  }
  for (const k of Object.keys(parent)) {
    if (k === '_id' || k === 'type' || k === 'then' || k === 'else' || k === 'do') continue;
    const v = parent[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.type === 'string') {
      if (v._id === id) return { block: v, parent, container: 'slot', key: k, index: -1, arr: null };
      const deep = findInBlock(v, id);
      if (deep) return deep;
    }
  }
  return null;
}

function cloneTree(blocks) { return JSON.parse(JSON.stringify(blocks)); }

function removeById(blocks, id) {
  const out = cloneTree(blocks);
  const loc = findById(out, id);
  if (!loc) return { blocks: out, removed: null };
  if (loc.container === 'top') {
    const [removed] = out.splice(loc.index, 1);
    return { blocks: out, removed };
  }
  if (loc.container === 'arr') {
    const [removed] = loc.arr.splice(loc.index, 1);
    return { blocks: out, removed };
  }
  if (loc.container === 'slot') {
    const removed = loc.parent[loc.key];
    delete loc.parent[loc.key];
    return { blocks: out, removed };
  }
  return { blocks: out, removed: null };
}

/** Insert into an array container (top or mouth). */
function insertIntoArr(blocks, target, item) {
  // target = { kind: 'top', index } | { kind: 'mouth', parentId, mouthKey, index }
  const out = cloneTree(blocks);
  if (target.kind === 'top') {
    out.splice(target.index, 0, item);
    return out;
  }
  const loc = findById(out, target.parentId);
  if (!loc) { out.push(item); return out; }
  const parent = loc.block;
  if (!Array.isArray(parent[target.mouthKey])) parent[target.mouthKey] = [];
  parent[target.mouthKey].splice(target.index, 0, item);
  return out;
}

/** Set a reporter into a slot, replacing whatever is there. */
function setSlot(blocks, parentId, key, value) {
  const out = cloneTree(blocks);
  const loc = findById(out, parentId);
  if (!loc) return out;
  if (value === null || value === undefined) {
    delete loc.block[key];
  } else {
    loc.block[key] = value;
  }
  return out;
}

function setPrimitive(blocks, parentId, key, value) {
  return setSlot(blocks, parentId, key, value);
}

function descendantIds(block) {
  const ids = new Set();
  const visit = (b) => {
    if (!b || typeof b !== 'object') return;
    if (b._id) ids.add(b._id);
    for (const k of ['then','else','do']) {
      if (Array.isArray(b[k])) b[k].forEach(visit);
    }
    for (const k of Object.keys(b)) {
      if (['_id','type','then','else','do'].includes(k)) continue;
      const v = b[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.type === 'string') visit(v);
    }
  };
  visit(block);
  return ids;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export default function BlocklyEditor({ blocks: extBlocks, onBlocksChange, robotConfig }) {
  const [activeCat, setActiveCat] = useState('movement');
  const [editingId, setEditingId] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [dropHint, setDropHint] = useState(null); // { kind, ... }
  const [draggingExisting, setDraggingExisting] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  // The current snap candidate during a drag. We don't put it in React state
  // because mutating DOM classes/styles directly each mousemove is faster and
  // doesn't cause re-renders. We do still track it in a ref so dragend can
  // synthesize a drop on it (the "grace buffer" snap-on-release).
  const snapTargetRef = useRef(null);
  const clearSnapTarget = () => {
    const t = snapTargetRef.current;
    if (t) {
      t.el?.classList.remove('snap-active', 'snap-grow');
      if (t.el && t._origMinWidth !== undefined) {
        t.el.style.minWidth = t._origMinWidth;
      }
    }
    snapTargetRef.current = null;
  };
  const [contextMenu, setContextMenu] = useState(null); // { x, y, blockId }
  const [clipboard, setClipboard] = useState(() => {
    try {
      const raw = localStorage.getItem('mbot.blockClipboard');
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  });

  // Hydrate external blocks once on mount and whenever the parent passes a different ref.
  // Internal state owns the edited tree; we propagate up via onBlocksChange.
  const [internal, setInternal] = useState(() => hydrate(extBlocks || []));
  const lastEmittedRef = useRef(internal);
  useEffect(() => {
    if (extBlocks !== lastEmittedRef.current) {
      setInternal(hydrate(extBlocks || []));
    }
  }, [extBlocks]);

  // Floating (disconnected) scripts: independent block stacks placed anywhere
  // on the canvas. NOT sent to the robot — only the main `internal` chain
  // (connected to the hat) runs. Persisted in localStorage so they survive
  // reloads.
  const [floating, setFloating] = useState(() => {
    try {
      const raw = localStorage.getItem('mbot.floatingScripts');
      const parsed = raw ? JSON.parse(raw) : [];
      return parsed.map((s) => ({ ...s, blocks: hydrate(s.blocks || []) }));
    } catch { return []; }
  });
  // Position of the main (connected) script on the canvas.
  const [mainPos, setMainPos] = useState(() => {
    try {
      const raw = localStorage.getItem('mbot.mainScriptPos');
      return raw ? JSON.parse(raw) : { x: 24, y: 16 };
    } catch { return { x: 24, y: 16 }; }
  });

  // Persist floating scripts whenever they change.
  useEffect(() => {
    try { localStorage.setItem('mbot.floatingScripts', JSON.stringify(floating)); } catch {}
  }, [floating]);
  useEffect(() => {
    try { localStorage.setItem('mbot.mainScriptPos', JSON.stringify(mainPos)); } catch {}
  }, [mainPos]);

  const commit = (next) => {
    setInternal(next);
    lastEmittedRef.current = next;
    onBlocksChange(next);
  };

  // Resolve a block id across BOTH the main chain and all floating scripts.
  // Returns { source: 'main'|'floating', floatingIndex?, location } where
  // location is the same shape as findById in a single tree.
  const findAnywhere = (id) => {
    const inMain = findById(internal, id);
    if (inMain) return { source: 'main', loc: inMain };
    for (let i = 0; i < floating.length; i++) {
      const r = findById(floating[i].blocks, id);
      if (r) return { source: 'floating', floatingIndex: i, loc: r };
    }
    return null;
  };

  // Remove a block by id from wherever it lives. Returns the removed block
  // and a callback to apply the new state (so callers can sequence with insert).
  const removeAnywhere = (id) => {
    const inMain = findById(internal, id);
    if (inMain) {
      const { blocks: next, removed } = removeById(internal, id);
      return { removed, applyRemoval: () => commit(next), source: 'main' };
    }
    for (let i = 0; i < floating.length; i++) {
      const r = findById(floating[i].blocks, id);
      if (r) {
        const { blocks: next, removed } = removeById(floating[i].blocks, id);
        return {
          removed,
          applyRemoval: () => setFloating((arr) => {
            const out = arr.slice();
            // If removing this floating script's only/top block, drop the script entirely.
            if (next.length === 0) out.splice(i, 1);
            else out[i] = { ...out[i], blocks: next };
            return out;
          }),
          source: 'floating',
          floatingIndex: i,
        };
      }
    }
    return null;
  };

  // dragRef holds the active drag payload (HTML5 dataTransfer is string-only / async).
  // payload: { kind: 'new'|'move', block?: object, sourceId?: string }
  const dragRef = useRef(null);

  // Hardware palette items
  const hardwareItems = useMemo(() => {
    if (!robotConfig?.additions?.length) return [];
    const items = [];
    for (const hw of robotConfig.additions) {
      if (!hw.actions?.length) continue;
      for (const action of hw.actions) {
        const block = hw.type === 'servo'
          ? { type: 'servo', port: hw.port, angle: action.angle ?? 90 }
          : { type: 'dc_motor', port: hw.port,
              speed: action.motorDirection === 'reverse' ? -(action.speed ?? 50) : (action.speed ?? 50),
              duration: action.duration ?? 1 };
        items.push({ id: `${hw.port}_${action.name}`, label: `${hw.label || hw.port}: ${action.name}`, icon: hw.type === 'servo' ? '🦾' : '⚡', block });
      }
    }
    return items;
  }, [robotConfig]);

  // ── Drag start ──────────────────────────────────────────────────────────
  // dragRef.current shape:
  //   { kind: 'new'|'move', block?, sourceId?,
  //     dragShape: 'stack'|'cap'|'c'|'e'|'reporter'|'predicate',
  //     measuredWidth?: number,   // pixel width of the source element (for slot-grow)
  //     measuredHeight?: number,
  //     dropped?: boolean         // set true by an actual slot drop; if still false
  //                               //   on dragend we trigger snap-on-release
  //   }
  const startDragNew = (e, type) => {
    const def = BLOCK_DEFS[type];
    const block = { type, _id: genId() };
    if (def.slots) {
      for (const s of def.slots) {
        if (s.default !== undefined && s.default !== null) block[s.key] = s.default;
      }
    }
    if (def.mouths) for (const m of def.mouths) block[m.key] = [];
    const sourceEl = e.currentTarget;
    const rect = sourceEl?.getBoundingClientRect();
    dragRef.current = {
      kind: 'new', block,
      dragShape: def.shape,
      measuredWidth: rect?.width || 0,
      measuredHeight: rect?.height || 0,
      dropped: false,
    };
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', type);
    setIsDragging(true);
    setDraggingExisting(false);
  };

  const startDragCustomBlock = (e, block) => {
    const def = BLOCK_DEFS[block.type];
    const sourceEl = e.currentTarget;
    const rect = sourceEl?.getBoundingClientRect();
    dragRef.current = {
      kind: 'new',
      block: hydrateOne({ ...block, _id: genId() }),
      dragShape: def?.shape || 'stack',
      measuredWidth: rect?.width || 0,
      measuredHeight: rect?.height || 0,
      dropped: false,
    };
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', block.type);
    setIsDragging(true);
    setDraggingExisting(false);
  };

  const startDragExisting = (e, id) => {
    const found = findAnywhere(id);
    const def = found && BLOCK_DEFS[found.loc.block.type];
    const sourceEl = e.currentTarget;
    const rect = sourceEl?.getBoundingClientRect();
    dragRef.current = {
      kind: 'move',
      sourceId: id,
      dragShape: def?.shape || 'stack',
      measuredWidth: rect?.width || 0,
      measuredHeight: rect?.height || 0,
      dropped: false,
    };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', 'move');
    setIsDragging(true);
    setDraggingExisting(true);
    e.stopPropagation();
  };

  const endDrag = () => {
    dragRef.current = null;
    setDropHint(null);
    setDraggingExisting(false);
    setIsDragging(false);
    clearSnapTarget();
  };

  // ── Snap detection (Phase 2) ──────────────────────────────────────────
  // While a drag is active, scan all drop targets every dragover and pick
  // the closest compatible one within a tolerance. Highlight it; for empty
  // reporter sockets, animate their min-width up to the dragged reporter's
  // size so kids see "this fits here" before letting go. On dragend with
  // no real drop, synthesize a drop on the current snap target — this is
  // the "grace buffer": releasing near a slot still snaps in.
  useEffect(() => {
    if (!isDragging) return;
    const SNAP_TOLERANCE = 28; // px

    const onDragOver = (e) => {
      const drag = dragRef.current;
      if (!drag) return;
      const cx = e.clientX, cy = e.clientY;
      const isReporterDrag = drag.dragShape === 'reporter' || drag.dragShape === 'predicate';

      let best = null;
      let bestDist = SNAP_TOLERANCE;

      if (!isReporterDrag) {
        // Stack drag: nearest array slot vertically.
        const slots = document.querySelectorAll('.se-canvas [data-arr-slot]');
        slots.forEach((s) => {
          const r = s.getBoundingClientRect();
          // Generous horizontal hit area, tight vertical
          if (cx < r.left - 40 || cx > r.right + 80) return;
          const slotY = (r.top + r.bottom) / 2;
          const dy = Math.abs(cy - slotY);
          if (dy < bestDist) {
            best = { kind: 'arr', el: s };
            bestDist = dy;
          }
        });
      } else {
        // Reporter drag: nearest slot host (centered distance), filtered by
        // type compatibility (boolean drag → bool slot only; non-boolean
        // drag → val slot or any).
        const sockets = document.querySelectorAll('.se-canvas [data-reporter-slot]');
        sockets.forEach((s) => {
          const slotKind = s.getAttribute('data-target-kind');
          // Bool slot only accepts a predicate; val slot accepts both.
          if (slotKind === 'bool' && drag.dragShape !== 'predicate') return;
          // Don't snap into a slot that already contains a non-empty reporter
          // (the user has to remove it first).
          if (s.querySelector('.se-block-shape')) return;
          const r = s.getBoundingClientRect();
          const dx = cx - (r.left + r.right) / 2;
          const dy = cy - (r.top + r.bottom) / 2;
          const d = Math.hypot(dx, dy);
          if (d < bestDist + 12) { // slightly more generous for sockets
            best = { kind: 'reporter', el: s, slotKind };
            bestDist = d;
          }
        });
      }

      const cur = snapTargetRef.current;
      if (cur?.el !== best?.el) {
        // Clear previous
        if (cur) {
          cur.el?.classList.remove('snap-active', 'snap-grow');
          if (cur.el && cur._origMinWidth !== undefined) {
            cur.el.style.minWidth = cur._origMinWidth;
          }
        }
        // Apply new
        if (best) {
          if (best.kind === 'arr') {
            best.el.classList.add('snap-active');
          } else {
            best.el.classList.add('snap-grow');
            // Grow socket to the dragged reporter's measured width so the
            // hexagon/oval visually fits the incoming block.
            const w = Math.max(28, drag.measuredWidth || 0);
            best._origMinWidth = best.el.style.minWidth;
            best.el.style.minWidth = w + 'px';
          }
        }
        snapTargetRef.current = best;
      }
    };

    const onDragEnd = () => {
      const drag = dragRef.current;
      const snap = snapTargetRef.current;
      // Schedule cleanup after potential drop fires (drop fires before dragend
      // when it does fire; dragRef.current is cleared by drop's call to endDrag).
      if (drag && !drag.dropped && snap) {
        // Synthesize a drop on the current snap target.
        if (snap.kind === 'arr') {
          const target = {
            kind: snap.el.getAttribute('data-target-kind'),
            scriptId: snap.el.getAttribute('data-target-script') || undefined,
            parentId: snap.el.getAttribute('data-target-parent') || undefined,
            mouthKey: snap.el.getAttribute('data-target-mouth') || undefined,
            index: parseInt(snap.el.getAttribute('data-target-index'), 10),
          };
          if (!target.scriptId) delete target.scriptId;
          if (!target.parentId) delete target.parentId;
          if (!target.mouthKey) delete target.mouthKey;
          dropOnArrSlot(target);
        } else {
          const parentId = snap.el.getAttribute('data-target-parent');
          const key = snap.el.getAttribute('data-target-key');
          const slotKind = snap.el.getAttribute('data-target-kind');
          dropOnReporterSlot(parentId, key, slotKind === 'bool' ? BOOL : NUM);
        }
      }
      // Always cleanup visual state.
      clearSnapTarget();
      // If we synthesized a drop the handlers already ran endDrag(); if not,
      // ensure state is fully reset.
      if (dragRef.current) {
        endDrag();
      }
    };

    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragend', onDragEnd);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragend', onDragEnd);
      clearSnapTarget();
    };
  }, [isDragging]);

  // ── Drop handlers ──────────────────────────────────────────────────────
  // or 'float:N' (floating-script index). Default: 'main' for backward compat.
  const dropOnArrSlot = (target) => {
    const drag = dragRef.current;
    if (drag) drag.dropped = true;
    endDrag();
    if (!drag) return;
    const dragType = drag.block?.type
      || (drag.sourceId && findAnywhere(drag.sourceId)?.loc?.block?.type);
    const draggedShape = BLOCK_DEFS[dragType]?.shape;
    if (draggedShape === 'reporter' || draggedShape === 'predicate') return;

    const scriptId = target.scriptId || 'main';

    // Resolve a getter/setter pair for the target script's blocks array.
    const getBlocks = () => {
      if (scriptId === 'main') return internal;
      const idx = parseInt(scriptId.slice(6), 10);
      return floating[idx]?.blocks || [];
    };
    const setBlocks = (next) => {
      if (scriptId === 'main') return commit(next);
      const idx = parseInt(scriptId.slice(6), 10);
      setFloating((arr) => {
        const out = arr.slice();
        out[idx] = { ...out[idx], blocks: next };
        return out;
      });
    };

    if (drag.kind === 'new') {
      setBlocks(insertIntoArr(getBlocks(), { ...target, scriptId: undefined }, drag.block));
      return;
    }

    // Move existing block: remove from wherever it is, then insert into target.
    const found = findAnywhere(drag.sourceId);
    if (!found) return;
    const ids = descendantIds(found.loc.block);
    if (target.kind === 'mouth' && ids.has(target.parentId)) return;

    if (found.source === 'main' && scriptId === 'main') {
      // same-tree move: do it in one commit so adjustment is correct
      const { blocks: removed } = removeById(internal, drag.sourceId);
      const adjusted = adjustTargetAfterRemoval({ ...target, scriptId: undefined }, found.loc, internal);
      commit(insertIntoArr(removed, adjusted, found.loc.block));
      return;
    }

    // Cross-tree move (float→main, main→float, or float→float).
    // 1) Remove from source.
    const block = found.loc.block;
    if (found.source === 'main') {
      const { blocks: nextMain } = removeById(internal, drag.sourceId);
      commit(nextMain);
    } else {
      const fi = found.floatingIndex;
      const { blocks: nextFloat } = removeById(floating[fi].blocks, drag.sourceId);
      setFloating((arr) => {
        const out = arr.slice();
        if (nextFloat.length === 0) out.splice(fi, 1);
        else out[fi] = { ...out[fi], blocks: nextFloat };
        return out;
      });
    }
    // 2) Insert into destination on next tick (so state has settled).
    setTimeout(() => {
      const dest = scriptId === 'main' ? internal : (() => {
        const idx = parseInt(scriptId.slice(6), 10);
        // Re-read latest floating after possible removal above
        return (floating[idx]?.blocks) || [];
      })();
      // (Use functional updates to avoid stale state)
      if (scriptId === 'main') {
        setInternal((cur) => {
          const next = insertIntoArr(cur, { ...target, scriptId: undefined }, block);
          lastEmittedRef.current = next;
          onBlocksChange(next);
          return next;
        });
      } else {
        const idx = parseInt(scriptId.slice(6), 10);
        setFloating((arr) => {
          const out = arr.slice();
          if (!out[idx]) return arr;
          out[idx] = { ...out[idx], blocks: insertIntoArr(out[idx].blocks, { ...target, scriptId: undefined }, block) };
          return out;
        });
      }
    }, 0);
  };

  const dropOnReporterSlot = (parentId, key, slotKind) => {
    const drag = dragRef.current;
    if (drag) drag.dropped = true;
    endDrag();
    if (!drag) return;
    const block = drag.kind === 'new'
      ? drag.block
      : findAnywhere(drag.sourceId)?.loc?.block;
    if (!block) return;
    const def = BLOCK_DEFS[block.type];
    if (!def) return;
    if (def.shape !== 'reporter' && def.shape !== 'predicate') return;
    if (slotKind === BOOL && def.shape !== 'predicate') return;

    // Locate which script the parent (slot host) is in.
    const parentLoc = findAnywhere(parentId);
    if (!parentLoc) return;

    if (drag.kind === 'new') {
      if (parentLoc.source === 'main') {
        commit(setSlot(internal, parentId, key, block));
      } else {
        const fi = parentLoc.floatingIndex;
        setFloating((arr) => {
          const out = arr.slice();
          out[fi] = { ...out[fi], blocks: setSlot(out[fi].blocks, parentId, key, block) };
          return out;
        });
      }
      return;
    }

    // Move existing reporter
    const found = findAnywhere(drag.sourceId);
    if (!found) return;
    const ids = descendantIds(found.loc.block);
    if (ids.has(parentId)) return;

    // Same-tree shortcut
    if (found.source === parentLoc.source && found.floatingIndex === parentLoc.floatingIndex) {
      if (found.source === 'main') {
        const { blocks: removed } = removeById(internal, drag.sourceId);
        commit(setSlot(removed, parentId, key, found.loc.block));
      } else {
        const fi = found.floatingIndex;
        const { blocks: removed } = removeById(floating[fi].blocks, drag.sourceId);
        setFloating((arr) => {
          const out = arr.slice();
          out[fi] = { ...out[fi], blocks: setSlot(removed, parentId, key, found.loc.block) };
          return out;
        });
      }
      return;
    }
    // Cross-tree: remove then insert (using functional updates)
    const moved = found.loc.block;
    if (found.source === 'main') {
      setInternal((cur) => {
        const { blocks: next } = removeById(cur, drag.sourceId);
        lastEmittedRef.current = next;
        onBlocksChange(next);
        return next;
      });
    } else {
      const fi = found.floatingIndex;
      setFloating((arr) => {
        const out = arr.slice();
        if (!out[fi]) return arr;
        const { blocks: next } = removeById(out[fi].blocks, drag.sourceId);
        if (next.length === 0) out.splice(fi, 1);
        else out[fi] = { ...out[fi], blocks: next };
        return out;
      });
    }
    setTimeout(() => {
      if (parentLoc.source === 'main') {
        setInternal((cur) => {
          const next = setSlot(cur, parentId, key, moved);
          lastEmittedRef.current = next;
          onBlocksChange(next);
          return next;
        });
      } else {
        const fi = parentLoc.floatingIndex;
        setFloating((arr) => {
          const out = arr.slice();
          if (!out[fi]) return arr;
          out[fi] = { ...out[fi], blocks: setSlot(out[fi].blocks, parentId, key, moved) };
          return out;
        });
      }
    }, 0);
  };

  const dropOnTrash = () => {
    const drag = dragRef.current;
    if (drag) drag.dropped = true;
    endDrag();
    if (!drag || drag.kind !== 'move') return;
    const r = removeAnywhere(drag.sourceId);
    if (!r) return;
    r.applyRemoval();
    if (editingId === drag.sourceId) setEditingId(null);
  };

  // Drop a NEW block from the palette onto the empty canvas at (x, y),
  // creating a new floating script there.
  // Only fires when no snap target was found (the snap effect won the drop
  // already if it did). For existing-block moves dropped on bare canvas,
  // we move the script's anchor position instead of cloning.
  const dropOnCanvas = (e) => {
    const drag = dragRef.current;
    if (!drag) return false;
    // If the snap detector found a target, let it handle the drop on dragend.
    if (snapTargetRef.current) return false;
    if (e && (e.target.closest('.se-slot') || e.target.closest('.se-slot-host'))) return false;

    const canvasEl = canvasRef.current;
    const rect = canvasEl ? canvasEl.getBoundingClientRect() : { left: 0, top: 0 };
    const scrollLeft = canvasEl ? canvasEl.scrollLeft : 0;
    const scrollTop = canvasEl ? canvasEl.scrollTop : 0;
    const x = (e?.clientX ?? rect.left + 80) - rect.left + scrollLeft - 12;
    const y = (e?.clientY ?? rect.top + 80) - rect.top + scrollTop - 8;

    if (drag.kind === 'new') {
      const def = BLOCK_DEFS[drag.block.type];
      if (!def) return false;
      // Reporters can't live free on the canvas — they need a slot.
      if (def.shape === 'reporter' || def.shape === 'predicate') return false;
      const newScript = {
        id: 'fs_' + Math.random().toString(36).slice(2, 9),
        x: Math.max(8, x),
        y: Math.max(8, y),
        blocks: [drag.block],
      };
      setFloating((arr) => [...arr, newScript]);
      drag.dropped = true;
      endDrag();
      return true;
    }
    // Existing block dropped on bare canvas: detach into a new floating script.
    if (drag.kind === 'move') {
      const found = findAnywhere(drag.sourceId);
      if (!found) return false;
      const def = BLOCK_DEFS[found.loc.block.type];
      // Reporters can't be freed (would need to wrap them).
      if (def?.shape === 'reporter' || def?.shape === 'predicate') return false;
      const block = found.loc.block;
      // Remove from source
      const r = removeAnywhere(drag.sourceId);
      if (r) r.applyRemoval();
      // Insert as a new floating script at drop position
      setTimeout(() => {
        setFloating((arr) => [...arr, {
          id: 'fs_' + Math.random().toString(36).slice(2, 9),
          x: Math.max(8, x),
          y: Math.max(8, y),
          blocks: [block],
        }]);
      }, 0);
      drag.dropped = true;
      endDrag();
      return true;
    }
    return false;
  };

  // Pointer-drag to MOVE a script's xy on the canvas.
  // Triggered by mousedown on a script's "drag handle" (its top block).
  const scriptDragRef = useRef(null);
  const onScriptHandlePointerDown = (e, scriptId) => {
    // Don't start a move drag if the user clicked an interactive element
    // (input, button, select). Also let HTML5 DnD on .se-block-shape take
    // priority by only starting on direct background clicks.
    if (e.target.closest('input, select, textarea, button, .se-slot-host')) return;
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const initial = scriptId === 'main'
      ? mainPos
      : floating.find((s) => s.id === scriptId);
    if (!initial) return;
    const initX = initial.x, initY = initial.y;
    scriptDragRef.current = { scriptId, startX, startY, initX, initY };
    const move = (ev) => {
      const d = scriptDragRef.current;
      if (!d) return;
      const dx = ev.clientX - d.startX;
      const dy = ev.clientY - d.startY;
      const nx = Math.max(0, d.initX + dx);
      const ny = Math.max(0, d.initY + dy);
      if (d.scriptId === 'main') {
        setMainPos({ x: nx, y: ny });
      } else {
        setFloating((arr) => arr.map((s) => s.id === d.scriptId ? { ...s, x: nx, y: ny } : s));
      }
    };
    const up = () => {
      scriptDragRef.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const handleClearAll = () => {
    if (!internal.length && !floating.length) return;
    if (!window.confirm('Remove all blocks (including floating scripts)?')) return;
    commit([]);
    setFloating([]);
    setEditingId(null);
  };

  const handleDuplicate = (id) => {
    const found = findAnywhere(id);
    if (!found || found.loc.container === 'slot') return;
    const cloneSrc = JSON.parse(JSON.stringify(found.loc.block));
    const cloned = reassignIds(cloneSrc);
    const insertCloned = (blocks) => {
      const out = cloneTree(blocks);
      if (found.loc.container === 'top') {
        out.splice(found.loc.index + 1, 0, cloned);
      } else {
        const parentLoc = findById(out, found.loc.parent._id);
        parentLoc.block[found.loc.key].splice(found.loc.index + 1, 0, cloned);
      }
      return out;
    };
    if (found.source === 'main') {
      commit(insertCloned(internal));
    } else {
      const fi = found.floatingIndex;
      setFloating((arr) => {
        const out = arr.slice();
        out[fi] = { ...out[fi], blocks: insertCloned(out[fi].blocks) };
        return out;
      });
    }
  };

  const handleSetPrimitive = (id, key, value) => {
    const found = findAnywhere(id);
    if (!found) return;
    if (found.source === 'main') {
      commit(setPrimitive(internal, id, key, value));
    } else {
      const fi = found.floatingIndex;
      setFloating((arr) => {
        const out = arr.slice();
        out[fi] = { ...out[fi], blocks: setPrimitive(out[fi].blocks, id, key, value) };
        return out;
      });
    }
  };

  // ── Clipboard / context menu ────────────────────────────────────────────
  const writeClipboard = (block) => {
    const snapshot = JSON.parse(JSON.stringify(block));
    setClipboard(snapshot);
    try { localStorage.setItem('mbot.blockClipboard', JSON.stringify(snapshot)); } catch {}
  };

  const openContextMenu = (e, blockId) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, blockId });
  };
  const closeContextMenu = () => setContextMenu(null);

  // Dismiss context menu on any click/scroll/escape
  useEffect(() => {
    if (!contextMenu) return;
    const onDown = (e) => {
      // Let clicks inside the menu fire their handlers first
      if (e.target.closest && e.target.closest('.se-ctxmenu')) return;
      closeContextMenu();
    };
    const onKey = (e) => { if (e.key === 'Escape') closeContextMenu(); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', closeContextMenu, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', closeContextMenu, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [contextMenu]);

  const handleCopy = (id) => {
    const found = findAnywhere(id);
    if (!found) return;
    writeClipboard(found.loc.block);
    closeContextMenu();
  };

  const handleCut = (id) => {
    const found = findAnywhere(id);
    if (!found) return;
    writeClipboard(found.loc.block);
    const r = removeAnywhere(id);
    if (r) r.applyRemoval();
    if (editingId === id) setEditingId(null);
    closeContextMenu();
  };

  const handleDelete = (id) => {
    const r = removeAnywhere(id);
    if (r) r.applyRemoval();
    if (editingId === id) setEditingId(null);
    closeContextMenu();
  };

  /**
   * Paste the clipboard relative to a target block (or at top-end if no target).
   * - Reporter clipboard: only valid if the clipboard is a reporter/predicate AND we have no
   *   meaningful insertion site → fall back to wrapping in `set_variable` for visibility.
   *   Simplest: if clipboard is a reporter and target is a block, append a new `set_variable`
   *   bound to that reporter so the kid sees it on the canvas.
   * - Statement clipboard: insert as next sibling of the target, or at end of top.
   */
  const handlePaste = (targetId) => {
    if (!clipboard) return;
    const fresh = reassignIds(JSON.parse(JSON.stringify(clipboard)));
    const def = BLOCK_DEFS[fresh.type];
    const isReporterClip = def && (def.shape === 'reporter' || def.shape === 'predicate');

    if (isReporterClip) {
      // Wrap reporter in a set_variable so it has a place on the stack
      const wrapper = {
        type: 'set_variable',
        _id: genId(),
        name: 'pasted',
        value: fresh,
      };
      pasteAsSibling(wrapper, targetId);
      closeContextMenu();
      return;
    }

    pasteAsSibling(fresh, targetId);
    closeContextMenu();
  };

  const pasteAsSibling = (block, targetId) => {
    if (!targetId) {
      commit([...internal, block]);
      return;
    }
    const found = findAnywhere(targetId);
    if (!found) {
      commit([...internal, block]);
      return;
    }
    const insertSibling = (blocks) => {
      if (found.loc.container === 'top') {
        const out = cloneTree(blocks);
        out.splice(found.loc.index + 1, 0, block);
        return out;
      }
      if (found.loc.container === 'arr') {
        const out = cloneTree(blocks);
        const parentLoc = findById(out, found.loc.parent._id);
        parentLoc.block[found.loc.key].splice(found.loc.index + 1, 0, block);
        return out;
      }
      // Reporter slot — paste as a new top-level block instead
      return [...blocks, block];
    };
    if (found.source === 'main') {
      commit(insertSibling(internal));
    } else {
      const fi = found.floatingIndex;
      setFloating((arr) => {
        const out = arr.slice();
        out[fi] = { ...out[fi], blocks: insertSibling(out[fi].blocks) };
        return out;
      });
    }
  };

  // Keyboard shortcuts: when a block is selected (editingId), Ctrl+C/X/V/D and Delete work.
  useEffect(() => {
    const onKey = (e) => {
      if (!editingId) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (ctrl && k === 'c') { e.preventDefault(); handleCopy(editingId); }
      else if (ctrl && k === 'x') { e.preventDefault(); handleCut(editingId); }
      else if (ctrl && k === 'v') { e.preventDefault(); handlePaste(editingId); }
      else if (ctrl && k === 'd') { e.preventDefault(); handleDuplicate(editingId); }
      else if (e.key === 'Delete') { e.preventDefault(); handleDelete(editingId); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ── Zoom ────────────────────────────────────────────────────────────────
  const zoomIn = () => setZoom((z) => Math.min(2, +(z + 0.1).toFixed(2)));
  const zoomOut = () => setZoom((z) => Math.max(0.4, +(z - 0.1).toFixed(2)));
  const zoomReset = () => setZoom(1);
  const onCanvasWheel = (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom((z) => Math.max(0.4, Math.min(2, +(z + (e.deltaY < 0 ? 0.1 : -0.1)).toFixed(2))));
  };

  const canvasRef = useRef(null);
  const totalCount = useMemo(
    () => countAll(internal) + floating.reduce((n, s) => n + countAll(s.blocks), 0),
    [internal, floating]
  );

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="scratch-editor">
      <div className="se-cats">
        {CATEGORIES.map((c) => (
          <button key={c.id} className={`se-cat ${activeCat === c.id ? 'active' : ''}`}
            onClick={() => setActiveCat(c.id)} style={{ '--cat': c.color }} title={c.label}>
            <span className="se-cat-dot" style={{ background: c.color }}>{c.dot}</span>
            <span className="se-cat-label">{c.label}</span>
          </button>
        ))}
        {hardwareItems.length > 0 && (
          <button className={`se-cat ${activeCat === 'my_robot' ? 'active' : ''}`}
            onClick={() => setActiveCat('my_robot')} style={{ '--cat': '#0fbd8c' }}>
            <span className="se-cat-dot" style={{ background: '#0fbd8c' }}>🤖</span>
            <span className="se-cat-label">My Robot</span>
          </button>
        )}
      </div>

      <div className="se-palette">
        <div className="se-palette-title">{activeCat === 'my_robot' ? 'My Robot' : (CATEGORIES.find(c => c.id === activeCat)?.label || '')}</div>
        <div className="se-palette-list">
          {activeCat === 'my_robot'
            ? hardwareItems.map((it) => (
                <PaletteCustom key={it.id} item={it} onDragStart={(e) => startDragCustomBlock(e, it.block)} onDragEnd={endDrag} />
              ))
            : Object.entries(BLOCK_DEFS)
                .filter(([, def]) => def.cat === activeCat && !def.hidden)
                .map(([type, def]) => (
                  <PaletteEntry
                    key={type}
                    type={type}
                    def={def}
                    onDragStart={(e) => startDragNew(e, type)}
                    onDragEnd={endDrag}
                  />
                ))}
        </div>
      </div>

      <div className="se-canvas-wrap">
        <div className="se-canvas-toolbar">
          <span className="se-count">{totalCount} block{totalCount !== 1 ? 's' : ''}</span>
          <div className="se-zoom">
            <button onClick={zoomOut} title="Zoom out">−</button>
            <span className="se-zoom-pct" onClick={zoomReset}>{Math.round(zoom * 100)}%</span>
            <button onClick={zoomIn} title="Zoom in">+</button>
            <button onClick={zoomReset} title="Reset zoom">⟲</button>
          </div>
          <button className="btn-small btn-secondary" onClick={handleClearAll}>🗑️ Clear All</button>
        </div>

        <div
          ref={canvasRef}
          className="se-canvas"
          onWheel={onCanvasWheel}
          onDragOver={(e) => {
            // Allow palette drops anywhere on the canvas (not just slots).
            // Allow drops anywhere on the canvas (palette → free, existing
            // block → detach as floating). The snap detector still steers
            // releases near a slot into a connection.
            if (dragRef.current) e.preventDefault();
          }}
          onDrop={(e) => dropOnCanvas(e)}
        >
          <div className="se-canvas-board" style={{ transform: `scale(${zoom})`, transformOrigin: 'top left' }}>
            {/* Main script (always present, contains the hat). Position is
                draggable but it is the script whose blocks get sent to the
                robot when Run is clicked. */}
            <div
              className="se-script main"
              style={{ left: mainPos.x, top: mainPos.y }}
            >
              <div
                className="se-block-shape hat"
                style={{ '--cat': '#ffab19', color: '#3a2700', cursor: 'grab' }}
                onPointerDown={(e) => onScriptHandlePointerDown(e, 'main')}
                title="Drag to move this script. This script runs when you click Run."
              >
                <span className="se-block-icon">🏁</span>
                <span className="se-block-text">when program starts</span>
              </div>

              <ArrSlot kind="top" index={0} scriptId="main"
                dropHint={dropHint} setDropHint={setDropHint}
                onDrop={dropOnArrSlot} draggingExisting={draggingExisting} />

              {internal.map((block, idx) => (
                <React.Fragment key={block._id}>
                  <BlockNode
                    block={block}
                    topIndex={idx}
                    parentId={null}
                    scriptId="main"
                    ctx={{ editingId, setEditingId, dropHint, setDropHint,
                      dropOnArrSlot, dropOnReporterSlot,
                      startDragExisting, endDrag,
                      handleDuplicate, handleSetPrimitive,
                      openContextMenu,
                      draggingExisting,
                    }}
                  />
                  <ArrSlot kind="top" index={idx + 1} scriptId="main"
                    dropHint={dropHint} setDropHint={setDropHint}
                    onDrop={dropOnArrSlot} draggingExisting={draggingExisting} />
                </React.Fragment>
              ))}
            </div>

            {/* Floating (disconnected) scripts — placed anywhere on the canvas.
                Faded slightly so the user knows they're inert (won't run). */}
            {floating.map((s, fIdx) => {
              const scriptId = `float:${fIdx}`;
              return (
                <div
                  key={s.id}
                  className="se-script floating"
                  style={{ left: s.x, top: s.y }}
                  title="This script is not connected to the start hat — it will not run."
                >
                  <div
                    className="se-script-grip"
                    onPointerDown={(e) => onScriptHandlePointerDown(e, s.id)}
                    title="Drag to move this script"
                  />
                  <ArrSlot kind="top" index={0} scriptId={scriptId}
                    dropHint={dropHint} setDropHint={setDropHint}
                    onDrop={dropOnArrSlot} draggingExisting={draggingExisting} />
                  {s.blocks.map((block, idx) => (
                    <React.Fragment key={block._id}>
                      <BlockNode
                        block={block}
                        topIndex={idx}
                        parentId={null}
                        scriptId={scriptId}
                        ctx={{ editingId, setEditingId, dropHint, setDropHint,
                          dropOnArrSlot, dropOnReporterSlot,
                          startDragExisting, endDrag,
                          handleDuplicate, handleSetPrimitive,
                          openContextMenu,
                          draggingExisting,
                        }}
                      />
                      <ArrSlot kind="top" index={idx + 1} scriptId={scriptId}
                        dropHint={dropHint} setDropHint={setDropHint}
                        onDrop={dropOnArrSlot} draggingExisting={draggingExisting} />
                    </React.Fragment>
                  ))}
                </div>
              );
            })}

            {internal.length === 0 && floating.length === 0 && (
              <div className="se-empty-hint" style={{ position: 'absolute', left: 24, top: 88 }}>
                Drag blocks here from the palette ←
                <br />or describe what your robot should do in the chat.
              </div>
            )}
          </div>

          <div className={`se-trash ${draggingExisting ? 'visible' : ''}`}
            onDragOver={(e) => { e.preventDefault(); }} onDrop={dropOnTrash}>🗑️</div>
        </div>
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          hasClipboard={!!clipboard}
          clipboardLabel={clipboard ? (BLOCK_DEFS[clipboard.type]?.label || clipboard.type) : null}
          onCopy={() => handleCopy(contextMenu.blockId)}
          onCut={() => handleCut(contextMenu.blockId)}
          onPaste={() => handlePaste(contextMenu.blockId)}
          onDuplicate={() => { handleDuplicate(contextMenu.blockId); closeContextMenu(); }}
          onDelete={() => handleDelete(contextMenu.blockId)}
        />
      )}
    </div>
  );
}

function ContextMenu({ x, y, hasClipboard, clipboardLabel, onCopy, onCut, onPaste, onDuplicate, onDelete }) {
  // Clamp to viewport so the menu never escapes the screen edge.
  const W = 200, H = 240;
  const left = Math.min(x, window.innerWidth - W - 8);
  const top = Math.min(y, window.innerHeight - H - 8);
  return (
    <div className="se-ctxmenu" style={{ left, top }} onContextMenu={(e) => e.preventDefault()}>
      <button className="se-ctxitem" onClick={onCopy}><span>📋</span> Copy<kbd>Ctrl+C</kbd></button>
      <button className="se-ctxitem" onClick={onCut}><span>✂️</span> Cut<kbd>Ctrl+X</kbd></button>
      <button className="se-ctxitem" onClick={onPaste} disabled={!hasClipboard}>
        <span>📌</span> Paste{clipboardLabel ? ` “${clipboardLabel}”` : ''}<kbd>Ctrl+V</kbd>
      </button>
      <div className="se-ctxsep" />
      <button className="se-ctxitem" onClick={onDuplicate}><span>📄</span> Duplicate<kbd>Ctrl+D</kbd></button>
      <div className="se-ctxsep" />
      <button className="se-ctxitem danger" onClick={onDelete}><span>🗑️</span> Delete<kbd>Del</kbd></button>
    </div>
  );
}

function adjustTargetAfterRemoval(target, removedLoc) {
  if (target.kind === 'top' && removedLoc.container === 'top') {
    return removedLoc.index < target.index ? { ...target, index: target.index - 1 } : target;
  }
  if (target.kind === 'mouth' && removedLoc.container === 'arr'
      && removedLoc.parent && removedLoc.parent._id === target.parentId
      && removedLoc.key === target.mouthKey
      && removedLoc.index < target.index) {
    return { ...target, index: target.index - 1 };
  }
  return target;
}

function reassignIds(b) {
  if (!b || typeof b !== 'object' || !b.type) return b;
  b._id = genId();
  for (const k of ['then','else','do']) {
    if (Array.isArray(b[k])) b[k].forEach(reassignIds);
  }
  for (const k of Object.keys(b)) {
    if (['_id','type','then','else','do'].includes(k)) continue;
    const v = b[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.type === 'string') reassignIds(v);
  }
  return b;
}

function countAll(blocks) {
  let n = 0;
  for (const b of blocks || []) {
    n++;
    for (const k of ['then','else','do']) if (Array.isArray(b[k])) n += countAll(b[k]);
  }
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────
// Palette tiles
// ─────────────────────────────────────────────────────────────────────────────

function PaletteEntry({ type, def, onDragStart, onDragEnd }) {
  const color = CAT_COLOR[def.cat] || '#888';
  if (def.shape === 'reporter' || def.shape === 'predicate') {
    return (
      <div className={`se-block-shape ${def.shape} palette`} style={{ '--cat': color }}
        draggable onDragStart={onDragStart} onDragEnd={onDragEnd}>
        <ReporterPreview type={type} def={def} />
      </div>
    );
  }
  // Pick the most-relevant slot to show as an inline input preview.
  // Boolean slots render as a tiny hexagon placeholder; everything else as
  // a rounded oval with the default value.
  const previewSlots = (def.slots || []).slice(0, 2);
  return (
    <div className={`se-block-shape ${def.shape} palette`} style={{ '--cat': color }}
      draggable onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <div className="se-block-row">
        {def.icon && <span className="se-block-icon">{def.icon}</span>}
        <span className="se-block-text">{def.label}</span>
        {previewSlots.map((s) => (
          <span
            key={s.key}
            className={`se-slot-preview ${s.kind === BOOL ? 'bool' : 'val'}`}
          >
            {s.kind === BOOL ? '' : (s.default !== undefined ? String(s.default) : (s.label || s.key))}
          </span>
        ))}
      </div>
      {def.shape === 'c' && <div className="se-mouth" />}
      {def.shape === 'e' && (
        <>
          <div className="se-mouth" />
          <div className="se-mouth-divider">else</div>
          <div className="se-mouth" />
        </>
      )}
    </div>
  );
}

function PaletteCustom({ item, onDragStart, onDragEnd }) {
  return (
    <div className="se-block-shape stack palette" style={{ '--cat': CAT_COLOR.hardware }}
      draggable onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <div className="se-block-row">
        <span className="se-block-icon">{item.icon}</span>
        <span className="se-block-text">{item.label}</span>
      </div>
    </div>
  );
}

function ReporterPreview({ type, def }) {
  return (
    <div className="se-rep-row">
      {def.icon && <span className="se-rep-icon">{def.icon}</span>}
      {def.label && <span className="se-rep-label">{def.label}</span>}
      {def.slots && def.slots.map((s, i) => (
        <React.Fragment key={s.key}>
          {def.infix && i > 0 && <span className="se-rep-infix">{def.infix}</span>}
          {s.prefix && <span className="se-rep-prefix">{s.prefix}</span>}
          <span className={`se-rep-slot ${s.kind === BOOL ? 'bool' : 'val'}`}>
            {s.kind === BOOL ? '' : (s.default ?? '')}
          </span>
        </React.Fragment>
      ))}
      {def.infix && def.slots?.length === 1 && <span className="se-rep-infix">{def.infix}</span>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Workspace block rendering
// ─────────────────────────────────────────────────────────────────────────────

function BlockNode({ block, topIndex, parentId, scriptId, ctx }) {
  const def = BLOCK_DEFS[block.type] || { cat: 'movement', shape: 'stack', icon: '❓', label: block.type };
  const color = CAT_COLOR[def.cat] || '#64748b';
  const isEditing = ctx.editingId === block._id;

  const renderMouth = (mouth) => {
    const arr = Array.isArray(block[mouth.key]) ? block[mouth.key] : [];
    return (
      <div className="se-mouth" key={mouth.key}>
        {mouth.label && <div className="se-mouth-label">{mouth.label}</div>}
        <ArrSlot kind="mouth" parentId={block._id} mouthKey={mouth.key} index={0} scriptId={scriptId}
          dropHint={ctx.dropHint} setDropHint={ctx.setDropHint}
          onDrop={ctx.dropOnArrSlot} draggingExisting={ctx.draggingExisting} inset />
        {arr.map((nb, i) => (
          <React.Fragment key={nb._id}>
            <BlockNode block={nb} parentId={block._id} scriptId={scriptId} ctx={ctx} />
            <ArrSlot kind="mouth" parentId={block._id} mouthKey={mouth.key} index={i + 1} scriptId={scriptId}
              dropHint={ctx.dropHint} setDropHint={ctx.setDropHint}
              onDrop={ctx.dropOnArrSlot} draggingExisting={ctx.draggingExisting} inset />
          </React.Fragment>
        ))}
      </div>
    );
  };

  const isCE = def.shape === 'c' || def.shape === 'e';

  return (
    <div className={`se-block-shape ${def.shape} ${isEditing ? 'editing' : ''}`} style={{ '--cat': color }}
      draggable onDragStart={(e) => ctx.startDragExisting(e, block._id)} onDragEnd={ctx.endDrag}
      onContextMenu={(e) => ctx.openContextMenu && ctx.openContextMenu(e, block._id)}>
      <div className="se-block-row" onClick={() => ctx.setEditingId(isEditing ? null : block._id)}>
        {def.icon && <span className="se-block-icon">{def.icon}</span>}
        <span className="se-block-text">{def.label}</span>

        {def.slots && def.slots.map((s) => (
          <SlotInline
            key={s.key}
            slot={s}
            value={block[s.key]}
            parentId={block._id}
            ctx={ctx}
          />
        ))}

        <span className="se-block-actions" onClick={(e) => e.stopPropagation()}>
          <button className="se-iconbtn" title="Duplicate" onClick={() => ctx.handleDuplicate(block._id)}>📋</button>
        </span>
      </div>

      {isCE && def.mouths && def.mouths.map((m, i) => (
        <React.Fragment key={m.key}>
          {i > 0 && <div className="se-mouth-divider" style={{ background: color }}>{m.key}</div>}
          {renderMouth(m)}
        </React.Fragment>
      ))}
    </div>
  );
}

/** Render a slot's inline UI:
 *   - if value is a reporter object → render the reporter block inline, dragable
 *   - else render the literal control (number / text / select / range) inside the slot oval
 *   - boolean slots accept only a hexagon predicate; show empty hex placeholder otherwise
 */
function SlotInline({ slot, value, parentId, ctx }) {
  const onDragOver = (e) => {
    if (!isReporterDrag(ctx)) return;
    e.preventDefault();
    e.stopPropagation();
    ctx.setDropHint({ kind: 'reporter', parentId, key: slot.key });
  };
  const onDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    ctx.dropOnReporterSlot(parentId, slot.key, slot.kind);
  };
  const active = ctx.dropHint?.kind === 'reporter' && ctx.dropHint.parentId === parentId && ctx.dropHint.key === slot.key;

  if (slot.label && !slot.inline) {
    // Stack-block slot with explicit label (e.g. "speed")
    return (
      <span className="se-slot-pair">
        <span className="se-slot-label">{slot.label}</span>
        <SlotBody slot={slot} value={value} parentId={parentId} ctx={ctx}
          onDragOver={onDragOver} onDrop={onDrop} active={active} />
      </span>
    );
  }
  // Inline (reporter args, or stack slots with prefix)
  return (
    <>
      {slot.prefix && <span className="se-rep-prefix">{slot.prefix}</span>}
      <SlotBody slot={slot} value={value} parentId={parentId} ctx={ctx}
        onDragOver={onDragOver} onDrop={onDrop} active={active} />
    </>
  );
}

function SlotBody({ slot, value, parentId, ctx, onDragOver, onDrop, active }) {
  const dataProps = {
    'data-reporter-slot': '1',
    'data-target-parent': parentId,
    'data-target-key': slot.key,
    'data-target-kind': slot.kind === BOOL ? 'bool' : 'val',
  };
  // Reporter occupant
  if (isReporter(value)) {
    return (
      <span className={`se-slot-host ${slot.kind === BOOL ? 'bool' : 'val'} ${active ? 'active' : ''}`}
        {...dataProps}
        onDragOver={onDragOver} onDrop={onDrop}
        onDragLeave={() => ctx.setDropHint(null)}>
        <BlockNode block={value} parentId={parentId} ctx={ctx} />
      </span>
    );
  }
  // Boolean empty slot — drop only
  if (slot.kind === BOOL) {
    return (
      <span className={`se-slot-host bool empty ${active ? 'active' : ''}`}
        {...dataProps}
        onDragOver={onDragOver} onDrop={onDrop} onDragLeave={() => ctx.setDropHint(null)} />
    );
  }
  // Primitive control inside slot oval
  return (
    <span className={`se-slot-host val ${active ? 'active' : ''}`}
      {...dataProps}
      onDragOver={onDragOver} onDrop={onDrop} onDragLeave={() => ctx.setDropHint(null)}>
      <PrimitiveInput slot={slot} value={value} onChange={(v) => ctx.handleSetPrimitive(parentId, slot.key, v)} />
    </span>
  );
}

function PrimitiveInput({ slot, value, onChange }) {
  const v = value === undefined || value === null ? (slot.default ?? '') : value;
  if (slot.control === 'select') {
    return (
      <select className="se-prim" value={v} onChange={(e) => onChange(e.target.value)} onClick={(e) => e.stopPropagation()}>
        {slot.options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  if (slot.control === 'number' || slot.control === 'range') {
    return (
      <input type="number" className="se-prim num" min={slot.min} max={slot.max} step={slot.step}
        value={v} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        onClick={(e) => e.stopPropagation()} />
    );
  }
  // text
  return (
    <input type="text" className="se-prim txt" value={v}
      onChange={(e) => onChange(e.target.value)} onClick={(e) => e.stopPropagation()} />
  );
}

function isReporterDrag(ctx) {
  return ctx.draggingExisting || true; // we accept drops; type-check at drop time
}

// ─────────────────────────────────────────────────────────────────────────────
// Array drop slot (between/inside stack chains and mouths)
// ─────────────────────────────────────────────────────────────────────────────

function ArrSlot({ kind, parentId, mouthKey, index, scriptId, dropHint, setDropHint, onDrop, draggingExisting, inset }) {
  const target = kind === 'top'
    ? { kind: 'top', index, scriptId }
    : { kind: 'mouth', parentId, mouthKey, index, scriptId };
  const active = dropHint && dropHint.kind === 'arr'
    && dropHint.target.kind === target.kind
    && dropHint.target.scriptId === target.scriptId
    && (target.kind === 'top'
      ? dropHint.target.index === target.index
      : dropHint.target.parentId === target.parentId && dropHint.target.mouthKey === target.mouthKey && dropHint.target.index === target.index);

  return (
    <div
      className={`se-slot ${active ? 'active' : ''} ${inset ? 'inset' : ''}`}
      data-arr-slot="1"
      data-target-kind={target.kind}
      data-target-script={target.scriptId || ''}
      data-target-parent={target.parentId || ''}
      data-target-mouth={target.mouthKey || ''}
      data-target-index={target.index}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDropHint({ kind: 'arr', target }); }}
      onDragLeave={() => setDropHint(null)}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); onDrop(target); }}
    />
  );
}
