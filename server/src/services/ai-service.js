import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI, { AzureOpenAI } from 'openai';
import { formatCalibrationForPrompt } from './calibration-service.js';

// OpenAI-compatible API client.
// Supports: direct OpenAI, Azure OpenAI, or any compatible endpoint (via AI_BASE_URL).
// Client is lazy-initialized so dotenv has time to load first.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../..');
const MODEL_COMPAT_PATH = path.join(DATA_DIR, 'ai-model-compat.json');

let client = null;
let lastAiError = null;
let compatibilityLoaded = false;
let modelCompatibility = {
  version: 1,
  updatedAt: null,
  models: {},
};

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function isLocalDebugEnabled() {
  return truthy(process.env.AI_LOCAL_DEBUG);
}

function setLastAiError(error) {
  const status = error?.status || error?.response?.status;
  const code = error?.code || error?.error?.code;
  const message = error?.message || 'Unknown AI error';
  lastAiError = {
    timestamp: new Date().toISOString(),
    status: status || null,
    code: code || null,
    message,
  };
}

function getFriendlyAiFailure(error, fallbackText) {
  const msg = String(error?.message || '');
  const status = error?.status || error?.response?.status;

  if (!getApiKey() && !isAzureOpenAI()) {
    return `${fallbackText} (Missing AI_API_KEY in .env. For local testing, set AI_LOCAL_DEBUG=true.)`;
  }

  if (isAzureOpenAI() && !process.env.AZURE_OPENAI_API_KEY) {
    return `${fallbackText} (Missing AZURE_OPENAI_API_KEY in .env.)`;
  }

  if (status === 401 || msg.toLowerCase().includes('unauthorized')) {
    return `${fallbackText} (API key was rejected — check AI_API_KEY in .env.)`;
  }

  if (status === 429) {
    return `${fallbackText} (Rate limit reached. Try again in a minute or switch to AI_LOCAL_DEBUG=true.)`;
  }

  if (status >= 500) {
    return `${fallbackText} (AI provider is temporarily unavailable: ${status}.)`;
  }

  return `${fallbackText} (${msg || 'Unknown error'})`;
}

function ensureCompatibilityLoaded() {
  if (compatibilityLoaded) return;

  try {
    if (fs.existsSync(MODEL_COMPAT_PATH)) {
      const raw = fs.readFileSync(MODEL_COMPAT_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.models && typeof parsed.models === 'object') {
        modelCompatibility = {
          version: parsed.version || 1,
          updatedAt: parsed.updatedAt || null,
          models: parsed.models,
        };
      }
    }
  } catch (error) {
    console.warn('⚠️  Could not load AI model compatibility cache:', error.message);
  }

  compatibilityLoaded = true;
}

function saveCompatibilityCache() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    modelCompatibility.updatedAt = new Date().toISOString();
    fs.writeFileSync(MODEL_COMPAT_PATH, JSON.stringify(modelCompatibility, null, 2));
  } catch (error) {
    console.warn('⚠️  Could not save AI model compatibility cache:', error.message);
  }
}

function normalizeParamName(name) {
  return String(name || '').trim();
}

function getCompatibilityForModel(modelId) {
  ensureCompatibilityLoaded();
  const key = String(modelId || '');
  if (!key) return { unsupportedParams: [], errors: [] };

  if (!modelCompatibility.models[key]) {
    modelCompatibility.models[key] = {
      unsupportedParams: [],
      errors: [],
      updatedAt: null,
    };
  }

  return modelCompatibility.models[key];
}

function recordUnsupportedParam(modelId, paramName, error) {
  const normalized = normalizeParamName(paramName);
  if (!normalized) return;

  const modelEntry = getCompatibilityForModel(modelId);
  if (!modelEntry.unsupportedParams.includes(normalized)) {
    modelEntry.unsupportedParams.push(normalized);
  }

  modelEntry.updatedAt = new Date().toISOString();
  modelEntry.errors = [
    {
      timestamp: new Date().toISOString(),
      message: String(error?.message || ''),
      status: error?.status || error?.response?.status || null,
    },
    ...(Array.isArray(modelEntry.errors) ? modelEntry.errors : []),
  ].slice(0, 5);

  saveCompatibilityCache();
}

function getHeuristicUnsupportedParams(modelId) {
  const heuristics = new Set();
  const normalizedId = String(modelId || '').toLowerCase();

  // Reasoning-family models (o1, o3, gpt-5, etc.) often reject temperature
  const looksReasoningFamily = /(^|\/)o\d|gpt-5/.test(normalizedId);
  if (looksReasoningFamily) {
    heuristics.add('temperature');
  }

  return Array.from(heuristics);
}

function pruneUnsupportedParams(payload, modelId) {
  const nextPayload = { ...payload };
  const fromCache = getCompatibilityForModel(modelId).unsupportedParams || [];
  const fromHeuristics = getHeuristicUnsupportedParams(modelId);
  const toRemove = new Set([...fromCache, ...fromHeuristics].map(normalizeParamName));

  for (const param of toRemove) {
    if (param && Object.prototype.hasOwnProperty.call(nextPayload, param)) {
      delete nextPayload[param];
    }
  }

  return nextPayload;
}

