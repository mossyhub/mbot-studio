// Compiler for mbot-av-control-v1, not the experimental RobotEngine.
// Every branch is checked; only the selected branch contributes output/state.
export const PROGRAM_LIMITS = Object.freeze({ nodes: 256, depth: 8, repeat: 50, iterations: 256,
  instructions: 32, evaluations: 4096, sourceBytes: 65536, requestedHoldSeconds: 120 });
const FIELDS = {
  move_forward: ['speed', 'duration'], move_backward: ['speed', 'duration'],
  dc_motor: ['port', 'speed', 'duration'], servo: ['port', 'angle', 'speed'],
  turn_left: ['angle'], turn_right: ['angle'], wait: ['duration'], stop: [],
  display_text: ['text', 'size'], say: ['text'], set_led: ['color'], play_tone: ['frequency', 'duration'],
  play_sound: ['sound'], set_volume: ['volume'], stop_sound: [], display_animation: ['frames', 'interval'],
  repeat: ['times', 'do'], set_variable: ['name', 'source', 'value'], change_variable: ['name', 'by'],
  if_predicate: ['cond', 'then', 'else'], if_else_predicate: ['cond', 'then', 'else'],
};
const CONTROL_TYPES = new Set(['repeat', 'set_variable', 'change_variable', 'if_predicate', 'if_else_predicate']);
const REPORTERS = { op_add: ['a', 'b'], op_sub: ['a', 'b'], op_mul: ['a', 'b'],
  op_div: ['a', 'b'], op_mod: ['a', 'b'], op_abs: ['a'], op_round: ['a'],
  op_gt: ['a', 'b'], op_lt: ['a', 'b'], op_eq: ['a', 'b'],
  op_and: ['a', 'b'], op_or: ['a', 'b'], op_not: ['a'], var_get: ['name'] };
const NUMERIC_FIELDS = new Set(['speed', 'duration', 'angle', 'size', 'frequency', 'volume', 'interval']);
const RESERVED = new Set(('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield cyberpi mbot2 time mbuild _i').split(' '));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(message, source = {}, code = 'PROGRAM_INVALID', status = 400) {
  throw Object.assign(new Error(message), { status, code, sourceId: source.sourceId ?? null, path: source.path ?? 'program' });
}
function number(value, source) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) fail('Static numeric value must be finite and within safe precision', source);
  return value;
}
function boolean(value, source) {
  if (typeof value !== 'boolean') fail('Static condition must be boolean', source);
  return value;
}
function variableName(value, source) {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value) || RESERVED.has(value)) fail('Invalid static variable name', source);
  return value;
}

