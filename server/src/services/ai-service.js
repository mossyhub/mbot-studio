import OpenAI from 'openai';
import { formatCalibrationForPrompt } from './calibration-service.js';

// Uses GitHub Models API (included with GitHub Copilot subscription)
// Inference: https://models.github.ai/inference  (OpenAI-compatible)
// Catalog:   https://models.github.ai/catalog/models
// Client is lazy-initialized so dotenv has time to load first

const INFERENCE_URL = 'https://models.github.ai/inference';
const CATALOG_URL = 'https://models.github.ai/catalog/models';

let client = null;

function getClient() {
  if (!client) {
    client = new OpenAI({
      baseURL: process.env.AI_BASE_URL || INFERENCE_URL,
      apiKey: process.env.GITHUB_TOKEN,
    });
  }
  return client;
}

// Mutable model selection — can be changed at runtime from the UI
// Model IDs use publisher/name format, e.g. 'openai/gpt-4o'
let currentModel = null;

function getCurrentModel() {
  if (!currentModel) currentModel = process.env.AI_MODEL || 'openai/gpt-4o';
  return currentModel;
}

export function getModel() {
  return getCurrentModel();
}

export function setModel(model) {
  currentModel = model;
  console.log(`🧠 AI model switched to: ${model}`);
}

/**
 * Fetch available chat-completion models from the GitHub Models API
 * Caches the result for 10 minutes to avoid excessive requests
 */
let modelsCache = null;
let modelsCacheTime = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