function parseJsonFromContent(content) {
  if (typeof content !== 'string') {
    throw new Error('Model response was empty or non-text.');
  }

  try {
    return JSON.parse(content);
  } catch {
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start !== -1 && end > start) {
      return JSON.parse(content.slice(start, end + 1));
    }
    throw new Error('Model did not return valid JSON.');
  }
}

function applyCompatibilityFallback(payload, error) {
  const message = String(error?.message || '');
  const nextPayload = { ...payload };

  let unsupportedParam = message.match(/Unsupported parameter:\s*'([^']+)'/i)?.[1];
  if (!unsupportedParam) {
    unsupportedParam = message.match(/Unsupported value:\s*'([^']+)'/i)?.[1];
  }

  if (
    !unsupportedParam
    && message.toLowerCase().includes('temperature')
    && message.toLowerCase().includes('only the default')
  ) {
    unsupportedParam = 'temperature';
  }

  if (unsupportedParam && Object.prototype.hasOwnProperty.call(nextPayload, unsupportedParam)) {
    delete nextPayload[unsupportedParam];
    return {
      changed: true,
      payload: nextPayload,
      removedParam: unsupportedParam,
    };
  }

  return {
    changed: false,
    payload,
    removedParam: null,
  };
}

async function createCompletionWithAdaptiveParams({ messages, temperature, maxCompletionTokens }) {
  const modelId = getCurrentModel();
  let payload = {
    model: modelId,
    messages,
    max_completion_tokens: maxCompletionTokens,
    response_format: { type: 'json_object' },
  };

  if (typeof temperature === 'number') {
    payload.temperature = temperature;
  }

  payload = pruneUnsupportedParams(payload, modelId);

  let attempts = 0;
  let lastError = null;

  while (attempts < 4) {
    try {
      return await getClient().chat.completions.create(payload);
    } catch (error) {
      lastError = error;
      const fallback = applyCompatibilityFallback(payload, error);
      if (!fallback.changed) {
        throw error;
      }

      recordUnsupportedParam(modelId, fallback.removedParam, error);
      payload = fallback.payload;
      attempts += 1;
      console.warn(`⚠️  Model ${modelId} rejected parameter "${fallback.removedParam}". Retrying without it.`);
    }
  }

  throw lastError;
}

function makeLocalDebugProgram(userMessage, currentBlocks = null) {
  const text = String(userMessage || '').toLowerCase();

  const startsWithCurrent = Array.isArray(currentBlocks) && currentBlocks.length > 0
    ? [...currentBlocks]
    : [];

  const program = [...startsWithCurrent];

  if (text.includes('square')) {
    program.push(
      { type: 'repeat', times: 4, do: [
        { type: 'move_forward', speed: 50, duration: 1.5 },
        { type: 'turn_right', speed: 40, angle: 90 },
      ] },
      { type: 'stop' },
    );
  } else if (text.includes('dance')) {
    program.push(
      { type: 'repeat', times: 3, do: [
        { type: 'turn_left', speed: 60, angle: 45 },
        { type: 'turn_right', speed: 60, angle: 90 },
        { type: 'turn_left', speed: 60, angle: 45 },
        { type: 'play_tone', frequency: 880, duration: 0.2 },
      ] },
      { type: 'stop' },
    );
  } else if (text.includes('obstacle') || text.includes('avoid')) {
    program.push(
      { type: 'repeat_forever', do: [
        { type: 'if_sensor_range', sensor: 'distance', min: 0, max: 18, then: [
          { type: 'turn_right', speed: 45, angle: 90 },
        ], else: [
          { type: 'move_forward', speed: 40, duration: 0.4 },
        ] },
      ] },
    );
  } else {
    program.push(
      { type: 'move_forward', speed: 50, duration: 2 },
      { type: 'stop' },
    );
  }

  return {
    success: true,
    program,
    explanation: 'Running in local AI debug mode. I generated a safe sample program so you can test the full UI flow without cloud AI.',
    model: 'local/debug-rule-engine',
    raw: JSON.stringify({ localDebug: true }),
  };
}

function isAzureOpenAI() {
  return !!(process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_DEPLOYMENT);
}

/** Resolve the API key from env — supports AI_API_KEY or legacy GITHUB_TOKEN. */
function getApiKey() {
  return process.env.AI_API_KEY || process.env.GITHUB_TOKEN || '';
}

function getClient() {
  if (!client) {
    if (isAzureOpenAI()) {
      client = new AzureOpenAI({
        endpoint: process.env.AZURE_OPENAI_ENDPOINT,
        apiKey: process.env.AZURE_OPENAI_API_KEY,
        apiVersion: '2024-10-21',
      });
    } else {
      client = new OpenAI({
        baseURL: process.env.AI_BASE_URL || 'https://api.openai.com/v1',
        apiKey: getApiKey(),
      });
    }
  }
  return client;
}

let currentModel = isAzureOpenAI()
  ? process.env.AZURE_OPENAI_DEPLOYMENT
  : (process.env.AI_MODEL || 'gpt-4o');

function getCurrentModel() {
  return currentModel;
}

export function getModel() {
  return getCurrentModel();
}

