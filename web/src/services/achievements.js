/**
 * Achievement Service — Gamification for mBot Studio
 * Tracks badges/achievements in localStorage.
 * Kids earn badges for milestones like first program, using sensors, etc.
 */

const STORAGE_KEY_PREFIX = 'mbot-studio-achievements';
let activeProfileId = 'default';

function getStorageKey() {
  return `${STORAGE_KEY_PREFIX}:${activeProfileId || 'default'}`;
}

export function setAchievementsProfile(profileId) {
  activeProfileId = profileId || 'default';
}

export function getAchievementsProfile() {
  return activeProfileId;
}

// ─── Badge Definitions ──────────────────────────────────────

export const BADGES = [
  // === First Steps ===
  { id: 'first_program',    name: 'Hello Robot!',      icon: '🚀', category: 'first-steps',
    description: 'Run your first program.',
    hint: 'Build any program in the block editor and click ▶️ Run.' },
  { id: 'first_chat',       name: 'Robot Whisperer',   icon: '💬', category: 'first-steps',
    description: 'Talk to the AI assistant.',
    hint: 'Open the chat panel and ask the AI to make the robot do something.' },
  { id: 'first_live',       name: 'Joystick Master',   icon: '🎮', category: 'first-steps',
    description: 'Use live control for the first time.',
    hint: 'Open Live Control and drive the robot with the on-screen pad or arrow keys.' },
  { id: 'first_voice',      name: 'Voice Commander',   icon: '🎙️', category: 'first-steps',
    description: 'Use voice control.',
    hint: 'In Live Control, tap the 🎤 mic button and say a command out loud.' },
  { id: 'first_save',       name: 'Saver!',            icon: '💾', category: 'first-steps',
    description: 'Save your first project.',
    hint: 'After making a program, click 💾 Save and give it a name.' },

  // === Programming ===
  { id: 'ten_blocks',       name: 'Block Builder',     icon: '🧱', category: 'coding',
    description: 'Create a program with 10+ blocks.',
    hint: 'Stack at least 10 blocks together, then run the program.' },
  { id: 'twenty_blocks',    name: 'Master Builder',    icon: '🏗️', category: 'coding',
    description: 'Create a program with 20+ blocks.',
    hint: 'Build a longer program — try repeating actions or adding effects.' },
  { id: 'fifty_blocks',     name: 'Mega Builder',      icon: '🏰', category: 'coding',
    description: 'Create a program with 50+ blocks.',
    hint: 'Make a really big project! Combine sensors, loops, sounds and moves.' },
  { id: 'used_loop',        name: 'Loop-de-Loop',      icon: '🔄', category: 'coding',
    description: 'Use a repeat or forever loop.',
    hint: 'Drag a "repeat" or "forever" block and put actions inside it.' },
  { id: 'forever_runner',   name: 'Infinity Mode',     icon: '♾️', category: 'coding',
    description: 'Use a forever loop.',
    hint: 'Use the "repeat forever" block to run something non-stop.' },
  { id: 'nested_loops',     name: 'Loopception',       icon: '🌀', category: 'coding',
    description: 'Put a loop inside another loop.',
    hint: 'Place a repeat block inside another repeat block.' },
  { id: 'used_variable',    name: 'Brain Power',       icon: '🧠', category: 'coding',
    description: 'Use a variable in your program.',
    hint: 'Use a "set variable" or "change variable" block to remember a number.' },
  { id: 'used_condition',   name: 'Decision Maker',    icon: '🤔', category: 'coding',
    description: 'Use an if/else condition.',
    hint: 'Use an "if" block (e.g. if obstacle, if line, if button) to make choices.' },
  { id: 'wait_master',      name: 'Patient Robot',     icon: '⏳', category: 'coding',
    description: 'Use a wait block.',
    hint: 'Add a "wait N seconds" block to pause your robot.' },
  { id: 'combo_program',    name: 'Combo Coder',       icon: '🎛️', category: 'coding',
    description: 'Use a sensor, a loop, AND a condition in one program.',
    hint: 'Mix all three: a repeat block, an if block, and read a sensor.' },

  // === Operators ===
  { id: 'used_math',        name: 'Number Cruncher',   icon: '➕', category: 'operators',
    description: 'Use a math block (+, −, ×, ÷).',
    hint: 'Drag a "math" or "mod" operator block to do arithmetic.' },
  { id: 'used_random',      name: 'Lucky Dice',         icon: '🎲', category: 'operators',
    description: 'Pick a random number.',
    hint: 'Use the "pick random" operator block to roll a number.' },
  { id: 'used_compare',     name: 'Truth Seeker',       icon: '⚖️', category: 'operators',
    description: 'Compare two values with an operator block.',
    hint: 'Use the "compare" block (>, <, ==) to check if something is true.' },
  { id: 'used_logic',       name: 'Logic Wizard',       icon: '🔀', category: 'operators',
    description: 'Combine values with and / or / not.',
    hint: 'Use the "logic" block to combine two true/false values.' },
  { id: 'used_math_fn',     name: 'Function Fan',       icon: 'ƒ', category: 'operators',
    description: 'Use a math function (abs, sqrt, sin, …).',
    hint: 'Use the "function of" operator block to do fancy math.' },
  { id: 'used_mod',         name: 'Remainder Hero',     icon: '‰', category: 'operators',
    description: 'Use the modulo (mod) block.',
    hint: 'Use "mod" — great for "every Nth time" tricks.' },
  { id: 'used_string',      name: 'Word Smith',         icon: '🔤', category: 'operators',
    description: 'Use any string operator block.',
    hint: 'Try "join", "letter of", "length of", or "contains".' },
  { id: 'used_string_join', name: 'String Stitcher',    icon: '🔗', category: 'operators',
    description: 'Join two pieces of text together.',
    hint: 'Use the "join" operator block to combine words.' },
  { id: 'string_explorer',  name: 'String Explorer',    icon: '🧵', category: 'operators',
    description: 'Use 3 different string operator blocks in one program.',
    hint: 'Mix "join", "letter of", "length of", and "contains".' },
  { id: 'operator_master',  name: 'Operator Master',    icon: '🧮', category: 'operators',
    description: 'Use 5 different kinds of operator blocks in one program.',
    hint: 'Combine math, random, compare, logic, function, mod, or string blocks.' },

  // === Sensors ===
  { id: 'used_distance',    name: 'Echo Finder',       icon: '📡', category: 'sensors',
    description: 'Use the distance sensor.',
    hint: 'Use "if obstacle" or read the distance sensor in your program.' },
  { id: 'used_line',        name: 'Line Tracker',      icon: '➖', category: 'sensors',
    description: 'Use the line follower sensor.',
    hint: 'Add an "if line" block — point it at a black line on white paper.' },
  { id: 'used_color',       name: 'Color Spotter',     icon: '🎨', category: 'sensors',
    description: 'Use the color sensor.',
    hint: 'Use the "if color" block to react to red, blue, green, or yellow.' },
  { id: 'used_sound',       name: 'Sound Detective',   icon: '🔊', category: 'sensors',
    description: 'Read the loudness sensor.',
    hint: 'Read "loudness" inside an if or while block — clap to test it!' },
  { id: 'used_light',       name: 'Light Chaser',      icon: '☀️', category: 'sensors',
    description: 'Read the brightness sensor.',
    hint: 'Read "brightness" — try shining a flashlight at the robot.' },
  { id: 'multi_sensor',     name: 'Sensor Sleuth',     icon: '🧪', category: 'sensors',
    description: 'Use 2+ different sensors in one program.',
    hint: 'Combine, for example, distance + line, or color + loudness.' },
  { id: 'sensor_master',    name: 'Sensor Master',     icon: '🛰️', category: 'sensors',
    description: 'Use 4+ different sensors in one program.',
    hint: 'Use distance, line, color, light or loudness — at least four kinds!' },

  // === Creative ===
  { id: 'played_sound',     name: 'DJ Robot',          icon: '🎵', category: 'creative',
    description: 'Make the robot play a sound.',
    hint: 'Add a "play tone" or "play melody" block.' },
  { id: 'tone_composer',    name: 'Composer',          icon: '🎼', category: 'creative',
    description: 'Play 3 or more tones in one program.',
    hint: 'String together at least three play-tone blocks to make a tune.' },
  { id: 'showed_display',   name: 'Show Off',          icon: '📺', category: 'creative',
    description: 'Display something on the CyberPi screen.',
    hint: 'Use "display text", "say", or "display value" to show something.' },
  { id: 'display_artist',   name: 'Pixel Artist',      icon: '🖼️', category: 'creative',
    description: 'Show an image on the CyberPi screen.',
    hint: 'Use the "display image" block to draw a picture on the screen.' },
  { id: 'dance_program',    name: 'Dance Machine',     icon: '💃', category: 'creative',
    description: 'Make a dance with 3+ different moves.',
    hint: 'Combine forward, back, left, right, or set-speed in one program.' },
  { id: 'mega_dance',       name: 'Dance Party',       icon: '🪩', category: 'creative',
    description: 'Use 5+ different kinds of move blocks.',
    hint: 'Mix forwards, backwards, turns, distance moves, and speed changes.' },
  { id: 'move_master',      name: 'Four-Way Pro',      icon: '🧭', category: 'creative',
    description: 'Use forward, backward, left, AND right in one program.',
    hint: 'Make the robot go in all four directions in a single program.' },
  { id: 'five_programs',    name: 'Prolific Coder',    icon: '📚', category: 'creative',
    description: 'Run 5 different programs.',
    hint: 'Just keep running programs — every Run counts!' },
  { id: 'ten_programs',     name: 'Code Ninja',        icon: '🥷', category: 'creative',
    description: 'Run 10 different programs.',
    hint: 'Keep building and running — try AI-generated ones too.' },
  { id: 'marathon',         name: 'Marathon Coder',    icon: '🏃', category: 'creative',
    description: 'Run 25 programs total.',
    hint: 'Practice makes perfect — every run counts toward this badge.' },

  // === Challenges ===
  { id: 'first_challenge',  name: 'Challenger',        icon: '🎯', category: 'challenges',
    description: 'Complete your first challenge.',
    hint: 'Open the Challenges panel and finish any one of them.' },
  { id: 'three_stars',      name: 'Star Collector',    icon: '⭐', category: 'challenges',
    description: 'Earn 3 stars in challenges.',
    hint: 'Complete challenges to collect stars — easier ones give 1 star each.' },
  { id: 'ten_stars',        name: 'Superstar',         icon: '🌟', category: 'challenges',
    description: 'Earn 10 stars in challenges.',
    hint: 'Try harder challenges — they give more stars per completion.' },
  { id: 'all_beginner',     name: 'Beginner Champion', icon: '🏅', category: 'challenges',
    description: 'Complete every beginner challenge.',
    hint: 'Finish all challenges marked Beginner in the Challenges panel.' },

  // === Explorer ===
  { id: 'night_coder',      name: 'Night Owl',         icon: '🦉', category: 'explorer',
    description: 'Run a program after 8 PM.',
    hint: 'Run any program in the evening — late coding sessions count!' },
  { id: 'morning_coder',    name: 'Early Bird',        icon: '🐦', category: 'explorer',
    description: 'Run a program before 8 AM.',
    hint: 'Run any program early in the morning to catch this one.' },
  { id: 'weekend_coder',    name: 'Weekend Warrior',   icon: '🏖️', category: 'explorer',
    description: 'Run a program on a Saturday or Sunday.',
    hint: 'Code on the weekend — any program run on Sat/Sun counts.' },
  { id: 'custom_hardware',  name: 'Hardware Hacker',   icon: '🔧', category: 'explorer',
    description: 'Configure custom hardware on the robot.',
    hint: 'Open Robot Config and add a servo, DC motor, or accessory.' },
  { id: 'calibration',      name: 'Robot Teacher',     icon: '📏', category: 'explorer',
    description: 'Teach the robot about itself with calibration.',
    hint: 'Open the Calibration assistant and answer a few questions.' },
];

