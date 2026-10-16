// This is an evidence reader, NOT admission or a command generator. Awards require
// the server's exact ordered source map to agree. Differential tests use the real
// server lowerer. Unsupported/unbounded input fails closed; nothing is executed.
export function programFingerprint(value) {
  const clean = v => Array.isArray(v) ? v.map(clean) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().filter(k => !['_id', 'run_id'].includes(k)).map(k => [k, clean(v[k])])) : v;
  return JSON.stringify(clean(value));
}
const LEGACY_PROFILE = Object.freeze({ instructions: 32, repeat: 50, iterations: 256, work: 4096,
  uniqueCommands: 32, wireBytes: 8192, requestedHoldSeconds: 120, observationMs: 120000 });
const INDEXED_PROFILE = Object.freeze({ instructions: 1024, repeat: 1024, iterations: 4096, work: 131072,
  uniqueCommands: 32, wireBytes: 8192, requestedHoldSeconds: 120, observationMs: 315000 });
export const programEvidenceProfile = encoding => encoding === 'indexed-v1' ? INDEXED_PROFILE : LEGACY_PROFILE;
export function readProgramEvidence(blocks, encoding) {
  // Only a known server-selected encoding expands evidence budgets. Device or
  // caller-provided numeric limits must never turn this into an unbounded walk.
  const limits = programEvidenceProfile(encoding);
  const program = [], sourceMap = [], paths = [], types = new Set();
  const env = new Map();
  let work = 0, iterations = 0;
  const tick = depth => { if (++work > limits.work || depth > 8) throw Error('Evidence budget exceeded'); };
  function expr(v, depth = 1) {
    tick(depth);
    if (!v || typeof v !== 'object') return v;
    types.add(v.type);
    if (v.type === 'var_get') { if (!env.has(v.name)) throw Error('Undefined variable'); return env.get(v.name); }
    const a = expr(v.a, depth + 1), b = v.b === undefined ? undefined : expr(v.b, depth + 1);
    switch (v.type) {
      case 'op_add': return a + b; case 'op_sub': return a - b; case 'op_mul': return a * b;
      case 'op_div': if (!b) throw Error('Division by zero'); return a / b;
      case 'op_mod': { if (!b) throw Error('Modulo by zero'); const r = a % b; return r && Math.sign(r) !== Math.sign(b) ? r + b : r; }
      case 'op_abs': return Math.abs(a);
      case 'op_round': { const f = Math.floor(a); return a - f === 0.5 ? (f % 2 === 0 ? f : f + 1) : Math.round(a); }
      case 'op_gt': return a > b; case 'op_lt': return a < b; case 'op_eq': return a === b;
      case 'op_and': return a && b; case 'op_or': return a || b; case 'op_not': return !a;
      default: throw Error('Unsupported reporter');
    }
  }
  function walk(list, path = 'program', depth = 1, loopDepth = 0) {
    tick(depth);
    if (!Array.isArray(list)) throw Error('Invalid program');
    list.forEach((original, i) => {
      tick(depth);
      const b = original.params ? { type: original.type, _id: original._id, ...original.params } : original;
      const p = `${path}[${i}]`;
      if (b.type === 'repeat') {
        if (!Number.isInteger(b.times) || b.times < 0 || b.times > limits.repeat) throw Error('Invalid repeat');
        if (b.times > 0 && b.do.length) { types.add('repeat'); if (loopDepth) types.add('nested_repeat'); }
        for (let n = 0; n < b.times; n++) {
          if (++iterations > limits.iterations) throw Error('Evidence iteration budget exceeded');
          walk(b.do, `${p}.do`, depth + 1, loopDepth + 1);
        }
      } else if (['if_predicate', 'if_else_predicate'].includes(b.type)) {
        const selected = expr(b.cond) ? 'then' : 'else';
        types.add(b.type);
        walk(b[selected] || [], `${p}.${selected}`, depth + 1, loopDepth);
      } else if (['set_variable', 'change_variable'].includes(b.type)) {
        types.add(b.type);
        const value = expr(b.type === 'set_variable' ? b.value : b.by);
        if (b.type === 'change_variable' && !env.has(b.name)) throw Error('Undefined variable');
        env.set(b.name, b.type === 'set_variable' ? value : env.get(b.name) + value);
      } else {
        if (!['move_forward','move_backward','turn_left','turn_right','wait','stop','set_led','display_text','say','display_animation','play_tone','play_sound','play_recording','stop_sound','set_volume','servo','dc_motor'].includes(b.type)) throw Error('Unsupported instruction');
        types.add(b.type);
        if (b.type === 'play_recording' && (typeof b.recording !== 'string' || !/^[0-9a-f]{64}$/.test(b.recording))) throw Error('Invalid recording ID');
        // POST /program omits the lowered program and exposes only aggregate
        // requestedHoldSeconds, not trusted per-recording durations. Preserve
        // playback identity/path, but exclude all browser playback metadata and
        // numeric reporters from duration/skill evidence. Never infer a wait.
        const lowered = b.type === 'play_recording'
          ? { type: b.type, recording: b.recording, ...(b._id === undefined ? {} : { _id: b._id }) }
          : { ...b };
        for (const k of ['speed','duration','angle','size','frequency','volume','interval']) if (lowered[k] && typeof lowered[k] === 'object') lowered[k] = expr(lowered[k]);
        if (b.type === 'say') Object.assign(lowered, {type:'display_text',size:14});
        program.push(lowered);
        paths.push(p);
        const count = b.type === 'display_animation' ? b.frames.length * 2 : 1;
        for (let j = 0; j < count; j++) sourceMap.push({sourceId: b._id ?? null,path:p,compiledIndex:sourceMap.length});
        if (sourceMap.length > limits.instructions) throw Error('Too many instructions');
      }
    });
  }
  walk(blocks);
  return { program, sourceMap, paths, types, compiledCount: sourceMap.length };
}
export function agreesWithServer(evidence, response) {
  return response?.sent === true && typeof response.run_id === 'string' && response.run_id.length > 0
    && evidence.compiledCount > 0 && response.compiledCount === evidence.compiledCount
    && JSON.stringify(response.sourceMap) === JSON.stringify(evidence.sourceMap);
}