export function getAiDiagnostics() {
  ensureCompatibilityLoaded();
  const modelId = getCurrentModel();
  const modelEntry = getCompatibilityForModel(modelId);

  return {
    localDebug: isLocalDebugEnabled(),
    provider: isAzureOpenAI() ? 'azure' : 'openai',
    model: modelId,
    baseURL: isAzureOpenAI() ? process.env.AZURE_OPENAI_ENDPOINT : (process.env.AI_BASE_URL || 'https://api.openai.com/v1'),
    hasApiKey: !!getApiKey(),
    heuristicUnsupportedParams: getHeuristicUnsupportedParams(modelId),
    cachedUnsupportedParams: modelEntry.unsupportedParams || [],
    compatibilityCachePath: MODEL_COMPAT_PATH,
    lastAiError,
  };
}

export function initializeModelSelection() {
  if (isLocalDebugEnabled()) {
    currentModel = 'local/debug-rule-engine';
    console.log('🧪 AI local debug mode enabled (AI_LOCAL_DEBUG=true)');
    return currentModel;
  }

  if (isAzureOpenAI()) {
    currentModel = process.env.AZURE_OPENAI_DEPLOYMENT;
    console.log(`🧠 Using Azure OpenAI deployment: ${currentModel} at ${process.env.AZURE_OPENAI_ENDPOINT}`);
    return currentModel;
  }

  currentModel = process.env.AI_MODEL || 'gpt-4o';
  const baseURL = process.env.AI_BASE_URL || 'https://api.openai.com/v1';
  console.log(`🧠 AI model: ${currentModel} at ${baseURL}`);
  return currentModel;
}

/**
 * System prompt that teaches the AI about mBot2 programming
 * and how to generate structured block programs.
 *
 * This prompt is domain-specific: it encodes physical robot geometry,
 * spatial constraints, and task-decomposition patterns so the AI can
 * reason about the physical world when generating programs.
 *
 * PROMPT CACHING STRATEGY:
 * OpenAI automatically caches identical message prefixes ≥1024 tokens.
 * We maximise cache hits by keeping the system prompt config-stable
 * (it only changes when robot-config.json changes) and moving the
 * per-request dynamic state (hardware positions) into a separate
 * context message that comes AFTER the cached system prefix.
 *
 * Message layout:
 *   [0] system   — config-stable, cacheable (identity + robot + blocks + constraints)
 *   [1] user     — dynamic hardware state context (small, ~100 tokens)
 *   [2..n-1]     — conversation history
 *   [n] user     — the child's current request
 */

// ── System prompt cache ────────────────────────────────────────────
// The system prompt only depends on robotConfig (which rarely changes).
// We cache the built prompt keyed by a cheap hash of the config object,
// so we don't rebuild string-heavy sections on every request.
let _cachedSystemPrompt = null;
let _cachedConfigHash = null;

function configHash(robotConfig) {
  // JSON.stringify is deterministic for our config structure
  return JSON.stringify({
    name: robotConfig?.name,
    additions: robotConfig?.additions,
    constraints: robotConfig?.constraints,
    taskPatterns: robotConfig?.taskPatterns,
    calibrations: robotConfig?.calibrations,
    physicalDescription: robotConfig?.physicalDescription,
  });
}

function getCachedSystemPrompt(robotConfig) {
  const hash = configHash(robotConfig);
  if (_cachedSystemPrompt && _cachedConfigHash === hash) {
    return _cachedSystemPrompt;
  }
  _cachedSystemPrompt = buildSystemPrompt(robotConfig);
  _cachedConfigHash = hash;
  return _cachedSystemPrompt;
}

/**
 * Build the system prompt WITHOUT hardware states.
 * Hardware states are injected as a separate context message to keep
 * the system prompt identical across requests (enabling prompt caching).
 */
function buildSystemPrompt(robotConfig) {
  const sections = [];

  // ── Identity & tone ──────────────────────────────────────────────
  sections.push(
    `You are a friendly, encouraging robot programming assistant helping a young child (ages 6–12) program their mBot2 robot. Convert their natural-language ideas into JSON block programs.
Use simple words, short sentences, and the occasional emoji. If something is unclear, ask — don't guess.`
  );

  // ── Physical robot description (without runtime state) ──────────
  sections.push(formatPhysicalDescription(robotConfig, null));

  // ── Block reference ─────────────────────────────────────────────
  sections.push(formatBlockReference(robotConfig));

  // ── Physical constraints ────────────────────────────────────────
  if (robotConfig?.constraints?.length) {
    sections.push(
      `## Physical Constraints (IMPORTANT — follow these!)\n` +
      robotConfig.constraints.map(c => `- ${c}`).join('\n')
    );
  }

  // ── Common task patterns ────────────────────────────────────────
  if (robotConfig?.taskPatterns?.length) {
    sections.push(
      `## Common Task Patterns\nWhen the child asks for one of these, follow the sequence:\n` +
      robotConfig.taskPatterns
        .map(p => `- **"${p.trigger}"** → ${p.sequence}`)
        .join('\n')
    );
  }

  // ── Calibration data ────────────────────────────────────────────
  const calText = formatCalibrationForPrompt(robotConfig?.calibrations);
  if (calText) sections.push(calText);

  // ── Response format ─────────────────────────────────────────────
  sections.push(
    `## Response Format
- To generate a program: {"program": [...blocks...], "explanation": "friendly one-sentence description"}
- To chat / ask a question: {"chat": "your friendly message"}
- Speed 30–70 for driving safety. Keep programs short and simple.
- ALWAYS respond with valid JSON — nothing outside the JSON object.`
  );

  return sections.join('\n\n');
}