export async function fetchAvailableModels() {
  const now = Date.now();
  if (modelsCache && (now - modelsCacheTime) < CACHE_TTL) {
    return modelsCache;
  }

  try {
    const res = await fetch(CATALOG_URL, {
      headers: {
        'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!res.ok) {
      throw new Error(`Models catalog API returned ${res.status}`);
    }

    const allModels = await res.json();

    // Filter out embedding models and shape the response
    modelsCache = allModels
      .filter(m => m.rate_limit_tier !== 'embeddings')
      .map(m => ({
        id: m.id,                      // e.g. 'openai/gpt-4o'
        name: m.name,                  // e.g. 'OpenAI GPT-4o'
        publisher: m.publisher,
        summary: m.summary || '',
        tier: m.rate_limit_tier || '',  // low, high, custom
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    modelsCacheTime = now;
    return modelsCache;
  } catch (error) {
    console.error('Failed to fetch models:', error.message);
    // Return a minimal fallback list
    return [
      { id: 'openai/gpt-4o', name: 'OpenAI GPT-4o', publisher: 'OpenAI', summary: '', tier: 'high' },
      { id: 'openai/gpt-4o-mini', name: 'OpenAI GPT-4o mini', publisher: 'OpenAI', summary: '', tier: 'low' },
    ];
  }
}

/**
 * System prompt that teaches the AI about mBot2 programming
 * and how to generate structured block programs
 */
function buildSystemPrompt(robotConfig, hardwareStates) {
  const configDescription = robotConfig
    ? formatRobotConfig(robotConfig, hardwareStates)
    : 'Standard mBot2 with two drive motors, ultrasonic sensor, line follower, and color sensor.';

  return `You are a friendly robot programming assistant for an 8-year-old child programming their mBot2 robot.
You help them create programs by converting their ideas into robot commands.

## Robot Configuration
${configDescription}
${formatCalibrationForPrompt(robotConfig?.calibrations)}
## Available Block Types
You generate programs as JSON arrays of block commands. Here are ALL available blocks:

### Movement
- {"type": "move_forward", "speed": 50, "duration": 2} — Move forward (speed: 0-100, duration in seconds)
- {"type": "move_backward", "speed": 50, "duration": 2} — Move backward
- {"type": "turn_left", "speed": 50, "angle": 90} — Turn left (angle in degrees)
- {"type": "turn_right", "speed": 50, "angle": 90} — Turn right
- {"type": "stop"} — Stop all motors
- {"type": "set_speed", "left": 50, "right": 50} — Set individual motor speeds (-100 to 100)

### Sensors
- {"type": "if_obstacle", "distance": 20, "then": [...blocks...], "else": [...blocks...]} — If obstacle closer than distance (cm)
- {"type": "if_line", "sensor": "left|right|both", "color": "black|white", "then": [...blocks...], "else": [...blocks...]} — Line sensor check
- {"type": "if_color", "color": "red|green|blue|yellow|white|black", "then": [...blocks...], "else": [...blocks...]} — Color sensor check
- {"type": "get_distance"} — Read ultrasonic distance (returns value, use in conditions)

### Sound & Display
- {"type": "play_tone", "frequency": 440, "duration": 0.5} — Play a tone (frequency in Hz)
- {"type": "play_melody", "melody": "happy|sad|excited|alert"} — Play a preset melody
- {"type": "display_text", "text": "Hello!", "size": 16} — Show text on CyberPi display
- {"type": "display_image", "image": "happy|sad|heart|star|arrow_up|arrow_down"} — Show preset image
- {"type": "say", "text": "Hello!"} — Text-to-speech on CyberPi

### Control Flow
- {"type": "wait", "duration": 1} — Wait (seconds)
- {"type": "repeat", "times": 3, "do": [...blocks...]} — Repeat blocks N times
- {"type": "repeat_forever", "do": [...blocks...]} — Repeat forever (until stopped)
- {"type": "if_button", "button": "a|b", "then": [...blocks...]} — When button pressed
- {"type": "while_sensor", "sensor": "distance|line_left|line_right|light|loudness|timer", "operator": ">|<|>=|<=|==|between", "value": 20, "do": [...blocks...]} — Loop while sensor condition is true. For "between" operator use "min" and "max" instead of "value".
- {"type": "move_until", "direction": "forward|backward", "speed": 50, "sensor": "distance", "operator": "<|>|<=|>=|between", "value": 20} — Drive until a sensor condition is met, then stop. For "between" use "min" and "max".

### Advanced Sensors
- {"type": "if_sensor_range", "sensor": "distance|line_left|line_right|light|loudness", "min": 15, "max": 25, "then": [...blocks...], "else": [...blocks...]} — Check if sensor value falls within a range. USE THIS instead of exact comparisons — sensors are noisy and rarely return the exact same number twice!
- {"type": "display_value", "sensor": "distance|line_left|line_right|light|loudness", "label": "Distance"} — Show a live sensor reading on the CyberPi screen. Great for debugging!

### Variables & Math
- {"type": "set_variable", "name": "my_var", "value": 42} — Set a variable to a number
- {"type": "set_variable", "name": "dist", "source": "distance"} — Set a variable from a sensor reading (sensor names: distance, line_left, line_right, light, loudness, timer)
- {"type": "change_variable", "name": "counter", "by": 1} — Add to a variable (use negative to subtract)
- {"type": "math_operation", "result": "half_dist", "a": "dist", "operator": "+|-|*|/", "b": 2} — Arithmetic. "a" and "b" can be variable names (strings) or numbers.

### Custom Hardware (from robot config)
- {"type": "dc_motor", "port": "M3", "speed": 50, "duration": 1} — Control DC motor (speed: -100 to 100, negative=reverse)
- {"type": "servo", "port": "S1", "angle": 90} — Set servo angle (0-180)

## Understanding Custom Hardware
The robot configuration tells you what each motor/servo IS and what it DOES.
If the config says a motor is "part of a robot arm" and its purpose is "opens and closes the claw", then when the child says "open the claw" or "grab something", you should generate the correct motor command for that port, direction, and speed.
Use the named actions from the config when they match the child's request. For example, if the config defines an "open" action with motorDirection "forward", speed 70, and duration 0.5, generate: {"type": "dc_motor", "port": "M3", "speed": 70, "duration": 0.5}
For "reverse" direction, negate the speed: {"type": "dc_motor", "port": "M3", "speed": -70, "duration": 0.5}

## Stateless Actuators (IMPORTANT)
Many custom hardware parts use DC motors which have NO position feedback — you cannot "read" whether a claw is open or closed. The configuration marks these with feedbackType: "none".

Rules for stateless actuators:
1. Each actuator has an ASSUMED STATE tracked by the system (included in the config below). It can be one of the named states, or "unknown".
2. When assumed state is "unknown" (e.g., after power on), suggest running the home action first to establish a known state. Say something like "Let me reset the claw first so I know where it is!"
3. When the child asks to do something that matches the CURRENT assumed state (e.g., "open the claw" when assumed state is already "open"), gently let them know: "I think the claw is already open! Want me to close it instead?"
4. When stall behavior is "caution" or "danger", NEVER exceed the configured duration — running the motor past its endpoint could damage the mechanism.
5. Always be honest about uncertainty. Say things like "I'll try to close the claw — let me know if it didn't work!" rather than claiming certainty.
6. For servo-type hardware (feedbackType: "position"), you CAN be certain of position since servos go to exact angles.

## Rules
1. ALWAYS respond with valid JSON when generating a program
2. Wrap the program in: {"program": [...blocks...], "explanation": "friendly description"}
3. Use simple, encouraging language in explanations
4. Be creative but safe — don't suggest dangerous speeds
5. Keep programs simple and fun
6. If the child asks a question (not a program request), respond normally with {"chat": "your message"}
7. Speed values should generally be 30-70 for safety (100 is max)
8. For "explore" type requests, use obstacle avoidance with the ultrasonic sensor
9. For custom hardware (claw, arm), reference the robot configuration for correct ports
10. PREFER if_sensor_range (between) over exact ==  checks — sensors are noisy! A range of ±5 is a good default.
11. When the child says "go until" or "move until", use the move_until block — it's the easiest way!
12. Use display_value to show sensor readings when debugging or when the child wants to see what the robot "sees"
13. Use variables (set_variable, change_variable) when the program needs to remember values or count things
14. If calibration data exists (Measured Robot Performance section above), USE IT to calculate exact speeds and durations when the child asks for specific distances like "go forward 12 inches" or specific angles like "turn exactly 90 degrees". Show your math in the explanation!

## Sensor Tips (IMPORTANT)
- Ultrasonic distance sensor returns 0-400 cm but is noisy — values can jump ±3 cm. Always use ranges!
- Line follower returns 0-100 (0 = black surface, 100 = white surface). Use ranges like 0-30 for "on line" and 70-100 for "off line".
- Never check for exact sensor values (e.g., distance == 20). Always use < / > or between/range.

## Example
User: "go forward then turn around and come back"
Response: {"program": [
  {"type": "move_forward", "speed": 50, "duration": 2},
  {"type": "turn_right", "speed": 40, "angle": 180},
  {"type": "move_forward", "speed": 50, "duration": 2},
  {"type": "stop"}
], "explanation": "Your robot will drive forward for 2 seconds, spin around, and drive back to where it started! 🤖"}

User: "go forward until you see something close"
Response: {"program": [
  {"type": "move_until", "direction": "forward", "speed": 40, "sensor": "distance", "operator": "<", "value": 15},
  {"type": "display_text", "text": "Found something!"},
  {"type": "play_tone", "frequency": 880, "duration": 0.3}
], "explanation": "Your robot will drive forward and keep checking the distance sensor. As soon as something is closer than 15 cm, it stops! 📏🤖"}

User: "patrol back and forth and beep when you see something in range"
Response: {"program": [
  {"type": "repeat", "times": 5, "do": [
    {"type": "move_forward", "speed": 50, "duration": 2},
    {"type": "set_variable", "name": "dist", "source": "distance"},
    {"type": "if_sensor_range", "sensor": "distance", "min": 5, "max": 30, "then": [
      {"type": "play_tone", "frequency": 1000, "duration": 0.3},
      {"type": "display_value", "sensor": "distance", "label": "Object at"}
    ]},
    {"type": "turn_right", "speed": 40, "angle": 180}
  ]},
  {"type": "stop"}
], "explanation": "Your robot patrols back and forth 5 times. If it spots something between 5 and 30 cm away, it beeps and shows the distance! 🚨"}`;
}

function formatRobotConfig(config, hardwareStates) {
  let desc = `Robot Name: ${config.name || 'My mBot2'}\n`;
  desc += `Base: mBot2 with CyberPi (2 encoder drive motors, ultrasonic sensor, line follower, color sensor, gyroscope)\n`;

  if (config.additions && config.additions.length > 0) {
    desc += '\nCustom Hardware Additions:\n';

    // Group by assembly/partOf for semantic clarity
    const grouped = {};
    const ungrouped = [];
    for (const a of config.additions) {
      if (a.partOf) {
        if (!grouped[a.partOf]) grouped[a.partOf] = [];
        grouped[a.partOf].push(a);
      } else {
        ungrouped.push(a);
      }
    }

    const formatHardware = (a, indent) => {
      let s = `${indent}- Port ${a.port}: ${a.label || a.type} (${a.type})`;
      if (a.purpose) s += ` — PURPOSE: ${a.purpose}`;
      s += '\n';

      // Feedback and state info
      const feedback = a.feedbackType || 'none';
      s += `${indent}  Feedback: ${feedback}`;
      if (feedback === 'none') s += ' (STATELESS — no position sensor)';
      s += '\n';

      if (a.states && a.states.length > 0) {
        s += `${indent}  Possible states: ${a.states.join(', ')}\n`;
      }
      if (a.homeState) {
        s += `${indent}  Home/reset state: "${a.homeState}"\n`;
      }
      if (a.stallBehavior) {
        s += `${indent}  Stall behavior: ${a.stallBehavior}`;
        if (a.stallBehavior === 'danger') s += ' ⚠️ DO NOT exceed action durations!';
        else if (a.stallBehavior === 'caution') s += ' — be careful at limits';
        s += '\n';
      }

      // Current assumed state from runtime tracking
      const state = hardwareStates?.[a.port];
      if (state) {
        s += `${indent}  🔵 CURRENT ASSUMED STATE: "${state.assumedState}" (confidence: ${state.confidence}, set at: ${new Date(state.timestamp).toLocaleTimeString()})\n`;
      } else if (feedback === 'none') {
        s += `${indent}  🔵 CURRENT ASSUMED STATE: "unknown" (not yet tracked)\n`;
      }

      if (a.description) s += `${indent}  Notes: ${a.description}\n`;

      if (a.actions && a.actions.length > 0) {
        s += `${indent}  Actions:\n`;
        for (const act of a.actions) {
          if (!act.name) continue;
          s += `${indent}    "${act.name}"`;
          if (act.targetState) s += ` → sets state to "${act.targetState}"`;
          s += ': ';
          // Show motor parameters if available
          if (act.motorDirection || act.speed || act.duration) {
            const dir = act.motorDirection || 'forward';
            const spd = act.speed || 50;
            const dur = act.duration || 1;
            s += `motor ${dir} at speed ${spd} for ${dur}s`;
          } else {
            s += act.description || 'no description';
          }
          s += '\n';
        }
      }

      return s;
    };

    // Describe grouped assemblies
    for (const [assembly, parts] of Object.entries(grouped)) {
      desc += `\n🧩 Assembly: "${assembly}"\n`;
      for (const a of parts) {
        desc += formatHardware(a, '  ');
      }
    }

    // Describe ungrouped hardware
    for (const a of ungrouped) {
      desc += formatHardware(a, '');
    }
  }

  if (config.notes) {
    desc += `\nAdditional Notes: ${config.notes}\n`;
  }

  return desc;
}

/**
 * Generate a block program from natural language
 */
export async function generateProgram(userMessage, robotConfig, conversationHistory = [], currentBlocks = null, hardwareStates = null) {
  const systemPrompt = buildSystemPrompt(robotConfig, hardwareStates);

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

  const messages = [
    { role: 'system', content: systemPrompt },
    ...conversationHistory.slice(-10), // Keep last 10 messages for context
    { role: 'user', content: enrichedMessage },
  ];

  try {
    const response = await getClient().chat.completions.create({
      model: getCurrentModel(),
      messages,
      temperature: 0.7,
      max_tokens: 2000,
      response_format: { type: 'json_object' },
    });

    const content = response.choices[0].message.content;
    const parsed = JSON.parse(content);

    return {
      success: true,
      ...parsed,
      model: getCurrentModel(),
      raw: content,
    };
  } catch (error) {
    console.error('AI generation error:', error);
    return {
      success: false,
      error: error.message,
      chat: "Oops! I had trouble thinking about that. Can you try saying it a different way? 🤔",
    };
  }
}

/**
 * Chat with the AI assistant (for questions, not program generation)
 */
export async function chatWithAI(userMessage, robotConfig, conversationHistory = [], hardwareStates = null) {
  const systemPrompt = buildSystemPrompt(robotConfig, hardwareStates) + `\n\nThe user is chatting, not necessarily requesting a program. 
Be friendly, encouraging, and helpful. Explain robot concepts simply for an 8-year-old.
If they seem to want a program, generate one using the JSON format above.
Otherwise, respond with: {"chat": "your friendly message"}`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...conversationHistory.slice(-10),
    { role: 'user', content: userMessage },
  ];

  try {
    const response = await getClient().chat.completions.create({
      model: getCurrentModel(),
      messages,
      temperature: 0.8,
      max_tokens: 1000,
      response_format: { type: 'json_object' },
    });

    const content = response.choices[0].message.content;
    const parsed = JSON.parse(content);

    return {
      success: true,
      ...parsed,
    };
  } catch (error) {
    console.error('AI chat error:', error);
    return {
      success: false,
      chat: "Hmm, I'm having trouble right now. Try again in a moment! 🤖",
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
    const response = await getClient().chat.completions.create({
      model: getCurrentModel(),
      messages,
      temperature: 0.3,
      max_tokens: 500,
      response_format: { type: 'json_object' },
    });

    const parsed = JSON.parse(response.choices[0].message.content);
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
      understood: parsed.understood || 'I updated your robot setup with the details you shared.',
      assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions : [],
      needsClarification: scored.needsClarification || !!parsed.needsClarification,
      questions: dedupedQuestions.slice(0, 6),
      completeness: scored.completeness,
      averageCompleteness: scored.averageScore,
    };
  } catch (error) {
    console.error('Config parse error:', error);
    return { error: error.message };
  }
}
