import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as achievements from '../web/src/services/achievements.js';
import { lowerProgram } from '../server/src/services/program-lowering.js';
import { captureSubmission, acceptSubmission, completeSubmission } from '../web/src/services/challenge-progress.js';
import { CHALLENGES, CHALLENGE_SOLUTIONS } from '../web/src/services/challenge-curriculum.js';

const profile = 'history-kid';
const storageKey = `mbot-studio-achievements:${profile}`;
const earned = { first_program: 11, used_condition: 22, five_programs: 33, all_beginner: 44 };
const stats = { programs_run: 19, stars_earned: 12, challenges_completed: 7 };
beforeEach(() => {
  const store = new Map();
  globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k,v) => store.set(k,String(v)) };
  localStorage.setItem(storageKey, JSON.stringify({ earned, stats }));
});

test('unversioned reused IDs retain original meanings and dates, not current verified credit', () => {
  const before = localStorage.getItem(storageKey);
  const collection = achievements.getEarnedBadgeObjects(profile);
  const expected = {
    first_program: ['Hello Robot!', 'Run your first program.'],
    used_condition: ['Decision Maker', 'Use an if/else condition.'],
    five_programs: ['Prolific Coder', 'Run 5 different programs.'],
    all_beginner: ['Beginner Champion', 'Complete every beginner challenge.'],
  };
  for (const [id, [name, description]] of Object.entries(expected)) {
    const award = collection.find(b => b.id === id);
    assert.equal(award.legacy, true, `${id} is historical, not verified`);
    assert.equal(award.name, name);
    assert.equal(award.description, description);
    assert.equal(award.earnedAt, earned[id]);
    assert.equal(achievements.hasBadge(id, profile), false, `${id} still available under new criteria`);
  }
  const progress = achievements.getProgress(profile);
  assert.equal(progress.earned, 0);
  assert.equal(progress.legacy, 4);
  assert.equal(progress.percentage, 0);
  assert.deepEqual(progress.stats, stats);
  assert.equal(localStorage.getItem(storageKey), before, 'reading history never fabricates a migration');
});

test('Explorer Champion requires new proof for historical missions, and can earn when rechecking one', () => {
  localStorage.setItem(`mbot-studio-challenges:${profile}`, JSON.stringify({ch_forward:{stars:1,completedAt:42}}));
  const confirm = id => {
    const blocks = CHALLENGE_SOLUTIONS[id];
    const run = captureSubmission({ blocks, profileId: profile });
    acceptSubmission(run, { sent:true, run_id:id, ...lowerProgram(blocks) });
    return completeSubmission(run, {type:'program',event:'completed',run_id:id},profile);
  };
  for (const c of CHALLENGES.filter(c=>c.level===1&&c.id!=='ch_forward')) confirm(c.id);
  assert.equal(achievements.hasBadge('all_beginner',profile),false,'historical First Steps is not new verified evidence');
  const result = confirm('ch_forward');
  assert.ok(result.badges.some(b=>b.id==='all_beginner'),'rechecking the historical mission independently earns the new badge');
  assert.deepEqual(JSON.parse(localStorage.getItem(`mbot-studio-challenges:${profile}`)).ch_forward,{stars:1,completedAt:42});
  assert.equal(JSON.parse(localStorage.getItem(storageKey)).earned.all_beginner,44);
});

test('new verified criteria can be earned independently without replacing four historical awards', () => {
  const missions = [...CHALLENGES.filter(c => c.level === 1).map(c => c.id), 'ch_static_choice'];
  for (const id of missions) {
    const blocks = CHALLENGE_SOLUTIONS[id];
    const run = captureSubmission({ blocks, profileId: profile });
    acceptSubmission(run, { sent: true, run_id: id, ...lowerProgram(blocks) });
    completeSubmission(run, { type: 'program', event: 'completed', run_id: id }, profile);
    const after = localStorage.getItem(storageKey);
    assert.deepEqual(completeSubmission(run, { type: 'program', event: 'completed', run_id: id }, profile), { challenges: [], badges: [] });
    assert.equal(localStorage.getItem(storageKey), after, 'duplicate cannot rewrite award dates or counts');
  }
  const state = JSON.parse(localStorage.getItem(storageKey));
  assert.deepEqual(state.earned, earned, 'original ledger is immutable');
  const version = achievements.BADGE_CRITERIA_VERSION;
  for (const id of Object.keys(earned)) {
    assert.ok(state.earnedByVersion?.[version]?.[id] > earned[id], `${id} has its own new timestamp`);
    assert.equal(achievements.hasBadge(id, profile), true);
    const pair = achievements.getEarnedBadgeObjects(profile).filter(b => b.id === id);
    assert.equal(pair.length, 2);
    assert.equal(pair.find(b => b.legacy).earnedAt, earned[id]);
    assert.equal(pair.find(b => !b.legacy).criteriaVersion, version);
  }
  const current = achievements.getCurrentEarnedBadges(profile);
  const progress = achievements.getProgress(profile);
  assert.equal(progress.earned, Object.keys(current).length);
  assert.equal(progress.legacy, 4);
  assert.equal(state.stats.programs_run, stats.programs_run + missions.length);
  assert.equal(state.stats.stars_earned, stats.stars_earned + 8);
  assert.equal(state.stats.challenges_completed, stats.challenges_completed + missions.length);
  assert.equal(state.stats.verified_runs, missions.length);
  assert.equal(achievements.getProgress('other-kid').earned, 0);
  assert.equal(achievements.getProgress('other-kid').legacy, 0);
});