/**
 * Build a short context message with current hardware positions.
 * This changes per-request, so it lives outside the cached system prompt.
 * Returns null if there are no hardware additions.
 */
function buildHardwareStateContext(robotConfig, hardwareStates) {
  if (!robotConfig?.additions?.length || !hardwareStates) return null;

  const lines = ['Current hardware positions:'];
  for (const a of robotConfig.additions) {
    const state = hardwareStates[a.port];
    const position = state?.assumedState && state.assumedState !== 'unknown'
      ? `"${state.assumedState}"`
      : 'unknown';
    lines.push(`- ${a.label || a.port} (${a.port}): ${position}`);
  }
  return lines.join('\n');
}

// ── Conversation compression ──────────────────────────────────────
// Keep recent messages verbatim (the AI needs exact context for follow-ups).
// Older messages are summarised into a single compact block so we don't
// blow the context window on long sessions.
const RECENT_KEEP = 6;   // keep last 6 messages verbatim (3 turns)
const MAX_HISTORY = 20;  // absolute cap from SessionStore

/**
 * Compress conversation history for efficient token usage.
 *
 * - If ≤ RECENT_KEEP messages: return as-is
 * - If > RECENT_KEEP: summarise the older messages into a compact
 *   "[Earlier conversation]" block + keep recent verbatim
 *
 * This is a local summarisation (no extra AI call) that extracts the
 * key information: what programs were built, what the child asked for.
 */
function compressHistory(history) {
  if (!history || history.length === 0) return [];

  const capped = history.slice(-MAX_HISTORY);

  if (capped.length <= RECENT_KEEP) {
    return capped;
  }

  const older = capped.slice(0, capped.length - RECENT_KEEP);
  const recent = capped.slice(-RECENT_KEEP);

  // Extract a brief summary of older messages
  const summaryLines = [];
  for (const msg of older) {
    if (msg.role === 'user') {
      // Keep the child's request text, truncated
      const text = String(msg.content || '').slice(0, 120);
      summaryLines.push(`Child: ${text}`);
    } else if (msg.role === 'assistant') {
      // Extract just the explanation or chat text from the AI response
      try {
        const parsed = JSON.parse(msg.content);
        if (parsed.explanation) {
          summaryLines.push(`AI: Made a program — ${parsed.explanation}`);
        } else if (parsed.chat) {
          summaryLines.push(`AI: ${String(parsed.chat).slice(0, 80)}`);
        }
      } catch {
        summaryLines.push(`AI: (responded)`);
      }
    }
  }

  const summaryMsg = {
    role: 'user',
    content: `[Earlier in this conversation — summary of ${older.length} messages]\n${summaryLines.join('\n')}\n[End of summary — recent messages follow]`,
  };

  return [summaryMsg, ...recent];
}

/**
 * Describe the robot as a physical object the AI can reason about.
 * Includes spatial relationships, sensor locations, and hardware attachments.
 */
function formatPhysicalDescription(robotConfig, hardwareStates) {
  const name = robotConfig?.name || 'My mBot2';
  let desc = `## Your Robot: "${name}"\n`;

  // High-level physical description (user-authored or default)
  if (robotConfig?.physicalDescription) {
    desc += robotConfig.physicalDescription + '\n';
  } else {
    desc += 'A small two-wheeled rover robot (mBot2) about the size of a lunchbox.\n';
  }

  // Base platform capabilities
  desc += `\n### Base Platform\n`;
  desc += `- **Drive**: Two motorized wheels (differential drive) — can drive forward/backward and spin in place\n`;
  desc += `- **Front sensor**: Ultrasonic distance sensor (10–400 cm range) — detects obstacles ahead\n`;
  desc += `- **Bottom sensor**: Dual RGB line follower — detects lines on the ground\n`;
  desc += `- **Color sensor**: Quad RGB — identifies colors of nearby objects\n`;
  desc += `- **Gyroscope**: Measures rotation (yaw/pitch/roll)\n`;
  desc += `- **Display**: Small screen on top for showing text and icons\n`;
  desc += `- **Speaker**: Can play tones and melodies\n`;
  desc += `- **LEDs**: 5 programmable colored lights\n`;

  // Custom hardware additions with spatial context
  if (robotConfig?.additions?.length) {
    desc += `\n### Custom Hardware Attached to This Robot\n`;

    // Group by assembly
    const grouped = {};
    const ungrouped = [];
    for (const a of robotConfig.additions) {
      if (a.partOf) {
        if (!grouped[a.partOf]) grouped[a.partOf] = [];
        grouped[a.partOf].push(a);
      } else {
        ungrouped.push(a);
      }
    }

    for (const [assembly, parts] of Object.entries(grouped)) {
      desc += `\n**${assembly}** (${parts.length} part${parts.length > 1 ? 's' : ''}):\n`;
      for (const a of parts) {
        desc += formatHardwareAddition(a, hardwareStates);
      }
    }

    for (const a of ungrouped) {
      desc += formatHardwareAddition(a, hardwareStates);
    }

    desc += `\n⚠️ CRITICAL RULE: When the child names an action (like "lower the arm" or "open the claw"), `;
    desc += `find the matching action name below and use its EXACT parameters. `;
    desc += `NEVER guess angles, speeds, or durations — always use the values from the config.\n`;
  }

  return desc;
}

/**
 * Format a single hardware addition with rich physical context.
 */
