import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
test('Python OTA core and runtime adapter regression suite',{timeout:30000},()=>{
 const r=spawnSync('python3',['-m','unittest','discover','-s','tests','-p','test_ota_*.py','-v'],{encoding:'utf8',timeout:25000});
 assert.ifError(r.error);assert.equal(r.status,0,r.stdout+'\n'+r.stderr);
 assert.match(r.stderr,/Ran \d+ tests/);console.log(r.stderr.match(/Ran \d+ tests[^]*$/)?.[0].trim());
});
