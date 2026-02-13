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

export function validateCommand(value) {
  if (!isObject(value)) {
    return { ok: false, error: 'command must be an object' };
  }
  if (typeof value.type !== 'string' || !value.type.trim()) {
    return { ok: false, error: 'command.type is required' };
  }
  return { ok: true, value };
}