// ─── State ──────────────────────────────────────────────────

function loadState() {
  try {
    const raw = localStorage.getItem(getStorageKey());
    return raw ? JSON.parse(raw) : { earned: {}, stats: {} };
  } catch {
    return { earned: {}, stats: {} };
  }
}

function saveState(state) {
  localStorage.setItem(getStorageKey(), JSON.stringify(state));
}

// ─── Public API ─────────────────────────────────────────────

/** Get all earned badge IDs with their earned timestamps */
export function getEarnedBadges() {
  return loadState().earned;
}

/** Get full badge objects for all earned badges */
export function getEarnedBadgeObjects() {
  const earned = loadState().earned;
  return BADGES.filter(b => earned[b.id]).map(b => ({
    ...b,
    earnedAt: earned[b.id],
  }));
}

/** Check if a specific badge has been earned */
export function hasBadge(id) {
  return !!loadState().earned[id];
}

/** Get stats counters */
export function getStats() {
  return loadState().stats;
}

/** Increment a stat counter and return its new value */
export function incrementStat(statName, by = 1) {
  const state = loadState();
  state.stats[statName] = (state.stats[statName] || 0) + by;
  saveState(state);
  return state.stats[statName];
}

/**
 * Try to earn a badge. Returns the badge object if newly earned, null otherwise.
 * This is the main function to call when checking achievement conditions.
 */
