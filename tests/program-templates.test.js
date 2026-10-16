import test from 'node:test';import assert from 'node:assert/strict';
import {TEMPLATES,resolveTemplateBlocks,templateUnavailableReason} from '../web/src/services/program-templates.js';
import {lowerProgram} from '../server/src/services/program-lowering.js';import {MqttService} from '../server/src/services/mqtt-service.js';
const status={application:'cooperative-v1',build:'mbot-av-control-v1',armed:true,motion_enabled:true,capabilities:['move_forward','move_backward','turn_left','turn_right','wait','stop','play_tone','display_text','set_led','servo','dc_motor','set_volume','display_animation']};
const config={additions:[{type:'servo',port:'S1'},{type:'dc_motor',port:'M1'}]};
test('every available template lowers and passes actual robot admission without publishing',()=>{
 const service=new MqttService();service.robotStatusMetadata=status;service.robotLastSeen=service.robotStatusLastSeen=Date.now();
 assert.equal(new Set(TEMPLATES.map(t=>t.id)).size,TEMPLATES.length);
 const ready=TEMPLATES.filter(t=>!templateUnavailableReason(t,config,status));assert.equal(ready.length,8);
 for(const template of ready){const before=structuredClone(template);const program=lowerProgram(resolveTemplateBlocks(template,config)).program;assert.doesNotThrow(()=>service.validateCooperativeProgram(program),template.id);assert.deepEqual(template,before);assert.ok(program.length<=32);}
 assert.equal(service.client,null);
});
test('hardware ports resolve in nested loops and unknown/missing capabilities stay explicit',()=>{
 const template=TEMPLATES.find(t=>t.id==='tmpl_claw_cycle');const resolved=resolveTemplateBlocks(template,{additions:[{type:'dc_motor',port:'M2'}]});assert.equal(resolved[0].do[0].port,'M2');assert.equal(resolved[0].do[2].port,'M2');assert.match(templateUnavailableReason(template,{},status),/Configure/);
 assert.match(templateUnavailableReason(TEMPLATES[0],config,{}),/unverified/);assert.match(templateUnavailableReason(TEMPLATES[0],config,{...status,capabilities:[]}),/does not advertise/);
 for(const t of TEMPLATES.filter(t=>t.unavailable)){assert.ok(templateUnavailableReason(t,config,status));assert.deepEqual(t.blocks,[]);}
});
