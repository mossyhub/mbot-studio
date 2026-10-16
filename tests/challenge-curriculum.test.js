import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lowerProgram } from '../server/src/services/program-lowering.js';
import { MqttService } from '../server/src/services/mqtt-service.js';
import { readProgramEvidence, programFingerprint } from '../web/src/services/program-evidence.js';
let curriculum;
try { curriculum = await import('../web/src/services/challenge-curriculum.js'); } catch(e) { if(e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }
const config = { additions: [{type:'servo',port:'S1'}, {type:'dc_motor',port:'M1'}] };
test('Turn Sampler rejects zero-duration waits between otherwise qualifying turns', () => {
  const mission = curriculum.CHALLENGES.find(c=>c.id==='ch_tiny_turns');
  const blocks = [{type:'turn_left',angle:10},{type:'wait',duration:0},{type:'turn_right',angle:10}];
  const goals = curriculum.evaluateChallenge(mission,readProgramEvidence(blocks),config);
  assert.equal(goals[0].done,true);
  assert.equal(goals[1].done,false,'a zero-duration wait is not a pause');
});

test('Turn Sampler pause must separate qualifying turns, in either order', () => {
  const mission = curriculum.CHALLENGES.find(c=>c.id==='ch_tiny_turns');
  const left = {type:'turn_left',angle:10}, right = {type:'turn_right',angle:10}, wait = {type:'wait',duration:0.1};
  for (const [first,last] of [[left,right],[right,left]]) {
    const rejected = [
      [first,last,wait],
      [wait,first,last],
      [{...first,angle:0},wait,last,first],
      [last,first,wait,{...last,angle:0}],
      [{...first,angle:31},wait,last,first],
    ];
    for (const blocks of rejected) assert.equal(curriculum.evaluateChallenge(mission,readProgramEvidence(blocks),config).every(g=>g.done),false,JSON.stringify(blocks));
    assert.equal(curriculum.evaluateChallenge(mission,readProgramEvidence([first,wait,last]),config).every(g=>g.done),true);
  }
});

test('static-choice mission requires outputs from the chosen branch, not unrelated outside actions', () => {
 const c=curriculum.CHALLENGES.find(c=>c.id==='ch_static_choice');
 const blocks=[{type:'if_predicate',cond:{type:'op_gt',a:2,b:1},then:[],else:[{type:'set_led',color:'red'}]}, {type:'set_led',color:'green'},{type:'display_text',text:'outside'}];
 assert.equal(curriculum.evaluateChallenge(c,readProgramEvidence(blocks),config).every(g=>g.done),false);
});

test('all supported reporters agree with the real lowerer; dead math never earns a badge', async () => {
 const numeric=[['op_add',1,1],['op_sub',4,2],['op_mul',1,2],['op_div',4,2],['op_mod',-4,3],['op_abs',-2],['op_round',2.5],['op_round',3.5],['op_round',-2.5]];
 for(const [type,a,b] of numeric){const blocks=[{type:'wait',duration:{type,a,...(b===undefined?{}:{b})}}];const actual=lowerProgram(blocks);assert.deepEqual(readProgramEvidence(blocks).program,actual.program,type);}
 for(const cond of [{type:'op_gt',a:2,b:1},{type:'op_lt',a:2,b:1},{type:'op_eq',a:2,b:2},{type:'op_and',a:true,b:false},{type:'op_or',a:false,b:true},{type:'op_not',a:false}]) {
  const blocks=[{type:'if_else_predicate',cond,then:[{type:'say',text:'yes'}],else:[{type:'display_animation',frames:['no','again'],interval:0.3}]}];
  const actual=lowerProgram(blocks),e=readProgramEvidence(blocks);assert.deepEqual(e.program,actual.program);assert.deepEqual(e.sourceMap,actual.sourceMap);
 }
 const {captureSubmission,acceptSubmission,completeSubmission}=await import('../web/src/services/challenge-progress.js');
 const store=new Map();globalThis.localStorage={getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v)};
 const blocks=[{type:'repeat',times:0,do:[{type:'wait',duration:{type:'op_add',a:1,b:1}}]},{type:'if_predicate',cond:false,then:[{type:'play_sound',sound:'hello'}]},{type:'wait',duration:0.1}];
 const run=captureSubmission({blocks,profileId:'dead'});acceptSubmission(run,{sent:true,run_id:'dead-run',...lowerProgram(blocks)});
 const result=completeSubmission(run,{type:'program',event:'completed',run_id:'dead-run'},'dead');
 assert.ok(!result.badges.some(b=>['used_loop','used_math','played_sound'].includes(b.id)));
});

test('three-level curriculum has unfinished deterministic starters and real admitted solution fixtures', () => {
  assert.ok(curriculum?.CHALLENGES, 'new curriculum is required');
  const {CHALLENGES,CHALLENGE_SOLUTIONS,evaluateChallenge,challengeAvailability} = curriculum;
  assert.ok(CHALLENGES.length >= 15);
  assert.equal(new Set(CHALLENGES.map(c=>c.level)).size,3);
  const mqtt = new MqttService(); mqtt.connected = true;
  mqtt.robotLastSeen = mqtt.robotStatusLastSeen = Date.now(); mqtt.robotState = 'ready';
  mqtt.robotStatusMetadata = {application:'cooperative-v1',build:'mbot-av-control-v1',armed:true,motion_enabled:true,capabilities:['move_forward','move_backward','turn_left','turn_right','wait','stop','set_led','display_text','play_tone','play_sound','display_animation','servo','dc_motor','set_volume','stop_sound']};
  for (const c of CHALLENGES) {
    const blocks = CHALLENGE_SOLUTIONS[c.id]; assert.ok(blocks, c.id);
    const actual = lowerProgram(blocks,{validateBlock:b=>mqtt.validateCooperativeProgram([b])});
    mqtt.validateCooperativeProgram(actual.program);
    mqtt.validateCooperativePayload(JSON.stringify({program:actual.program,run_id:'fixture',timestamp:Date.now()}));
    const evidence = readProgramEvidence(blocks);
    assert.equal(programFingerprint(evidence.program),programFingerprint(actual.program),c.id);
    assert.deepEqual(evidence.sourceMap,actual.sourceMap,c.id);
    assert.ok(evaluateChallenge(c,evidence,config).every(g=>g.done),c.id);
    assert.ok(!evaluateChallenge(c,readProgramEvidence(c.starter),config).every(g=>g.done),`${c.id} starter is not a solution`);
    assert.equal(challengeAvailability(c,config),null);
    if(c.hardware) assert.ok(challengeAvailability(c,{}),c.id);
  }
});