export function tryEarnBadge(badgeId) {
  const state = loadState();
  if (state.earned[badgeId]) return null; // Already earned

  const badge = BADGES.find(b => b.id === badgeId);
  if (!badge) return null;

  state.earned[badgeId] = Date.now();
  saveState(state);
  return badge;
}

/**
 * Check program blocks for achievement triggers.
 * Call this when a program is about to be run.
 * Returns an array of newly earned badges.
 */
export function checkProgramAchievements(blocks) {
  const newBadges = [];

  // First program
  const b1 = tryEarnBadge('first_program');
  if (b1) newBadges.push(b1);

  // Programs run count
  const runCount = incrementStat('programs_run');
  if (runCount >= 5) {
    const b = tryEarnBadge('five_programs');
    if (b) newBadges.push(b);
  }
  if (runCount >= 10) {
    const b = tryEarnBadge('ten_programs');
    if (b) newBadges.push(b);
  }
  if (runCount >= 25) {
    const b = tryEarnBadge('marathon');
    if (b) newBadges.push(b);
  }

  // Block count (use total including nested)
  const allBlocksFlat = flattenBlocks(blocks);
  const totalBlockCount = allBlocksFlat.length;
  if (totalBlockCount >= 10) {
    const b = tryEarnBadge('ten_blocks');
    if (b) newBadges.push(b);
  }
  if (totalBlockCount >= 20) {
    const b = tryEarnBadge('twenty_blocks');
    if (b) newBadges.push(b);
  }
  if (totalBlockCount >= 50) {
    const b = tryEarnBadge('fifty_blocks');
    if (b) newBadges.push(b);
  }

  // Time-based
  const now = new Date();
  const hour = now.getHours();
  const day = now.getDay();
  if (hour >= 20 || hour < 5) {
    const b = tryEarnBadge('night_coder');
    if (b) newBadges.push(b);
  }
  if (hour >= 4 && hour < 8) {
    const b = tryEarnBadge('morning_coder');
    if (b) newBadges.push(b);
  }
  if (day === 0 || day === 6) {
    const b = tryEarnBadge('weekend_coder');
    if (b) newBadges.push(b);
  }

  // Analyze block types
  const allBlocks = allBlocksFlat;
  const types = new Set(allBlocks.map(b => b.type));

  const LOOP_TYPES = ['repeat', 'repeat_forever', 'while_sensor'];
  const COND_TYPES = ['if_obstacle', 'if_line', 'if_color', 'if_sensor_range', 'if_button'];

  if (LOOP_TYPES.some(t => types.has(t))) {
    const b = tryEarnBadge('used_loop');
    if (b) newBadges.push(b);
  }

  if (types.has('repeat_forever')) {
    const b = tryEarnBadge('forever_runner');
    if (b) newBadges.push(b);
  }

  if (hasNestedLoop(blocks)) {
    const b = tryEarnBadge('nested_loops');
    if (b) newBadges.push(b);
  }

  if (types.has('wait')) {
    const b = tryEarnBadge('wait_master');
    if (b) newBadges.push(b);
  }

  if (types.has('set_variable') || types.has('change_variable') || types.has('math_operation')) {
    const b = tryEarnBadge('used_variable');
    if (b) newBadges.push(b);
  }

  if (COND_TYPES.some(t => types.has(t))) {
    const b = tryEarnBadge('used_condition');
    if (b) newBadges.push(b);
  }

  // ─── Sensor usage ──────────────────────────────────────
  const usedSensorKinds = new Set();
  for (const b of allBlocks) {
    if (b.type === 'if_obstacle' || b.type === 'move_until' || b.type === 'get_distance') usedSensorKinds.add('distance');
    if (b.type === 'if_line') usedSensorKinds.add('line');
    if (b.type === 'if_color') usedSensorKinds.add('color');
    const s = b.sensor || b.source;
    if (s === 'loudness') usedSensorKinds.add('loudness');
    if (s === 'light' || s === 'brightness') usedSensorKinds.add('light');
    if (s === 'distance' || s === 'ultrasonic') usedSensorKinds.add('distance');
    if (s === 'line' || s === 'line_follower') usedSensorKinds.add('line');
    if (s === 'color') usedSensorKinds.add('color');
  }

  if (usedSensorKinds.has('distance')) {
    const b = tryEarnBadge('used_distance');
    if (b) newBadges.push(b);
  }
  if (usedSensorKinds.has('line')) {
    const b = tryEarnBadge('used_line');
    if (b) newBadges.push(b);
  }
  if (usedSensorKinds.has('color')) {
    const b = tryEarnBadge('used_color');
    if (b) newBadges.push(b);
  }
  if (usedSensorKinds.has('loudness')) {
    const b = tryEarnBadge('used_sound');
    if (b) newBadges.push(b);
  }
  if (usedSensorKinds.has('light')) {
    const b = tryEarnBadge('used_light');
    if (b) newBadges.push(b);
  }
  if (usedSensorKinds.size >= 2) {
    const b = tryEarnBadge('multi_sensor');
    if (b) newBadges.push(b);
  }
  if (usedSensorKinds.size >= 4) {
    const b = tryEarnBadge('sensor_master');
    if (b) newBadges.push(b);
  }

  // ─── Sound / Display ───────────────────────────────────
  if (types.has('play_tone') || types.has('play_melody')) {
    const b = tryEarnBadge('played_sound');
    if (b) newBadges.push(b);
  }

  const toneCount = allBlocks.filter(b => b.type === 'play_tone' || b.type === 'play_melody').length;
  if (toneCount >= 3) {
    const b = tryEarnBadge('tone_composer');
    if (b) newBadges.push(b);
  }

  if (types.has('display_text') || types.has('display_image') || types.has('say') || types.has('display_value')) {
    const b = tryEarnBadge('showed_display');
    if (b) newBadges.push(b);
  }

  if (types.has('display_image')) {
    const b = tryEarnBadge('display_artist');
    if (b) newBadges.push(b);
  }

  // ─── Movement / Dance ──────────────────────────────────
  const MOVE_TYPES = ['move_forward', 'move_backward', 'turn_left', 'turn_right', 'set_speed', 'turn_by', 'move_distance'];
  const moveBlocks = allBlocks.filter(b => MOVE_TYPES.includes(b.type));
  const uniqueMoves = new Set(moveBlocks.map(b => b.type));
  if (uniqueMoves.size >= 3 && moveBlocks.length >= 3) {
    const b = tryEarnBadge('dance_program');
    if (b) newBadges.push(b);
  }
  if (uniqueMoves.size >= 5) {
    const b = tryEarnBadge('mega_dance');
    if (b) newBadges.push(b);
  }
  if (
    uniqueMoves.has('move_forward') && uniqueMoves.has('move_backward') &&
    uniqueMoves.has('turn_left') && uniqueMoves.has('turn_right')
  ) {
    const b = tryEarnBadge('move_master');
    if (b) newBadges.push(b);
  }

  // ─── Combo: loop + condition + sensor ──────────────────
  const hasLoop = LOOP_TYPES.some(t => types.has(t));
  const hasCond = COND_TYPES.some(t => types.has(t));
  const hasSensorUse = usedSensorKinds.size > 0;
  if (hasLoop && hasCond && hasSensorUse) {
    const b = tryEarnBadge('combo_program');
    if (b) newBadges.push(b);
  }

  // ─── Operators ────────────────────────────────────────
  const STRING_OPS = ['string_join', 'string_letter', 'string_length', 'string_contains'];
  const OPERATOR_KINDS = {
    math:     ['math_operation'],
    random:   ['random_number'],
    compare:  ['compare'],
    logic:    ['logic_op'],
    math_fn:  ['math_function'],
    mod:      ['mod'],
    string:   STRING_OPS,
  };
  const usedOpKinds = new Set();
  for (const [kind, list] of Object.entries(OPERATOR_KINDS)) {
    if (list.some(t => types.has(t))) usedOpKinds.add(kind);
  }

  if (usedOpKinds.has('math'))    { const b = tryEarnBadge('used_math');     if (b) newBadges.push(b); }
  if (usedOpKinds.has('random'))  { const b = tryEarnBadge('used_random');   if (b) newBadges.push(b); }
  if (usedOpKinds.has('compare')) { const b = tryEarnBadge('used_compare');  if (b) newBadges.push(b); }
  if (usedOpKinds.has('logic'))   { const b = tryEarnBadge('used_logic');    if (b) newBadges.push(b); }
  if (usedOpKinds.has('math_fn')) { const b = tryEarnBadge('used_math_fn');  if (b) newBadges.push(b); }
  if (usedOpKinds.has('mod'))     { const b = tryEarnBadge('used_mod');      if (b) newBadges.push(b); }
  if (usedOpKinds.has('string'))  { const b = tryEarnBadge('used_string');   if (b) newBadges.push(b); }

  if (types.has('string_join')) {
    const b = tryEarnBadge('used_string_join');
    if (b) newBadges.push(b);
  }

  const distinctStringOps = STRING_OPS.filter(t => types.has(t)).length;
  if (distinctStringOps >= 3) {
    const b = tryEarnBadge('string_explorer');
    if (b) newBadges.push(b);
  }

  if (usedOpKinds.size >= 5) {
    const b = tryEarnBadge('operator_master');
    if (b) newBadges.push(b);
  }

  return newBadges;
}

