/** Program palette metadata, not execution admission or saved-program migration. */
export const AV_PROGRAM_BUILD = 'mbot-av-control-v1';

const FLAT_TYPES = new Set([
  'move_forward', 'move_backward', 'turn_left', 'turn_right', 'dc_motor', 'servo',
  'wait', 'stop', 'display_text', 'set_led', 'play_tone', 'play_sound',
  'set_volume', 'stop_sound', 'display_animation',
]);

// Every catalog type has a reviewed classification. A lowering candidate is not
// enabled until the caller supplies the server's verified loweredTypes subset.
const GROUPS = [
  { types: [...FLAT_TYPES], mode: 'flat',
    reason: 'Supported with bounded literal parameters; Run still validates the program and motion arming.' },
  { types: ['repeat'], mode: 'server-lowered',
    reason: 'Server lowers a finite repeat count into a bounded flat program; expansion and payload limits still apply.' },
  { types: ['set_variable', 'change_variable', 'var_get'], mode: 'server-lowered',
    reason: 'Server resolves compile-time variables in order. Values cannot depend on live sensors; undefined reads are rejected.' },
  { types: ['if_predicate', 'if_else_predicate'], mode: 'server-lowered',
    reason: 'Server selects a branch using a literal or statically resolved condition, never a live sensor snapshot.' },
  { types: ['op_add', 'op_sub', 'op_mul', 'op_div', 'op_mod', 'op_round', 'op_abs',
    'op_function', 'op_join', 'op_letter', 'op_length', 'op_gt', 'op_lt', 'op_eq',
    'op_and', 'op_or', 'op_not', 'op_contains'], mode: 'server-lowered',
    reason: 'Server resolves supported static expressions in slots; finite values, valid operands and bounded expression depth are required.' },
  { types: ['sensor_distance', 'sensor_line', 'sensor_brightness', 'sensor_loudness',
    'sensor_angle', 'sensor_pitch', 'sensor_roll', 'sensor_timer', 'sensor_button_pressed',
    'sensor_obstacle_close', 'sensor_is_shaking', 'sensor_is_upside_down', 'sensor_is_tilted',
    'sensor_battery', 'sensor_wifi_connected', 'if_obstacle', 'if_line', 'if_color',
    'if_sensor_range', 'if_button', 'display_value'], mode: 'requires-runtime',
    reason: 'Requires live sensor evaluation on the robot. On-demand telemetry snapshots cannot supply Program expressions or conditions.' },
  { types: ['repeat_forever', 'repeat_until', 'wait_until', 'while_block', 'while_sensor', 'move_until'],
    mode: 'requires-runtime',
    reason: 'Requires on-device dynamic control flow; indefinite loops and sensor-dependent waiting cannot be lowered to a bounded flat program.' },
  { types: ['set_speed'], mode: 'requires-runtime',
    reason: 'Independent continuous wheel speeds have no equivalent bounded straight-line command in the installed runtime.' },
  { types: ['stop_all'], mode: 'requires-runtime',
    reason: 'Whole-script termination is not an in-program motor stop. Use the emergency Stop control to cancel a running program.' },
  { types: ['op_random'], mode: 'requires-runtime',
    reason: 'Random values require runtime evaluation; precomputing a value would change execution semantics.' },
  { types: ['play_melody'], mode: 'requires-runtime',
    reason: 'No verified melody-to-tone score lowering exists. Use bounded play tone or a supported built-in sound.' },
  { types: ['display_image', 'led_effect'], mode: 'requires-runtime',
    reason: 'Requires image or LED-effect support not provided by the installed AV Program runtime.' },
  { types: ['say'], mode: 'server-lowered',
    reason: 'Shows a centered text label on the LCD; this is not spoken speech.' },
];
export const PROGRAM_BLOCK_INVENTORY = Object.freeze(Object.fromEntries(
  GROUPS.flatMap(({ types, mode, reason }) => types.map(type => [type, Object.freeze({ mode, reason })])),
));

/** Type-level guidance only: Run must still validate values, budgets and arming. */
export function getProgramBlockCapability(type, runtimeStatus, { loweredTypes = [] } = {}) {
  if (runtimeStatus?.build !== AV_PROGRAM_BUILD) {
    return { status: 'unknown', supported: false,
      reason: 'Runtime support is unverified. The full legacy catalog remains available for editing.' };
  }
  if (FLAT_TYPES.has(type)) {
    if (!Array.isArray(runtimeStatus.capabilities) || !runtimeStatus.capabilities.includes(type)) {
      return { status: 'requires-runtime', supported: false,
        reason: 'The connected runtime does not advertise this Program command.' };
    }
    return { status: 'supported', supported: true,
      reason: 'Supported with bounded literal parameters; Run still validates the program and motion arming.' };
  }
  const entry = Object.hasOwn(PROGRAM_BLOCK_INVENTORY, type) ? PROGRAM_BLOCK_INVENTORY[type] : null;
  if (entry?.mode === 'server-lowered') {
    const enabled = Array.isArray(loweredTypes) && loweredTypes.includes(type);
    return { status: enabled ? 'server-lowered' : 'requires-runtime', supported: enabled,
      reason: enabled ? entry.reason : `Requires verified server lowering. ${entry.reason}` };
  }
  return { status: 'requires-runtime', supported: false,
    reason: entry?.reason || (['read_sensors', 'status'].includes(type)
      ? 'Command-only telemetry request; not a Program statement. Use the Live Control refresh/status controls.'
      : 'Requires runtime support not available in the installed AV Program interpreter.') };
}

/** Palette rows only. Never use this filtered list to hydrate a saved workspace. */
export function getProgramPalette(catalog, runtimeStatus, { includeUnavailable = false, loweredTypes = [] } = {}) {
  return Object.entries(catalog)
    .filter(([, definition]) => !definition.hidden)
    .map(([type, definition]) => ({
      type,
      definition: getProgramBlockDefinition(type, definition, runtimeStatus),
      capability: getProgramBlockCapability(type, runtimeStatus, { loweredTypes }),
    }))
    .filter(({ capability }) => includeUnavailable || capability.supported || capability.status === 'unknown');
}

/** Resolve controls/defaults only. Never pass stored block values for rewriting. */
export function getProgramBlockDefinition(type, definition, runtimeStatus) {
  if (runtimeStatus?.build !== AV_PROGRAM_BUILD || !definition?.av) return definition;
  const { slots: overrides = {}, ...properties } = definition.av;
  const slots = (definition.slots || [])
    .filter(slot => overrides[slot.key] !== null)
    .map(slot => ({ ...slot, ...overrides[slot.key] }));
  for (const [key, override] of Object.entries(overrides)) {
    if (override && !(definition.slots || []).some(slot => slot.key === key)) {
      slots.push({ ...override, key });
    }
  }
  return { ...definition, ...properties, slots };
}
