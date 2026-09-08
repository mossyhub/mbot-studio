import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
test('cooperative scheduler and runtime adapters software regression suite',{timeout:30000},()=>{
 const r=spawnSync('python3',['-m','pytest','tests/test_robot_engine.py','tests/test_robot_app.py','tests/test_robot_control.py','tests/test_robot_control_diagnostics.py','tests/test_control_builder.py','-q'],{encoding:'utf8',timeout:25000});assert.ifError(r.error);assert.equal(r.status,0,r.stdout+'\n'+r.stderr);assert.match(r.stdout,/[1-9]\d* passed/);console.log(r.stdout.trim());
});