function formatHardwareAddition(addition, hardwareStates) {
  const a = addition;
  let s = '';

  // Component header with physical context
  const typeLabel = a.type === 'servo' ? 'Servo' : a.type === 'dc_motor' ? 'DC Motor' : a.type;
  s += `- **${a.label || a.port}** (${typeLabel} on port ${a.port})`;
  if (a.orientation) s += ` — moves ${a.orientation}ly`;
  s += '\n';

  // States with physical meaning
  if (a.states?.length) {
    s += `  Possible positions: ${a.states.join(', ')}\n`;
  }
  if (a.homeState) {
    s += `  Home position (start-up default): "${a.homeState}"\n`;
  }

  // Feedback info
  if (a.type === 'dc_motor') {
    s += `  ⚠️ No position sensor — robot can't tell where this is, so track state carefully\n`;
  }

  // Stall behavior
  if (a.stallBehavior === 'danger') {
    s += `  🛑 DANGER: Running past limits can damage this mechanism!\n`;
  } else if (a.stallBehavior === 'caution') {
    s += `  ⚡ Motor will stall harmlessly at its limits\n`;
  }

  // Current assumed state
  const state = hardwareStates?.[a.port];
  if (state?.assumedState && state.assumedState !== 'unknown') {
    s += `  📍 Currently: "${state.assumedState}"\n`;
  } else {
    s += `  📍 Currently: unknown (not yet moved)\n`;
  }

  // Actions — the actual parameters the AI must use
  if (a.actions?.length) {
    s += `  Actions:\n`;
    for (const act of a.actions) {
      if (!act.name) continue;
      s += `    "${act.name}"`;
      if (act.angle !== undefined) {
        s += ` → servo(port="${a.port}", angle=${act.angle})`;
      } else if (act.motorDirection || act.speed !== undefined) {
        const dir = act.motorDirection || 'forward';
        const speed = dir === 'reverse' ? -(act.speed || 50) : (act.speed || 50);
        s += ` → dc_motor(port="${a.port}", speed=${speed}, duration=${act.duration || 1})`;
      }
      s += '\n';
    }
  }

  return s;
}

/**
 * Format the block type reference section.
 * Only lists blocks that this robot can actually use.
 */
function formatBlockReference(robotConfig) {
  let ref = `## Block Types (ONLY use these exact type names)\n`;

  ref += `\n### Driving (move the whole robot — wheels only)\n`;
  ref += `- {"type": "move_forward", "speed": 50, "duration": 2}\n`;
  ref += `- {"type": "move_backward", "speed": 50, "duration": 2}\n`;
  ref += `- {"type": "turn_left", "speed": 50, "angle": 90}\n`;
  ref += `- {"type": "turn_right", "speed": 50, "angle": 90}\n`;
  ref += `- {"type": "stop"}\n`;
  ref += `"spin" or "spin around" = turn_right with angle 360. These control the WHEELS.\n`;

  ref += `\n### Sound & Display\n`;
  ref += `- {"type": "play_tone", "frequency": 440, "duration": 0.5}\n`;
  ref += `- {"type": "display_text", "text": "Hello!", "size": 16}\n`;
  ref += `- {"type": "set_led", "color": "red"} — colors: red|green|blue|yellow|purple|white|off\n`;

  ref += `\n### Control Flow\n`;
  ref += `- {"type": "wait", "duration": 1}\n`;
  ref += `- {"type": "repeat", "times": 3, "do": [...]}\n`;
  ref += `- {"type": "if_obstacle", "distance": 20, "then": [...], "else": [...]}\n`;
  ref += `- {"type": "move_until", "direction": "forward", "speed": 50, "sensor": "distance", "operator": "<", "value": 15}\n`;

  // Only include custom hardware blocks if there are additions
  if (robotConfig?.additions?.length) {
    ref += `\n### Custom Hardware (servos & motors from config — NOT for driving!)\n`;
    ref += `- {"type": "servo", "port": "S1", "angle": 90} — move a servo to exact angle\n`;
    ref += `- {"type": "dc_motor", "port": "M1", "speed": 50, "duration": 1} — run a DC motor\n`;
    ref += `  For dc_motor: positive speed = forward, negative speed = reverse\n`;
    ref += `\nONLY use servo/dc_motor for the custom hardware listed above. NEVER use them for driving.\n`;
  }

  return ref;
}

/**
 * @deprecated Replaced by formatPhysicalDescription + formatHardwareAddition.
 * Kept only for parseRobotConfig's existing-config injection.
 */
function formatRobotConfig(config, hardwareStates) {
  return formatPhysicalDescription(config, hardwareStates);
}

/**
 * Assemble the message array for an AI request.
 *
 * Layout (optimised for OpenAI prompt caching):
 *   [0]   system  — config-stable prompt (cached by OpenAI after first call)
 *   [1]   user    — hardware state context (small, per-request)
 *   [2…n] history — compressed conversation history
 *   [n+1] user    — the child's current message
 */
function assembleMessages({ robotConfig, hardwareStates, conversationHistory, userContent, systemSuffix }) {
  const systemPrompt = getCachedSystemPrompt(robotConfig)
    + (systemSuffix ? `\n\n${systemSuffix}` : '');

  const messages = [{ role: 'system', content: systemPrompt }];

  // Hardware state as a lightweight context injection (outside cached system prompt)
  const stateCtx = buildHardwareStateContext(robotConfig, hardwareStates);
  if (stateCtx) {
    messages.push({ role: 'user', content: stateCtx });
    messages.push({ role: 'assistant', content: '{"chat":"Got it — I know where everything is."}' });
  }

  // Compressed conversation history
  if (conversationHistory?.length) {
    messages.push(...compressHistory(conversationHistory));
  }

  // Current user message
  messages.push({ role: 'user', content: userContent });

  return messages;
}

