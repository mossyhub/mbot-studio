function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function getSessionId(value, fallback = 'default') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

export function validateMessage(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return { ok: false, error: 'Message is required' };
  }
  if (value.length > 3000) {
    return { ok: false, error: 'Message is too long (max 3000 chars)' };
  }
  return { ok: true, value: value.trim() };
}

export function validateBlocks(value, fieldName = 'blocks') {
  if (!Array.isArray(value)) {
    return { ok: false, error: `${fieldName} must be an array` };
  }
  if (value.length > 500) {
    return { ok: false, error: `${fieldName} is too large (max 500 blocks)` };
  }
  if (!value.every(isObject)) {
    return { ok: false, error: `${fieldName} must contain objects` };
  }
  return { ok: true, value };
}

/** Validate consumed config containers without stripping extension metadata. */
export function validateRobotConfig(value) {
  const invalid = error => ({ ok: false, error });
  if (!isObject(value)) return invalid('Config must be an object');
  for (const key of ['name', 'notes', 'physicalDescription']) {
    if (value[key] != null && typeof value[key] !== 'string') {
      return invalid(`${key} must be a string`);
    }
  }
  if (value.turnMultiplier != null && !Number.isFinite(value.turnMultiplier)) {
    return invalid('turnMultiplier must be a finite number');
  }
  if ('additions' in value) {
    if (!Array.isArray(value.additions)) return invalid('additions must be an array');
    for (const addition of value.additions) {
      const result = validateAddition(addition);
      if (!result.ok) return result;
    }
  }
  if (value.constraints != null && (!Array.isArray(value.constraints) || !value.constraints.every(item => typeof item === 'string'))) {
    return invalid('constraints must be an array of strings');
  }
  if (value.taskPatterns != null && (!Array.isArray(value.taskPatterns) || !value.taskPatterns.every(isObject))) {
    return invalid('taskPatterns must be an array of objects');
  }
  if (value.calibrations != null) {
    if (!isObject(value.calibrations)) return invalid('calibrations must be an object');
    for (const entries of Object.values(value.calibrations)) {
      if (!Array.isArray(entries) || !entries.every(isObject)) {
        return invalid('calibration entries must be arrays of objects');
      }
    }
  }
  return { ok: true, value };
}

export function validateAddition(value) {
  const invalid = error => ({ ok: false, error });
  if (!isObject(value)) return invalid('Addition must be an object');
  for (const key of ['port', 'type']) {
    if (typeof value[key] !== 'string' || !value[key].trim()) {
      return invalid(`addition.${key} is required and must be a non-empty string`);
    }
  }
  // Config supports custom/sensor types as well as servo and dc_motor.
  if (value.actions != null && (!Array.isArray(value.actions) || !value.actions.every(isObject))) {
    return invalid('addition.actions must be an array of objects');
  }
  if (value.states != null && (!Array.isArray(value.states) || !value.states.every(item => typeof item === 'string'))) {
    return invalid('addition.states must be an array of strings');
  }
  if (value.settings != null && !isObject(value.settings)) {
    return invalid('addition.settings must be an object');
  }
  return { ok: true, value };
}

export function validateCommand(value) {
  if (!isObject(value)) {
    return { ok: false, error: 'command must be an object' };
  }
  if (typeof value.type !== 'string' || !value.type.trim()) {
    return { ok: false, error: 'command.type is required' };
  }
  return { ok: true, value };
}
