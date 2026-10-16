// Fixed, server-owned profiles. Never consume device/HTTP supplied numeric limits.
const common = { nodes: 256, depth: 8, sourceBytes: 65536, requestedHoldSeconds: 120,
  uniqueCommands: 32, wireBytes: 8192, animationSeconds: 12 };
export const LEGACY_PROGRAM_PROFILE = Object.freeze({ encoding: 'flat', limits: Object.freeze({ ...common,
  repeat: 50, iterations: 256, instructions: 32, evaluations: 4096, observationTimeoutMs: 120000 }) });
export const INDEXED_PROGRAM_PROFILE = Object.freeze({ encoding: 'indexed-v1', limits: Object.freeze({ ...common,
  repeat: 1024, iterations: 4096, instructions: 1024, evaluations: 32768,
  sourceIdBytes: 128, sourceMapBytes: 262144, observationTimeoutMs: 315000 }) });
const DEFAULTS = {
  move_forward: { speed: 20, duration: 1 }, move_backward: { speed: 20, duration: 1 },
  dc_motor: { speed: 20, duration: 1 }, servo: { angle: 90, speed: 0 },
  turn_left: { angle: 0 }, turn_right: { angle: 0 }, wait: { duration: 1 },
  display_text: { size: 16 }, play_tone: { frequency: 440, duration: 0.5 },
};
const TIMED = new Set(['wait', 'move_forward', 'move_backward', 'dc_motor', 'play_tone', 'play_recording']);

const FIELDS = {
  move_forward: ['speed', 'duration'], move_backward: ['speed', 'duration'],
  dc_motor: ['port', 'speed', 'duration'], servo: ['port', 'angle', 'speed'],
  turn_left: ['angle'], turn_right: ['angle'], wait: ['duration'], stop: [],
  display_text: ['text', 'size'], set_led: ['color'], play_tone: ['frequency', 'duration'],
  play_sound: ['sound'], set_volume: ['volume'], stop_sound: [], display_animation: ['frames', 'interval'],
  play_recording: ['recording', 'duration'],
};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function invalid(message) {
  throw Object.assign(new Error(message), { status: 400, code: 'PROGRAM_INVALID' });
}

// Match robot_control.validate defaults. Validate BEFORE stripping only _id and
// per-command run_id; unknown/behavioral fields must never silently disappear.
function normalize(block, dictionary = false) {
  if (!object(block) || !Object.hasOwn(FIELDS, block.type)) invalid('Unsupported Program primitive');
  const fields = FIELDS[block.type];
  if (dictionary && (block.type === 'display_animation' ||
      Object.keys(block).some(key => !['type', ...fields].includes(key)))) invalid('Indexed dictionary requires primitives without metadata or wrappers');
  if (Object.hasOwn(block, '_id') && typeof block._id !== 'string') invalid('Invalid _id');
  if (Object.hasOwn(block, 'run_id') && (typeof block.run_id !== 'string' || [...block.run_id].length > 128)) invalid('Invalid run_id');
  let params = block;
  if (Object.hasOwn(block, 'params')) {
    if (!object(block.params) || Object.keys(block).some(key => !['type', '_id', 'run_id', 'params'].includes(key)) ||
        Object.keys(block.params).some(key => !fields.includes(key))) invalid('Invalid Program params wrapper');
    params = block.params;
  } else if (Object.keys(block).some(key => !['type', '_id', 'run_id', ...fields].includes(key))) invalid(`Unknown ${block.type} parameter`);
  const values = { ...DEFAULTS[block.type] };
  for (const key of fields) if (Object.hasOwn(params, key)) values[key] = params[key];
  const bounded = (key, low, high) => {
    if (typeof values[key] !== 'number' || !Number.isFinite(values[key]) || values[key] < low || values[key] > high) invalid(`Program ${block.type} ${key} must be a number in ${low}..${high}`);
  };
  const text = value => typeof value === 'string' && [...value].length <= 128;
  if (['move_forward', 'move_backward', 'dc_motor'].includes(block.type)) {
    bounded('speed', block.type === 'dc_motor' ? -100 : 0, 100); bounded('duration', 0, 5);
  }
  if (block.type === 'dc_motor' && !['M1', 'M2', 'M3', 'M4'].includes(values.port)) invalid('Invalid DC port');
  if (block.type === 'servo') {
    if (!['S1', 'S2', 'S3', 'S4'].includes(values.port)) invalid('Invalid servo port');
    bounded('angle', 0, 180); bounded('speed', 0, 0);
  }
  if (['turn_left', 'turn_right'].includes(block.type)) bounded('angle', 0, 360);
  if (block.type === 'wait') bounded('duration', 0, 60);
  if (block.type === 'play_tone') { bounded('frequency', 100, 2000); bounded('duration', 0, 2); }
  if (block.type === 'display_text') {
    if (!text(values.text)) invalid('Program text must be a literal up to 128 characters');
    bounded('size', 8, 32);
  }
  if (block.type === 'display_animation') {
    if (!Array.isArray(values.frames) || values.frames.length < 1 || values.frames.length > 12 || values.frames.some(frame => !text(frame))) invalid('Animation requires 1..12 literal frames');
    if (!Object.hasOwn(values, 'interval')) values.interval = 0.5;
    bounded('interval', 0.15, 2);
  }
  if (block.type === 'play_sound' && !['hello', 'beeps', 'laugh', 'score'].includes(values.sound)) invalid('Unsupported AV sound');
  if (block.type === 'play_recording' && (typeof values.recording !== 'string' || !/^[0-9a-f]{64}$/.test(values.recording) ||
      typeof values.duration !== 'number' || !Number.isFinite(values.duration) || values.duration < 0.001 || values.duration > 3)) invalid('Invalid recording metadata');
  if (block.type === 'set_led' && !['red', 'green', 'blue', 'yellow', 'cyan', 'purple', 'white', 'orange', 'off'].includes(values.color)) invalid('Unsupported LED color');
  if (block.type === 'set_volume' && (!Number.isInteger(values.volume) || values.volume < 0 || values.volume > 60)) invalid('AV volume must be an integer in 0..60');
  const normalized = { type: block.type };
  for (const key of Object.keys(values).sort()) normalized[key] = values[key];
  return normalized;
}