/**
 * Generate a block program from natural language
 */
export async function generateProgram(userMessage, robotConfig, conversationHistory = [], currentBlocks = null, hardwareStates = null) {
  if (isLocalDebugEnabled()) {
    return makeLocalDebugProgram(userMessage, currentBlocks);
  }

  // Build the user message, including current program context if available
  let enrichedMessage = userMessage;
  if (currentBlocks && currentBlocks.length > 0) {
    enrichedMessage = `## Current Program State
The child already has a program with these blocks:
\`\`\`json
${JSON.stringify(currentBlocks, null, 2)}
\`\`\`

## New Request
The child wants to MODIFY or ADD TO the existing program above. Their request: "${userMessage}"

IMPORTANT: Build upon the existing blocks. Do NOT start from scratch unless they explicitly ask to "start over" or "make a new program". 
Return the COMPLETE updated program (existing blocks + modifications) in your response.`;
  }

  const messages = assembleMessages({
    robotConfig,
    hardwareStates,
    conversationHistory,
    userContent: enrichedMessage,
  });

  try {
    const response = await createCompletionWithAdaptiveParams({
      messages,
      temperature: 0.7,
      maxCompletionTokens: 2000,
    });

    const content = response.choices[0].message.content;
    const parsed = parseJsonFromContent(content);

    // Log cache hit info when available
    const cached = response.usage?.prompt_tokens_details?.cached_tokens;
    if (cached > 0) {
      console.log(`💾 Prompt cache hit: ${cached}/${response.usage.prompt_tokens} tokens cached`);
    }

    return {
      success: true,
      ...parsed,
      model: getCurrentModel(),
      raw: content,
    };
  } catch (error) {
    console.error('AI generation error:', error);
    setLastAiError(error);
    return {
      success: false,
      error: error.message,
      chat: getFriendlyAiFailure(error, 'Oops! I had trouble thinking about that. Can you try saying it a different way? 🤔'),
    };
  }
}

/**
 * Chat with the AI assistant (for questions, not program generation)
 */
export async function chatWithAI(userMessage, robotConfig, conversationHistory = [], hardwareStates = null) {
  if (isLocalDebugEnabled()) {
    return {
      success: true,
      chat: `Local debug mode is on, so I am not calling cloud AI right now. You said: "${userMessage}"`,
      model: 'local/debug-rule-engine',
    };
  }

  const messages = assembleMessages({
    robotConfig,
    hardwareStates,
    conversationHistory,
    userContent: userMessage,
    systemSuffix: `The user is chatting, not necessarily requesting a program. 
Be friendly, encouraging, and helpful. Explain robot concepts simply for an 8-year-old.
If they seem to want a program, generate one using the JSON format above.
Otherwise, respond with: {"chat": "your friendly message"}`,
  });

  try {
    const response = await createCompletionWithAdaptiveParams({
      messages,
      temperature: 0.8,
      maxCompletionTokens: 1000,
    });

    const content = response.choices[0].message.content;
    const parsed = parseJsonFromContent(content);

    return {
      success: true,
      ...parsed,
    };
  } catch (error) {
    console.error('AI chat error:', error);
    setLastAiError(error);
    return {
      success: false,
      chat: getFriendlyAiFailure(error, "Hmm, I'm having trouble right now. Try again in a moment! 🤖"),
    };
  }
}

function getRequiredFieldsForType(type) {
  if (type === 'servo') {
    return ['port', 'label', 'partOf', 'purpose', 'states', 'homeState', 'actions', 'orientation'];
  }
  if (type === 'dc_motor') {
    return ['port', 'label', 'partOf', 'purpose', 'states', 'homeState', 'actions'];
  }
  if (String(type || '').includes('sensor')) {
    return ['port', 'label', 'partOf', 'purpose'];
  }
  return ['port', 'label', 'partOf', 'purpose'];
}

function hasMeaningfulActions(addition) {
  if (!addition?.actions || addition.actions.length === 0) return false;
  if (addition.type === 'servo') {
    return addition.actions.some(a => a.name && (a.angle !== undefined || a.targetState));
  }
  if (addition.type === 'dc_motor') {
    return addition.actions.some(a => a.name && a.motorDirection && a.speed !== undefined && a.duration !== undefined);
  }
  return addition.actions.some(a => a.name);
}

function getMissingFields(addition) {
  const required = getRequiredFieldsForType(addition?.type);
  const missing = [];

  for (const field of required) {
    if (field === 'states') {
      if (!addition?.states || addition.states.length === 0) missing.push('states');
      continue;
    }
    if (field === 'actions') {
      if (!hasMeaningfulActions(addition)) missing.push('actions');
      continue;
    }
    const value = addition?.[field];
    if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
      missing.push(field);
    }
  }

  if (addition?.type === 'servo' && addition.orientation && !['vertical', 'horizontal'].includes(addition.orientation)) {
    missing.push('orientation');
  }

  return Array.from(new Set(missing));
}