/** Pure lowering; callers must still run the installed runtime's admission. */
export function lowerProgram(input, { validateBlock = () => {} } = {}) {
  let nodes = 0;
  let iterations = 0;
  let evaluations = 0;
  let requestedHoldSeconds = 0;
  const program = [];
  const sourceMap = [];
  function step(source) {
    if (++evaluations > PROGRAM_LIMITS.evaluations) fail('Program exceeds 4096 evaluation steps', source);
  }
  function count(source, depth) {
    if (depth > PROGRAM_LIMITS.depth) fail('Program depth exceeds 8', source);
    if (++nodes > PROGRAM_LIMITS.nodes) fail('Program exceeds 256 source nodes', source);
  }
  // Build expression closures without evaluating code or fetching live values.
  function expression(value, source, depth) {
    if (!object(value)) {
      if (typeof value !== 'boolean') number(value, source);
      return () => value;
    }
    source = { sourceId: value._id ?? source.sourceId, path: source.path };
    count(source, depth);
    if (!Object.hasOwn(REPORTERS, value.type)) fail(`Unsupported Program reporter: ${value.type}`, source, 'PROGRAM_UNSUPPORTED');
    if (Object.hasOwn(value, '_id') && typeof value._id !== 'string') fail('Invalid reporter _id', source);
    const fields = REPORTERS[value.type];
    if (Object.keys(value).some(key => !['type', '_id', ...fields].includes(key))) fail('Unknown reporter parameter', source);
    if (value.type === 'var_get') {
      const name = variableName(value.name, source);
      return env => {
        if (!env.has(name)) fail(`Undefined static variable: ${name}`, source);
        return env.get(name);
      };
    }
    const args = fields.map(key => expression(value[key], { ...source, path: `${source.path}.${key}` }, depth + 1));
    return env => {
      step(source);
      // Eagerly check both operands, even a short-circuited one. Accepted boolean
      // operands have no side effects; rejecting errors here is conservative.
      const [a, b] = args.map(arg => arg(env));
      if (['op_and', 'op_or', 'op_not'].includes(value.type)) {
        boolean(a, source);
        if (value.type === 'op_not') return !a;
        boolean(b, source);
        return value.type === 'op_and' ? a && b : a || b;
      }
      number(a, source);
      if (args.length > 1) number(b, source);
      let result;
      switch (value.type) {
        case 'op_gt': return a > b;
        case 'op_lt': return a < b;
        case 'op_eq': return a === b;
        case 'op_add': result = a + b; break;
        case 'op_sub': result = a - b; break;
        case 'op_mul': result = a * b; break;
        case 'op_div':
          if (b === 0) fail('Static division by zero', source);
          result = a / b; break;
        case 'op_mod':
          if (b === 0) fail('Static modulo by zero', source);
          result = a % b;
          if (result !== 0 && Math.sign(result) !== Math.sign(b)) result += b;
          break;
        case 'op_abs': result = Math.abs(a); break;
        case 'op_round': {
          const floor = Math.floor(a);
          result = a - floor === 0.5 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(a);
          break;
        }
      }
      return number(result, source);
    };
  }
  function inspect(blocks, path, depth) {
    if (!Array.isArray(blocks)) fail('Program children must be an array', { path });
    if (depth > PROGRAM_LIMITS.depth) fail('Program depth exceeds 8', { path });
    if (blocks.length > PROGRAM_LIMITS.nodes) fail('Program exceeds 256 source nodes', { path });
    return blocks.map((block, index) => {
      const source = { sourceId: block?._id ?? null, path: `${path}[${index}]` };
      count(source, depth);
      if (!object(block) || !Object.hasOwn(FIELDS, block.type)) fail(`Unsupported Program block: ${block?.type}`, source, 'PROGRAM_UNSUPPORTED', 422);
      if (Object.hasOwn(block, '_id') && typeof block._id !== 'string') fail('Invalid _id', source);
      const original = block;
      const control = CONTROL_TYPES.has(block.type);
      const envelope = control ? ['type', '_id'] : ['type', '_id', 'run_id'];
      const wrapped = Object.hasOwn(block, 'params');
      if (wrapped) {
        if (control || !object(block.params) || Object.keys(block).some(key => ![...envelope, 'params'].includes(key)) ||
            Object.keys(block.params).some(key => !FIELDS[block.type].includes(key))) fail('Invalid Program params wrapper parameter', source);
        const { params, ...metadata } = block;
        block = { ...metadata, ...params };
      }
      if (Object.keys(block).some(key => ![...envelope, ...FIELDS[block.type]].includes(key))) fail(`Unknown ${block.type} parameter`, source);
      if (Object.hasOwn(block, 'run_id') && (typeof block.run_id !== 'string' || [...block.run_id].length > 128)) fail('Invalid run_id', source);
      const node = { block, source, values: {}, wrapped, original };
      const expr = key => expression(block[key], { ...source, path: `${source.path}${wrapped ? '.params' : ''}.${key}` }, depth + 1);
      if (block.type === 'repeat') {
        if (!Number.isInteger(block.times) || block.times < 0 || block.times > PROGRAM_LIMITS.repeat) fail('repeat times must be a literal integer in 0..50', source);
        node.children = inspect(block.do, `${source.path}.do`, depth + 1);
      } else if (['if_predicate', 'if_else_predicate'].includes(block.type)) {
        node.condition = expr('cond');
        node.then = inspect(Object.hasOwn(block, 'then') ? block.then : [], `${source.path}.then`, depth + 1);
        node.else = inspect(Object.hasOwn(block, 'else') ? block.else : [], `${source.path}.else`, depth + 1);
      } else if (['set_variable', 'change_variable'].includes(block.type)) {
        node.name = variableName(block.name, source);
        if (Object.hasOwn(block, 'source') && block.source !== 'number') fail('Variable source must be static number, not a sensor', source);
        node.value = expr(block.type === 'set_variable' ? 'value' : 'by');
      } else {
        if (block.type === 'display_animation' && (!Array.isArray(block.frames) || block.frames.length < 1 || block.frames.length > 12 || block.frames.some(frame => typeof frame !== 'string'))) fail('Animation frames must be 1..12 literal strings', source);
        for (const [key, value] of Object.entries(block)) {
          if (Array.isArray(value) && key !== 'frames') fail(`Invalid ${key} parameter array`, source);
          if (object(value)) {
            if (!NUMERIC_FIELDS.has(key)) fail(`Unsupported dynamic ${key}`, source, 'PROGRAM_UNSUPPORTED');
            node.values[key] = expr(key);
          }
        }
      }
      return node;
    });
  }
  function visit(tree, env, emit = true) {
    for (const node of tree) {
      const { block, source } = node;
      step(source);
      if (block.type === 'repeat') {
        // Zero-count bodies still undergo semantic checking, without state leaks.
        if (block.times === 0) visit(node.children, new Map(env), false);
        for (let iteration = 0; iteration < block.times; iteration++) {
          if (++iterations > PROGRAM_LIMITS.iterations) fail('Program exceeds 256 total iterations', source);
          visit(node.children, env, emit);
        }
      } else if (node.condition) {
        const condition = boolean(node.condition(env), source);
        visit(condition ? node.else : node.then, new Map(env), false);
        visit(condition ? node.then : node.else, env, emit);
      } else if (node.value) {
        const value = number(node.value(env), source);
        if (block.type === 'change_variable') {
          if (!env.has(node.name)) fail(`Undefined static variable: ${node.name}`, source);
          env.set(node.name, number(env.get(node.name) + value, source));
        } else env.set(node.name, value);
      } else {
        const lowered = { ...block };
        // code-generator.js say and robot_control.py display_text both call
        // display.show_label(text, size, 'center', index=0). Say's size is 14;
        // there is no speech, hold duration, or implicit clear operation.
        if (block.type === 'say') Object.assign(lowered, { type: 'display_text', size: 14 });
        for (const [key, evaluate] of Object.entries(node.values)) lowered[key] = number(evaluate(env), source);
        let wireBlock = lowered;
        if (node.wrapped) {
          const { type, _id, run_id, ...params } = lowered;
          const { params: originalParams, ...metadata } = node.original;
          wireBlock = { ...metadata, type, params };
        }
        try { validateBlock(wireBlock); }
        catch (error) { throw Object.assign(error, source); }
        if (!emit) continue;
        const expanded = block.type === 'display_animation' ? block.frames.length * 2 : 1;
        if (sourceMap.length + expanded > PROGRAM_LIMITS.instructions) fail('Program exceeds 32 expanded instructions', source);
        // Requested holds only: native driver overhead/turn/sound duration is
        // unknown. This is not a wall-clock deadline or a Stop guarantee.
        if (['wait', 'move_forward', 'move_backward', 'dc_motor', 'play_tone'].includes(block.type)) {
          requestedHoldSeconds += number(lowered.duration ?? (block.type === 'play_tone' ? 0.5 : 1), source);
        } else if (block.type === 'display_animation') requestedHoldSeconds += block.frames.length * number(lowered.interval ?? 0.5, source);
        if (requestedHoldSeconds > PROGRAM_LIMITS.requestedHoldSeconds) fail('Program requested holds exceed 120 seconds', source);
        program.push(wireBlock);
        for (let index = 0; index < expanded; index++) {
          sourceMap.push({ ...source, compiledIndex: sourceMap.length });
        }
      }
    }
  }
  const tree = inspect(input, 'program', 1);
  // Inspection bounds recursion and permits arrays only for known children or
  // literal frames, so serialization cannot hide an unchecked/deep subtree.
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > PROGRAM_LIMITS.sourceBytes) fail('Program source exceeds 65536 bytes');
  visit(tree, new Map());
  return { program, compiledCount: sourceMap.length, sourceMap, requestedHoldSeconds };
}
