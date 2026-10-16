import { programFingerprint } from './program-evidence.js';
import { CHALLENGES, evaluateChallenge } from './challenge-curriculum.js';
// Retired debug APIs intentionally cannot erase history or fabricate badges.
export function resetAchievements() { return false; }
export function toggleBadge() { return false; }
let activeProfileId = 'default';
const key = id => `mbot-studio-achievements:${id || 'default'}`;
export const setAchievementsProfile = id => { activeProfileId = id || 'default'; };
export const getAchievementsProfile = () => activeProfileId;
const badge = (id,name,icon,category,description) => ({id,name,icon,category,description,hint:description});
export const BADGES = [
  badge('first_program','Hello Robot!','🚀','coding','Finish a program with matching device confirmation.'),
  badge('used_loop','Loop-de-Loop','🔄','coding','Complete a program with a reached, non-zero repeat.'),
  badge('nested_loops','Pattern Architect','🌀','coding','Complete a program with reached nested repeats.'),
  badge('used_variable','Brain Power','🧠','coding','Use a static number variable in a completed program.'),
  badge('used_condition','Decision Maker','🤔','coding','Evaluate a static if in a completed program; no live sensor branching.'),
  badge('wait_master','Patient Robot','⏳','coding','Complete a program with a positive-duration wait.'),
  badge('used_math','Number Cruncher','➕','operators','Use an op +, −, × or ÷ reporter in reached code.'),
  badge('used_compare','Truth Seeker','⚖️','operators','Evaluate a numeric op comparison in reached code.'),
  badge('used_logic','Logic Wizard','🔀','operators','Evaluate static and, or or not in reached code.'),
  badge('used_math_fn','Function Fan','ƒ','operators','Evaluate supported abs or round in reached code.'),
  badge('used_mod','Remainder Hero','‰','operators','Evaluate a static modulo reporter in reached code.'),
  badge('played_sound','DJ Robot','🎵','creative','Complete a program with a tone or built-in sound.'),
  badge('tone_composer','Composer','🎼','creative','Complete a program with at least 3 positive-duration tones.'),
  badge('showed_display','Show Off','📺','creative','Complete a program with LCD text or text-frame animation.'),
  badge('text_animator','Text Animator','🎞️','creative','Complete a program with at least 2 different text frames.'),
  badge('five_programs','Prolific Coder','📚','coding','Complete 5 distinct programs. Changing editor IDs does not count.'),
  badge('ten_programs','Code Ninja','🥷','coding','Complete 10 distinct programs. Re-running the same code is practice.'),
  badge('first_challenge','Challenger','🎯','challenges','Automatically earn your first programming mission.'),
  badge('three_stars','Star Collector','⭐','challenges','Earn at least 3 new mission stars with device confirmation.'),
  badge('ten_stars','Superstar','🌟','challenges','Earn at least 10 new mission stars with device confirmation.'),
  badge('all_beginner','Explorer Champion','🏅','challenges','Complete all current Level 1 Explorer missions.'),
  badge('first_chat','Robot Whisperer','💬','studio','Get a response from the AI helper.'),
  badge('first_save','Saver!','💾','studio','Save your first project.'),
  badge('custom_hardware','Hardware Planner','🔧','studio','Save a custom hardware configuration. This does not verify wiring.'),
];
const legacyNames = {
  first_live:'Joystick Master',first_voice:'Voice Commander',ten_blocks:'Block Builder',twenty_blocks:'Master Builder',fifty_blocks:'Mega Builder',forever_runner:'Infinity Mode',combo_program:'Combo Coder',used_random:'Lucky Dice',used_string:'Word Smith',used_string_join:'String Stitcher',string_explorer:'String Explorer',operator_master:'Operator Master',used_distance:'Echo Finder',used_line:'Line Tracker',used_color:'Color Spotter',used_sound:'Sound Detective',used_light:'Light Chaser',multi_sensor:'Sensor Sleuth',sensor_master:'Sensor Master',display_artist:'Pixel Artist',dance_program:'Dance Machine',mega_dance:'Dance Party',move_master:'Four-Way Pro',marathon:'Marathon Coder',night_coder:'Night Owl',morning_coder:'Early Bird',weekend_coder:'Weekend Warrior',calibration:'Robot Teacher',
};
// Freeze the original catalog meanings. An unversioned timestamp is never
// evidence for the replacement criterion, even when its badge ID is reused.
export const BADGE_CRITERIA_VERSION = 'curriculum-v2';
const originalCriteria = {
  first_program: ['Hello Robot!', 'Run your first program.'],
  used_loop: ['Loop-de-Loop', 'Use a repeat or forever loop.'],
  nested_loops: ['Loopception', 'Put a loop inside another loop.'],
  used_variable: ['Brain Power', 'Use a variable in your program.'],
  used_condition: ['Decision Maker', 'Use an if/else condition.'],
  wait_master: ['Patient Robot', 'Use a wait block.'],
  used_math: ['Number Cruncher', 'Use a math block (+, −, ×, ÷).'],
  used_compare: ['Truth Seeker', 'Compare two values with an operator block.'],
  used_logic: ['Logic Wizard', 'Combine values with and / or / not.'],
  used_math_fn: ['Function Fan', 'Use a math function (abs, sqrt, sin, …).'],
  used_mod: ['Remainder Hero', 'Use the modulo (mod) block.'],
  played_sound: ['DJ Robot', 'Make the robot play a sound.'],
  tone_composer: ['Composer', 'Play 3 or more tones in one program.'],
  showed_display: ['Show Off', 'Display something on the CyberPi screen.'],
  five_programs: ['Prolific Coder', 'Run 5 different programs.', 'Just keep running programs — every Run counts!'],
  ten_programs: ['Code Ninja', 'Run 10 different programs.'],
  first_challenge: ['Challenger', 'Complete your first challenge.'],
  three_stars: ['Star Collector', 'Earn 3 stars in challenges.'],
  ten_stars: ['Superstar', 'Earn 10 stars in challenges.'],
  all_beginner: ['Beginner Champion', 'Complete every beginner challenge.'],
  first_chat: ['Robot Whisperer', 'Talk to the AI assistant.'],
  first_save: ['Saver!', 'Save your first project.'],
  custom_hardware: ['Hardware Hacker', 'Configure custom hardware on the robot.'],
};
export const LEGACY_BADGES = [
  ...Object.entries(legacyNames).map(([id,name])=>({...badge(id,name,'🏵️','legacy','Historical badge — preserved from an earlier curriculum; no longer awarded.'),legacy:true})),
  ...Object.entries(originalCriteria).map(([id,[name,description,hint]])=>({...badge(id,name,'🏵️','legacy',description),hint:hint||description,legacy:true})),
];
function load(id = activeProfileId) {
  try { const s=JSON.parse(localStorage.getItem(key(id))||'{}'); return {...s,earned:s.earned||{},stats:s.stats||{}}; }
  catch { return {earned:{},stats:{}}; }
}
function save(s,id=activeProfileId) { localStorage.setItem(key(id),JSON.stringify(s)); }
// Kept as the original, unversioned ledger for callers exporting old progress.
export function getEarnedBadges(id=activeProfileId) { return load(id).earned; }
export function getCurrentEarnedBadges(id=activeProfileId) { return load(id).earnedByVersion?.[BADGE_CRITERIA_VERSION] || {}; }
export function getEarnedBadgeObjects(id=activeProfileId) {
  const state = load(id);
  const historical = Object.entries(state.earned).map(([badgeId,earnedAt])=>({
    ...(LEGACY_BADGES.find(b=>b.id===badgeId)||{id:badgeId,name:badgeId,icon:'🏵️',legacy:true,description:'Historical badge — preserved.'}),
    earnedAt, criteriaVersion:'unversioned',
  }));
  const current = Object.entries(state.earnedByVersion?.[BADGE_CRITERIA_VERSION] || {})
    .filter(([badgeId])=>BADGES.some(b=>b.id===badgeId))
    .map(([badgeId,earnedAt])=>({...BADGES.find(b=>b.id===badgeId),earnedAt,criteriaVersion:BADGE_CRITERIA_VERSION}));
  return [...historical, ...current];
}
export function hasBadge(id,profileId=activeProfileId) { return Object.hasOwn(getCurrentEarnedBadges(profileId),id); }
export function getStats(id=activeProfileId) { return load(id).stats; }
export function incrementStat(name,by=1,id=activeProfileId) { const s=load(id);s.stats[name]=(s.stats[name]||0)+by;save(s,id);return s.stats[name]; }
function earn(s,id,newBadges) {
  const b=BADGES.find(b=>b.id===id);
  s.earnedByVersion ||= {};
  const current = s.earnedByVersion[BADGE_CRITERIA_VERSION] ||= {};
  if(b&&!Object.hasOwn(current,id)) {
    current[id]=Date.now();
    newBadges.push({...b,criteriaVersion:BADGE_CRITERIA_VERSION});
  }
}
// Studio actions only. Program/challenge badges cannot be manually awarded.
export function tryEarnBadge(id,profileId=activeProfileId) {
  if(!BADGES.some(b=>b.id===id&&b.category==='studio'))return null;
  const s=load(profileId),newBadges=[];earn(s,id,newBadges);save(s,profileId);return newBadges[0]||null;
}
export function checkProgramAchievements(blocks, receipt) {
  if(!receipt?.confirmed || !receipt.profileId || !receipt.runId || !receipt.evidence) return [];
  const {profileId,runId,evidence,newChallenges=[]}=receipt;
  const s=load(profileId);s.verifiedRunIds ||= [];
  if(s.verifiedRunIds.includes(runId))return [];
  s.verifiedRunIds.push(runId);
  // Historical mission entries remain untouched. The new Explorer badge needs
  // its own current-criteria evidence, including re-runs of historical missions.
  const explorer = CHALLENGES.filter(c=>c.level===1);
  s.explorerMissionsByVersion ||= {};
  const verifiedExplorer = s.explorerMissionsByVersion[BADGE_CRITERIA_VERSION] ||= [];
  for(const c of explorer) {
    if(!verifiedExplorer.includes(c.id)&&evaluateChallenge(c,evidence).every(g=>g.done)) verifiedExplorer.push(c.id);
  }
  const allExplorer=explorer.every(c=>verifiedExplorer.includes(c.id));
  s.programFingerprints ||= [];
  const fingerprint=programFingerprint(blocks);
  if(!s.programFingerprints.includes(fingerprint))s.programFingerprints.push(fingerprint);
  s.stats.verified_runs=(s.stats.verified_runs||0)+1;
  s.stats.programs_run=(s.stats.programs_run||0)+1;
  s.stats.distinct_programs=s.programFingerprints.length;
  s.stats.verified_stars=(s.stats.verified_stars||0)+newChallenges.reduce((n,c)=>n+c.stars,0);
  s.stats.stars_earned=(s.stats.stars_earned||0)+newChallenges.reduce((n,c)=>n+c.stars,0);
  s.stats.challenges_completed=(s.stats.challenges_completed||0)+newChallenges.length;
  const out=[],has=t=>evidence.types.has(t),some=ts=>ts.some(has),of=t=>evidence.program.filter(b=>b.type===t);
  earn(s,'first_program',out);
  const checks={used_loop:has('repeat'),nested_loops:has('nested_repeat'),used_variable:has('var_get'),used_condition:some(['if_predicate','if_else_predicate']),wait_master:of('wait').some(b=>(b.duration??1)>0),used_math:some(['op_add','op_sub','op_mul','op_div']),used_compare:some(['op_gt','op_lt','op_eq']),used_logic:some(['op_and','op_or','op_not']),used_math_fn:some(['op_abs','op_round']),used_mod:has('op_mod'),played_sound:has('play_sound')||of('play_tone').some(b=>(b.duration??0.5)>0),tone_composer:of('play_tone').filter(b=>(b.duration??0.5)>0).length>=3,showed_display:some(['display_text','say','display_animation']),text_animator:of('display_animation').some(b=>new Set(b.frames).size>=2),five_programs:s.stats.distinct_programs>=5,ten_programs:s.stats.distinct_programs>=10,first_challenge:newChallenges.length>0,three_stars:s.stats.verified_stars>=3,ten_stars:s.stats.verified_stars>=10,all_beginner:allExplorer};
  for(const [id,yes] of Object.entries(checks))if(yes)earn(s,id,out);
  save(s,profileId);return out;
}
export function getProgress(profileId=activeProfileId) {
  const earned=getEarnedBadgeObjects(profileId),active=earned.filter(b=>!b.legacy);
  return {earned:active.length,total:BADGES.length,legacy:earned.length-active.length,percentage:Math.round(active.length/BADGES.length*100),stats:getStats(profileId),recentBadge:earned.sort((a,b)=>b.earnedAt-a.earnedAt)[0]||null};
}