function questionForMissingField(addition, field) {
  const name = addition?.label || addition?.partOf || addition?.port || 'that hardware';
  if (field === 'type') return `Is ${name} controlled by a DC motor, a servo, or a sensor module?`;
  if (field === 'port') return `Which port is ${name} connected to (M1-M4, S1-S4, or P1-P4)?`;
  if (field === 'partOf') return `What assembly is ${name} part of (for example "robot arm" or "claw")?`;
  if (field === 'purpose') return `What does ${name} do when your robot uses it?`;
  if (field === 'states') return `What named positions or states does ${name} have (like up/down or open/closed)?`;
  if (field === 'homeState') return `What is the safe home position for ${name} when starting up?`;
  if (field === 'actions') return `What actions should the robot know for ${name} and how should each action move it?`;
  if (field === 'orientation') return `For ${name}, is its motion vertical or horizontal?`;
  return `Can you share more detail about ${field} for ${name}?`;
}

function enrichAndScoreAdditions(additions = []) {
  const normalized = additions.map((addition) => {
    const cloned = { ...addition };
    if (cloned.type === 'servo' && !cloned.feedbackType) cloned.feedbackType = 'position';
    if (cloned.type === 'dc_motor' && !cloned.feedbackType) cloned.feedbackType = 'none';
    if (String(cloned.type || '').includes('sensor') && !cloned.feedbackType) cloned.feedbackType = 'sensor';
    if (cloned.orientation && typeof cloned.orientation === 'string') {
      cloned.orientation = cloned.orientation.trim().toLowerCase();
    }
    return cloned;
  });

  const completeness = normalized.map((addition) => {
    const required = getRequiredFieldsForType(addition.type);
    const missing = getMissingFields(addition);
    const score = required.length === 0
      ? 1
      : Math.max(0, (required.length - missing.length) / required.length);

    return {
      port: addition.port || '',
      label: addition.label || addition.type || 'hardware',
      type: addition.type || 'custom',
      score,
      missing,
      questions: missing.map((field) => ({
        field,
        question: questionForMissingField(addition, field),
      })),
    };
  });

  const allQuestions = completeness
    .flatMap(entry => entry.questions.map(q => ({
      port: entry.port,
      label: entry.label,
      type: entry.type,
      field: q.field,
      question: q.question,
    })));

  const averageScore = completeness.length === 0
    ? 1
    : completeness.reduce((sum, item) => sum + item.score, 0) / completeness.length;

  return {
    additions: normalized,
    completeness,
    needsClarification: allQuestions.length > 0,
    averageScore,
    questions: allQuestions.slice(0, 6),
  };
}

/**
 * Convert a natural language robot configuration description to structured config
 */
