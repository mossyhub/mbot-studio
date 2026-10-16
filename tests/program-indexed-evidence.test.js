import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readProgramEvidence, agreesWithServer, programEvidenceProfile } from '../web/src/services/program-evidence.js';
import { lowerProgram } from '../server/src/services/program-lowering.js';
import { INDEXED_PROGRAM_PROFILE } from '../server/src/services/program-encoding.js';
import { CHALLENGES } from '../web/src/services/challenge-curriculum.js';

const repeated = times => [{ type: 'repeat', times, do: [{ type: 'wait', duration: 0.01, _id: 'pause' }] }];
test('curriculum directs learners to connected robot limits, not a universal 32-step cap', () => {
  const mission = CHALLENGES.find(c=>c.id==='ch_nested_pattern');
  assert.match(mission.hint, /connected robot/i);
  assert.doesNotMatch(mission.hint, /within 32/);
});
test('known indexed profile reads 1024 executed steps with exact ordered source evidence; legacy stays bounded', () => {
  const evidence = readProgramEvidence(repeated(1024), 'indexed-v1');
  assert.equal(evidence.compiledCount, 1024);
  const sourceMap = Array.from({length:1024}, (_, compiledIndex) => ({sourceId:'pause',path:'program[0].do[0]',compiledIndex}));
  assert.deepEqual(evidence.sourceMap, sourceMap);
  const response = { sent:true,run_id:'indexed-run',compiledCount:1024,sourceMap };
  assert.equal(agreesWithServer(evidence, response), true);
  assert.equal(agreesWithServer(evidence, {...response,sourceMap:sourceMap.toReversed()}), false);
  assert.throws(() => readProgramEvidence(repeated(1025), 'indexed-v1'), /repeat/i);
  assert.throws(() => readProgramEvidence([{type:'repeat',times:513,do:[{type:'wait',duration:0},{type:'stop'}]}], 'indexed-v1'), /instructions/i);
  assert.throws(() => readProgramEvidence(repeated(33)), /instructions/i);
  assert.throws(() => readProgramEvidence(repeated(51)), /repeat/i);
  assert.throws(() => readProgramEvidence(repeated(1024), {instructions:1024,repeat:1024}), /repeat/i);
  assert.throws(() => readProgramEvidence(repeated(1024), 'unknown-v2'), /repeat/i);
  assert.equal(programEvidenceProfile('indexed-v1').observationMs, INDEXED_PROGRAM_PROFILE.limits.observationTimeoutMs);
  assert.equal(programEvidenceProfile().observationMs, 120000);
  assert.ok(Object.isFrozen(programEvidenceProfile('indexed-v1')));
});

test('evidence bounds aggregate iterations even when loops emit no commands', () => {
  const empty = times => ({type:'repeat',times,do:[]});
  const atLimit = Array.from({length:4},()=>empty(1024));
  assert.equal(readProgramEvidence(atLimit,'indexed-v1').compiledCount,0);
  assert.throws(()=>readProgramEvidence([...atLimit,empty(1)],'indexed-v1'), /iteration/i);
});

test('selected evidence profile agrees with real indexed lowerer across long static evaluation paths', () => {
  const programs = [
    repeated(1024),
    [{type:'repeat',times:32,do:[{type:'repeat',times:32,do:[{type:'wait',duration:0.01,_id:'nested'}]}]}],
    [{type:'repeat',times:1024,do:[...Array.from({length:10},(_,i)=>({type:'set_variable',name:`v${i}`,value:{type:'op_add',a:0,b:0}})),{type:'wait',duration:{type:'var_get',name:'v0'},_id:'computed'}]}],
    [{type:'repeat',times:16,do:[{type:'display_animation',frames:['a','b'],interval:0.15,_id:'frame'}]}],
    [{type:'repeat',times:512,do:[{type:'if_else_predicate',cond:{type:'op_eq',a:1,b:1},then:[{type:'say',text:'Hello',_id:'say'}, {type:'wait',duration:0.01}],else:[{type:'move_forward',duration:2,speed:20}]}]}],
  ];
  for (const blocks of programs) {
    const lowered = lowerProgram(blocks,{profile:INDEXED_PROGRAM_PROFILE});
    const evidence = readProgramEvidence(blocks,'indexed-v1');
    assert.deepEqual(evidence.sourceMap,lowered.sourceMap);
    assert.equal(evidence.compiledCount,lowered.compiledCount);
    assert.deepEqual(evidence.program,lowered.program);
    assert.equal(agreesWithServer(evidence,{...lowered,sent:true,run_id:'checked'}),true);
  }
  const bomb = [{type:'repeat',times:1024,do:Array.from({length:130},()=>({type:'set_variable',name:'x',value:1}))}];
  assert.throws(()=>readProgramEvidence(bomb,'indexed-v1'), /budget/i);
});
