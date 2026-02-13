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
  { id: 'first_program',    name: 'Hello Robot!',      icon: '🚀', description: 'Run your first program',                category: 'first-steps' },
  { id: 'first_chat',       name: 'Robot Whisperer',   icon: '💬', description: 'Talk to the AI assistant',              category: 'first-steps' },
  { id: 'first_live',       name: 'Joystick Master',   icon: '🎮', description: 'Use live control for the first time',   category: 'first-steps' },
  { id: 'first_voice',      name: 'Voice Commander',   icon: '🎙️', description: 'Use voice control',                     category: 'first-steps' },
  { id: 'first_save',       name: 'Saver!',            icon: '💾', description: 'Save your first project',               category: 'first-steps' },

  // === Programming ===
  { id: 'ten_blocks',       name: 'Block Builder',     icon: '🧱', description: 'Create a program with 10+ blocks',      category: 'coding' },
  { id: 'twenty_blocks',    name: 'Master Builder',    icon: '🏗️', description: 'Create a program with 20+ blocks',      category: 'coding' },
  { id: 'used_loop',        name: 'Loop-de-Loop',      icon: '🔄', description: 'Use a repeat or forever loop',          category: 'coding' },
  { id: 'used_variable',    name: 'Brain Power',       icon: '🧠', description: 'Use a variable in your program',        category: 'coding' },
  { id: 'used_condition',   name: 'Decision Maker',    icon: '🤔', description: 'Use an if/else condition',              category: 'coding' },

  // === Sensors ===
  { id: 'used_distance',    name: 'Echo Finder',       icon: '📡', description: 'Use the distance sensor',               category: 'sensors' },
  { id: 'used_line',        name: 'Line Tracker',      icon: '➖', description: 'Use the line follower sensor',           category: 'sensors' },
  { id: 'used_color',       name: 'Color Spotter',     icon: '🎨', description: 'Use the color sensor',                  category: 'sensors' },
  { id: 'used_sound',       name: 'Sound Detective',   icon: '🔊', description: 'Read the loudness sensor',              category: 'sensors' },
  { id: 'used_light',       name: 'Light Chaser',      icon: '☀️', description: 'Read the brightness sensor',            category: 'sensors' },

  // === Creative ===
  { id: 'played_sound',     name: 'DJ Robot',          icon: '🎵', description: 'Make the robot play a sound',           category: 'creative' },
  { id: 'showed_display',   name: 'Show Off',          icon: '📺', description: 'Display something on CyberPi screen',   category: 'creative' },
  { id: 'dance_program',    name: 'Dance Machine',     icon: '💃', description: 'Create a dance with 3+ moves',          category: 'creative' },
  { id: 'five_programs',    name: 'Prolific Coder',    icon: '📚', description: 'Run 5 different programs',               category: 'creative' },
  { id: 'ten_programs',     name: 'Code Ninja',        icon: '🥷', description: 'Run 10 different programs',              category: 'creative' },

  // === Challenges ===
  { id: 'first_challenge',  name: 'Challenger',        icon: '🎯', description: 'Complete your first challenge',          category: 'challenges' },
  { id: 'three_stars',      name: 'Star Collector',    icon: '⭐', description: 'Earn 3 stars in challenges',             category: 'challenges' },
  { id: 'ten_stars',        name: 'Superstar',         icon: '🌟', description: 'Earn 10 stars in challenges',            category: 'challenges' },
  { id: 'all_beginner',     name: 'Beginner Champion', icon: '🏅', description: 'Complete all beginner challenges',       category: 'challenges' },

  // === Explorer ===
  { id: 'night_coder',      name: 'Night Owl',         icon: '🦉', description: 'Program after 8 PM',                    category: 'explorer' },
  { id: 'morning_coder',    name: 'Early Bird',        icon: '🐦', description: 'Program before 8 AM',                   category: 'explorer' },
  { id: 'custom_hardware',  name: 'Hardware Hacker',   icon: '🔧', description: 'Configure custom hardware',             category: 'explorer' },
  { id: 'calibration',      name: 'Robot Teacher',     icon: '📏', description: 'Teach the robot about itself',           category: 'explorer' },
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

  // Block count
  if (blocks.length >= 10) {
    const b = tryEarnBadge('ten_blocks');
    if (b) newBadges.push(b);
  }
  if (blocks.length >= 20) {
    const b = tryEarnBadge('twenty_blocks');
    if (b) newBadges.push(b);
  }

  // Time-based
  const hour = new Date().getHours();
  if (hour >= 20 || hour < 5) {
    const b = tryEarnBadge('night_coder');
    if (b) newBadges.push(b);
  }
  if (hour >= 4 && hour < 8) {
    const b = tryEarnBadge('morning_coder');
    if (b) newBadges.push(b);
  }

  // Analyze block types
  const allBlocks = flattenBlocks(blocks);
  const types = new Set(allBlocks.map(b => b.type));

  if (types.has('repeat') || types.has('repeat_forever') || types.has('while_sensor')) {
    const b = tryEarnBadge('used_loop');
    if (b) newBadges.push(b);
  }

  if (types.has('set_variable') || types.has('change_variable') || types.has('math_operation')) {
    const b = tryEarnBadge('used_variable');
    if (b) newBadges.push(b);
  }

  if (types.has('if_obstacle') || types.has('if_line') || types.has('if_color') || types.has('if_sensor_range') || types.has('if_button')) {
    const b = tryEarnBadge('used_condition');
    if (b) newBadges.push(b);
  }

  if (types.has('if_obstacle') || types.has('move_until') || types.has('get_distance')) {
    const b = tryEarnBadge('used_distance');
    if (b) newBadges.push(b);
  }

  if (types.has('if_line')) {
    const b = tryEarnBadge('used_line');
    if (b) newBadges.push(b);
  }

  if (types.has('if_color')) {
    const b = tryEarnBadge('used_color');
    if (b) newBadges.push(b);
  }

  if (types.has('play_tone') || types.has('play_melody')) {
    const b = tryEarnBadge('played_sound');
    if (b) newBadges.push(b);
  }

  if (types.has('display_text') || types.has('display_image') || types.has('say') || types.has('display_value')) {
    const b = tryEarnBadge('showed_display');
    if (b) newBadges.push(b);
  }

  // Dance detection: 3+ different move types
  const moveTypes = allBlocks.filter(b =>
    ['move_forward', 'move_backward', 'turn_left', 'turn_right', 'set_speed'].includes(b.type)
  );
  if (moveTypes.length >= 3) {
    const uniqueMoves = new Set(moveTypes.map(b => b.type));
    if (uniqueMoves.size >= 3) {
      const b = tryEarnBadge('dance_program');
      if (b) newBadges.push(b);
    }
  }

  // Sensor blocks for loudness/brightness
  const sensorBlocks = allBlocks.filter(b =>
    b.sensor === 'loudness' || b.source === 'loudness'
  );
  if (sensorBlocks.length > 0) {
    const b = tryEarnBadge('used_sound');
    if (b) newBadges.push(b);
  }

  const lightBlocks = allBlocks.filter(b =>
    b.sensor === 'light' || b.source === 'light' || b.sensor === 'brightness'
  );
  if (lightBlocks.length > 0) {
    const b = tryEarnBadge('used_light');
    if (b) newBadges.push(b);
  }

  return newBadges;
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