/** Pure whole-plan admission/encoding. Runtime capability checks are supplied by
 * the caller and are repeated by MqttService at the actual publish boundary. */
export function encodeProgram(input, { profile, validateBlock = () => {}, runId, timestamp, sourceMap } = {}) {
  const selected = resolveProgramProfile(profile), { limits } = selected;
  if (typeof runId !== 'string' || [...runId].length > 128 || typeof timestamp !== 'number' || !Number.isFinite(timestamp)) invalid('Invalid Program envelope run_id or timestamp');
  const commands = [], indexes = [], interned = new Map();
  let requestedHoldSeconds = 0, holdCorrection = 0, animationDuration = 0, animationCorrection = 0;
  const append = (normalized, dictionaryIndex = null) => {
    if (indexes.length >= limits.instructions) invalid(`Program exceeds ${limits.instructions} expanded instructions`);
    if (dictionaryIndex === null) {
      const key = JSON.stringify(normalized);
      if (!interned.has(key)) {
        if (commands.length >= limits.uniqueCommands) invalid('Program exceeds 32 unique normalized commands');
        interned.set(key, commands.length); commands.push(normalized);
      }
      dictionaryIndex = interned.get(key);
    }
    indexes.push(dictionaryIndex);
    if (TIMED.has(normalized.type)) {
      // Compensated sum avoids rejecting a legal exact boundary through drift.
      const value = normalized.duration - holdCorrection;
      const sum = requestedHoldSeconds + value;
      holdCorrection = (sum - requestedHoldSeconds) - value;
      requestedHoldSeconds = sum;
      if (requestedHoldSeconds > limits.requestedHoldSeconds) invalid('Program requested holds exceed 120 seconds');
    }
  };
  if (Array.isArray(input)) {
    if (input.length < 1 || input.length > limits.instructions) invalid(`Program must contain 1..${limits.instructions} blocks`);
    for (const block of input) {
      if (limits.sourceIdBytes && typeof block?._id === 'string' && Buffer.byteLength(block._id, 'utf8') > limits.sourceIdBytes) invalid('Program source ID exceeds 128 UTF-8 bytes');
      validateBlock(block);
      const normalized = normalize(block);
      if (normalized.type === 'display_animation') {
        const value = normalized.frames.length * normalized.interval - animationCorrection;
        const sum = animationDuration + value;
        animationCorrection = (sum - animationDuration) - value;
        animationDuration = sum;
        if (animationDuration > limits.animationSeconds) invalid('AV total animation duration exceeds 12 seconds');
        for (const frame of normalized.frames) {
          const display = normalize({ type: 'display_text', text: frame, size: 24 });
          const wait = normalize({ type: 'wait', duration: normalized.interval });
          validateBlock(display); validateBlock(wait);
          append(display); append(wait);
        }
      } else append(normalized);
    }
  } else {
    if (selected.encoding !== 'indexed-v1') invalid('Indexed Program requires program_indexed_v1 capability');
    if (!object(input) || Object.keys(input).length !== 3 || Object.keys(input).some(key => !['format', 'commands', 'order'].includes(key)) || input.format !== 'indexed-v1') invalid('Invalid indexed-v1 Program schema');
    if (!Array.isArray(input.commands) || input.commands.length < 1 || input.commands.length > limits.uniqueCommands) invalid('Indexed dictionary requires 1..32 commands');
    if (typeof input.order !== 'string' || input.order.length < 2 || input.order.length > limits.instructions * 2 || input.order.length % 2 || !/^[0-9a-fA-F]+$/.test(input.order)) invalid('Indexed order must encode 1..1024 hexadecimal bytes');
    for (const block of input.commands) {
      const normalized = normalize(block, true);
      validateBlock(normalized); commands.push(normalized);
    }
    for (const index of Buffer.from(input.order, 'hex')) {
      if (index >= commands.length) invalid('Indexed order byte is outside command dictionary');
      append(commands[index], index);
    }
  }
  if (new Set(commands.filter(command => command.type === 'play_recording').map(command => command.recording)).size > 8) invalid('Program exceeds 8 distinct recordings');
  if (sourceMap !== undefined) validateSourceMap(sourceMap, indexes.length, selected);
  const program = selected.encoding === 'indexed-v1'
    ? { format: 'indexed-v1', commands, order: Buffer.from(indexes).toString('hex') } : input;
  const payload = JSON.stringify({ program, timestamp, run_id: runId });
  const wireBytes = Buffer.byteLength(payload, 'utf8');
  if (wireBytes > limits.wireBytes) invalid('Program MQTT payload exceeds 8192 bytes');
  return { program, payload, encoding: selected.encoding, limits,
    expandedCount: indexes.length, uniqueCount: commands.length, uniqueCommandCount: commands.length,
    requestedHoldSeconds, wireBlockCount: selected.encoding === 'indexed-v1' ? commands.length : input.length, wireBytes };
}

