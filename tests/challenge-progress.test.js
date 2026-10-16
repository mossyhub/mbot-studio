import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { lowerProgram } from '../server/src/services/program-lowering.js';
let progress;
try { progress = await import('../web/src/services/challenge-progress.js'); } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }
beforeEach(() => { const store = new Map(); globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k,v) => store.set(k,String(v)), removeItem: k => store.delete(k) }; });
const forward = duration => ({ type: 'move_forward', speed: 20, duration });
const proof = blocks => ({ sent: true, run_id: 'run-1', ...lowerProgram(blocks) });
const event = (kind = 'completed', id = 'run-1', type = 'program') => ({ type, event: kind, run_id: id });

test('only a matched terminal program completion with server trace can earn; terminal failures consume the run', () => {
  for (const kind of ['accepted', 'started', 'failed', 'canceled']) {
    const run = progress.captureSubmission({ blocks: [forward(2)], profileId: 'kid-a' });
    progress.acceptSubmission(run, proof(run.blocks));
    assert.deepEqual(progress.completeSubmission(run, event(kind), 'kid-a').challenges, []);
    if (['failed', 'canceled'].includes(kind)) assert.deepEqual(progress.completeSubmission(run, event(), 'kid-a').challenges, []);
  }
  for (const response of [{sent:true}, {sent:false,run_id:'run-1'}, {sent:true,run_id:'run-1'}, {...proof([forward(2)]),sourceMap:[]}]) {
    const run = progress.captureSubmission({ blocks: [forward(2)], profileId: 'kid-a' });
    progress.acceptSubmission(run, response);
    assert.deepEqual(progress.completeSubmission(run, event(), 'kid-a').challenges, []);
  }
});
test('unrelated, block-level and duplicate completions never count; immutable profile/blocks snapshot', () => {
  const blocks = [forward(2)];
  const run = progress.captureSubmission({blocks,profileId:'kid-a'});
  blocks[0].duration = 0;
  progress.acceptSubmission(run, proof(run.blocks));
  for (const e of [event('completed','unrelated'),event('completed','run-1','move_forward')]) assert.deepEqual(progress.completeSubmission(run,e,'kid-a').challenges,[]);
  assert.equal(progress.completeSubmission(run,event(),'kid-a').challenges.length,1);
  assert.equal(progress.completeSubmission(run,event(),'kid-a').challenges.length,0);
  const other = progress.captureSubmission({blocks:[forward(2)],profileId:'kid-b'});
  progress.acceptSubmission(other,proof(other.blocks));
  assert.equal(progress.completeSubmission(other,event(),'kid-a').challenges.length,0);
  assert.deepEqual(progress.getChallengeProgress('kid-b'),{});
});
test('zero loops, dead branches and zero speed cannot earn First Steps; live branches and arithmetic can', () => {
  const cases = [
    [[{type:'repeat',times:0,do:[forward(2)]}],false],
    [[{type:'if_predicate',cond:false,then:[forward(2)],else:[{type:'wait',duration:1}]}],false],
    [[{...forward(2),speed:0}],false],
    [[{type:'set_variable',name:'seconds',value:{type:'op_add',a:1,b:1}}, { ...forward(2), duration:{type:'var_get',name:'seconds'}}],true],
  ];
  cases.forEach(([blocks,expected],i)=>{const run=progress.captureSubmission({blocks,profileId:`case${i}`});progress.acceptSubmission(run,proof(blocks));assert.equal(progress.completeSubmission(run,event(),`case${i}`).challenges.some(c=>c.id==='ch_forward'),expected);});
});
test('all matching curriculum missions and badges are earned once, retaining historical data and ignoring editor IDs', async () => {
  const { CHALLENGE_SOLUTIONS } = await import('../web/src/services/challenge-curriculum.js');
  const achievements = await import('../web/src/services/achievements.js');
  const history = {ch_square:{stars:2,completedAt:42},ch_forward:{stars:1,completedAt:41}};
  localStorage.setItem('mbot-studio-challenges:kid-a',JSON.stringify(history));
  localStorage.setItem('mbot-studio-achievements:kid-a',JSON.stringify({earned:{night_coder:5},stats:{programs_run:8,stars_earned:3}}));
  for (let i=0;i<3;i++) {
    const blocks=structuredClone(CHALLENGE_SOLUTIONS.ch_math_pause);blocks[0]._id=`new-id-${i}`;
    const run=progress.captureSubmission({blocks,profileId:'kid-a'});
    progress.acceptSubmission(run,{...proof(blocks),run_id:i<2?'once':'twice'});
    progress.completeSubmission(run,event('completed',i<2?'once':'twice'),'kid-a');
  }
  const state=JSON.parse(localStorage.getItem('mbot-studio-achievements:kid-a'));
  assert.equal(state.stats.verified_runs,2);
  assert.equal(state.stats.distinct_programs,1);
  assert.equal(state.earned.night_coder,5);
  assert.ok(state.earnedByVersion[achievements.BADGE_CRITERIA_VERSION].used_math);
  assert.ok(state.earnedByVersion[achievements.BADGE_CRITERIA_VERSION].first_challenge);
  assert.deepEqual(state.earned, {night_coder:5});
  assert.deepEqual(progress.getChallengeProgress('kid-a').ch_forward,history.ch_forward);
  assert.deepEqual(progress.getChallengeProgress('kid-a').ch_square,history.ch_square);
  assert.ok(progress.getChallengeProgress('kid-a').ch_math_pause);
  assert.ok(achievements.BADGES.filter(b=>!b.legacy).every(b=>!['night_coder','morning_coder','fifty_blocks','forever_runner','used_distance','used_string'].includes(b.id)));
});

test('First Steps credits an exact completed submission automatically, including equivalent repeats', () => {
  assert.equal(typeof progress?.captureSubmission, 'function', 'automatic challenge progress must exist');
  const blocks = [{ type: 'repeat', times: 2, do: [forward(1)] }];
  const run = progress.captureSubmission({ blocks, profileId: 'kid-a' });
  progress.acceptSubmission(run, proof(blocks));
  const result = progress.completeSubmission(run, { type: 'program', event: 'completed', run_id: 'run-1' }, 'kid-a');
  assert.ok(result.challenges.some(c => c.id === 'ch_forward'));
  assert.equal(progress.getChallengeProgress('kid-a').ch_forward.verification, 'device-completed');
});