/** Detect a loop block whose subtree contains another loop block. */
function hasNestedLoop(blocks) {
  const LOOP = new Set(['repeat', 'repeat_forever', 'while_sensor']);
  function walk(list, insideLoop) {
    for (const b of list || []) {
      const isLoop = LOOP.has(b.type);
      if (isLoop && insideLoop) return true;
      const children = [...(b.do || []), ...(b.then || []), ...(b.else || [])];
      if (walk(children, insideLoop || isLoop)) return true;
    }
    return false;
  }
  return walk(blocks, false);
}

/** Recursively flatten nested blocks (do, then, else) */
function flattenBlocks(blocks) {
  const result = [];
  for (const block of blocks) {
    result.push(block);
    if (block.do) result.push(...flattenBlocks(block.do));
    if (block.then) result.push(...flattenBlocks(block.then));
    if (block.else) result.push(...flattenBlocks(block.else));
  }
  return result;
}

/** Get progress summary */
export function getProgress() {
  const earned = getEarnedBadges();
  const total = BADGES.length;
  const count = Object.keys(earned).length;
  const stats = getStats();

  return {
    earned: count,
    total,
    percentage: Math.round((count / total) * 100),
    stats,
    recentBadge: getEarnedBadgeObjects().sort((a, b) => b.earnedAt - a.earnedAt)[0] || null,
  };
}

/** Toggle a single badge on/off (for testing) */
export function toggleBadge(badgeId) {
  const state = loadState();
  if (state.earned[badgeId]) {
    delete state.earned[badgeId];
  } else {
    state.earned[badgeId] = Date.now();
  }
  saveState(state);
  return !!state.earned[badgeId];
}

/** Reset all achievements (for testing) */
export function resetAchievements() {
  localStorage.removeItem(getStorageKey());
}