export function validateSourceMap(sourceMap, expandedCount, profile) {
  const { limits } = resolveProgramProfile(profile);
  if (!Array.isArray(sourceMap) || sourceMap.length !== expandedCount || sourceMap.some((source, index) =>
    !object(source) || Object.keys(source).some(key => !['sourceId', 'path', 'compiledIndex'].includes(key)) ||
    source.compiledIndex !== index || typeof source.path !== 'string' ||
    (source.sourceId !== null && typeof source.sourceId !== 'string'))) invalid('Invalid Program source map');
  if (limits.sourceIdBytes && sourceMap.some(source => typeof source.sourceId === 'string' &&
      Buffer.byteLength(source.sourceId, 'utf8') > limits.sourceIdBytes)) invalid('Program source ID exceeds 128 UTF-8 bytes');
  if (limits.sourceMapBytes && Buffer.byteLength(JSON.stringify(sourceMap), 'utf8') > limits.sourceMapBytes) invalid('Program source map exceeds 262144 bytes');
}

// Freshness/connection are supplied by MqttService, not accepted from HTTP.
export function selectProgramProfile(status) {
  return status?.application === 'cooperative-v1' && status.build === 'mbot-av-control-v1' &&
    Array.isArray(status.capabilities) && status.capabilities.includes('program_indexed_v1')
    ? INDEXED_PROGRAM_PROFILE : LEGACY_PROGRAM_PROFILE;
}

export function resolveProgramProfile(profile = LEGACY_PROGRAM_PROFILE) {
  if (profile === LEGACY_PROGRAM_PROFILE || profile === 'flat') return LEGACY_PROGRAM_PROFILE;
  if (profile === INDEXED_PROGRAM_PROFILE || profile === 'indexed-v1') return INDEXED_PROGRAM_PROFILE;
  throw Object.assign(new Error('Unknown Program profile'), { status: 400, code: 'PROGRAM_INVALID' });
}