export async function parseRobotConfig(description, existingAdditions = []) {
  if (isLocalDebugEnabled()) {
    const additions = Array.isArray(existingAdditions) ? existingAdditions : [];
    return {
      additions,
      understood: 'Local debug mode is enabled. Keeping existing hardware config unchanged for offline testing.',
      assumptions: ['Cloud AI parsing is disabled in local debug mode.'],
      needsClarification: false,
      questions: [],
      completeness: [],
      averageCompleteness: additions.length > 0 ? 1 : 0,
    };
  }

  const existing = Array.isArray(existingAdditions) ? existingAdditions : [];
  const messages = [
    {
      role: 'system',
      content: `You help configure an mBot2 robot. Parse the user's description of their robot setup into structured JSON.

The mBot2 has these available ports for additions:
- DC Motor ports: M1, M2, M3, M4 (not EM1/EM2 which are the built-in drive motors)  
- Servo ports: S1, S2, S3, S4
- mBuild ports: P1, P2, P3, P4 (for sensors and mBuild modules)

Return JSON in this format:
{
  "physicalDescription": "A one-paragraph description of the complete robot as a physical object. Describe what it looks like, where things are mounted, and what it can do. Write it so someone who has never seen the robot can picture it.",
  "constraints": [
    "Physical rules the AI must follow when generating programs, e.g. 'lower the arm before picking up objects'"
  ],
  "taskPatterns": [
    {
      "trigger": "natural language trigger phrase like 'pick up'",
      "sequence": "Step-by-step physical action sequence",
      "blocks": "Which block types to use in order"
    }
  ],
  "additions": [
    {
      "port": "M3",
      "type": "dc_motor",
      "label": "Claw Motor",
      "description": "DC motor that opens and closes the claw gripper",
      "partOf": "Robot Arm",
      "purpose": "Opens and closes to pick up and release small objects",
      "orientation": "vertical",
      "feedbackType": "none",
      "states": ["open", "closed"],
      "homeState": "open",
      "stallBehavior": "caution",
      "actions": [
        {
          "name": "open",
          "targetState": "open",
          "motorDirection": "forward",
          "speed": 70,
          "duration": 0.5,
          "description": "Spin forward at speed 70 for 0.5 seconds"
        },
        {
          "name": "close",
          "targetState": "closed",
          "motorDirection": "reverse",
          "speed": 70,
          "duration": 0.5,
          "description": "Spin in reverse at speed 70 for 0.5 seconds"
        }
      ],
      "settings": {"defaultSpeed": 70}
    }
  ],
  "understood": "friendly summary of what you understood",
  "assumptions": ["list any guesses you made"],
  "needsClarification": true,
  "questions": [
    {"field": "port", "question": "Which port is it connected to?"}
  ]
}

PHYSICAL DESCRIPTION GUIDE:
- Describe the robot from a child's perspective — what does it look like?
- Mention where hardware is mounted (on top, in front, on the side)
- Describe what the robot can do with its attachments
- Keep it to 2-3 sentences

CONSTRAINTS GUIDE:
- Think about what could go wrong physically (e.g., driving with arm down drags objects)
- Think about order-of-operations (e.g., must lower arm before grabbing)
- Think about stateless hardware (e.g., gripper has no sensor, so open first if unsure)

TASK PATTERNS GUIDE:
- Think about common things a child would ask this robot to do
- Break each into a physical action sequence
- Map to the block types the robot supports

FIELD GUIDE:
- "partOf": What assembly or mechanism is this hardware part of? (e.g., "Robot Arm", "Claw Assembly", "Head", "Launcher")
- "purpose": What does this hardware actually DO? Describe its function in plain language.
- "feedbackType": How does this hardware report position?
  - "none" for DC motors (they just spin, no way to know position)
  - "position" for servos (they go to exact angles)
  - "sensor" for sensors that read values
- "orientation": For moving parts, whether movement is "vertical" or "horizontal" (especially important for arms/lifters)
- "states": Named physical states the hardware can be in. Infer from context:
  - Claw → ["open", "closed"]
  - Arm → ["up", "down"]  
  - Head/turret → ["left", "center", "right"]
  - Fan/spinner → ["spinning", "stopped"]
  - Launcher → ["loaded", "fired"]
- "homeState": The known starting position after a reset/calibration. Usually the most natural resting position (e.g., "open" for a claw, "down" for an arm, "center" for a head).
- "stallBehavior": What happens if the motor runs past the physical limit?
  - "safe" → nothing bad happens (e.g., a fan)
  - "caution" → motor stalls but no damage (e.g., a claw that bottoms out)
  - "danger" → could damage the mechanism (e.g., an arm hitting a hard stop)
- "actions": Named actions with motor parameters:
  - "name": What the child would say (e.g., "open", "close", "raise", "lower")
  - "targetState": What state the hardware transitions to after this action
  - "motorDirection": "forward" or "reverse" — which way the motor spins
  - "speed": Motor speed 0-100 (suggest 50-70 for most things)
  - "duration": How long to run in seconds (0.3-2.0 typically)
  - "description": Human-readable description

For servos, actions use angle instead of motorDirection/speed/duration:
  - "angle": 0-180 degrees
  - include "orientation" as "vertical" or "horizontal" when the mechanism is directional

INFERENCE RULES:
- If type is "dc_motor", feedbackType is always "none"
- If type is "servo", feedbackType is always "position"
- If type contains "sensor", feedbackType is always "sensor"
- For DC motors, you MUST provide motorDirection, speed, and duration in actions (these are best guesses — the user will calibrate later)
- Default speed is 70, default duration is 0.5 for small mechanisms, 1.0 for larger ones
- Be creative in inferring actions from the description. Think about what a child would naturally say.

Types can be: dc_motor, servo, ultrasonic, color_sensor, light_sensor, custom`,
    },
    {
      role: 'user',
      content: `Current additions already known:\n${JSON.stringify(existing, null, 2)}`,
    },
    { role: 'user', content: description },
  ];

  try {
    const response = await createCompletionWithAdaptiveParams({
      messages,
      temperature: 0.3,
      maxCompletionTokens: 2000,
    });

    const content = response.choices[0].message.content;
    const finishReason = response.choices[0].finish_reason;
    if (finishReason === 'length') {
      console.warn('[config-parse] Response truncated (finish_reason=length). Raw tail:', content?.slice(-200));
    }

    const parsed = parseJsonFromContent(content);
    const merged = [...existing];

    for (const addition of (parsed.additions || [])) {
      const idx = merged.findIndex(a => a.port && addition.port && a.port === addition.port);
      if (idx >= 0) {
        merged[idx] = { ...merged[idx], ...addition };
      } else {
        merged.push(addition);
      }
    }

    const scored = enrichAndScoreAdditions(merged);
    const combinedQuestions = [
      ...(Array.isArray(parsed.questions) ? parsed.questions : []),
      ...scored.questions,
    ];

    const dedupedQuestions = [];
    const seen = new Set();
    for (const q of combinedQuestions) {
      const question = typeof q === 'string' ? q : q.question;
      const field = typeof q === 'string' ? 'general' : (q.field || 'general');
      if (!question) continue;
      const key = `${field}:${question.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      dedupedQuestions.push({
        field,
        question,
      });
    }

    return {
      additions: scored.additions,
      physicalDescription: parsed.physicalDescription || null,
      constraints: Array.isArray(parsed.constraints) ? parsed.constraints : [],
      taskPatterns: Array.isArray(parsed.taskPatterns) ? parsed.taskPatterns : [],
      understood: parsed.understood || 'I updated your robot setup with the details you shared.',
      assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions : [],
      needsClarification: scored.needsClarification || !!parsed.needsClarification,
      questions: dedupedQuestions.slice(0, 6),
      completeness: scored.completeness,
      averageCompleteness: scored.averageScore,
    };
  } catch (error) {
    console.error('Config parse error:', error);
    setLastAiError(error);
    return { error: error.message };
  }
}
