import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {buildBootstrap} from '../server/src/services/ota-bootstrap.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('bootstrap CLI does not echo malformed WiFi settings',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ota-bootstrap-'));
 try{
  const file=path.join(dir,'bad.json');fs.writeFileSync(file,'PRIVATE_WIFI_SENTINEL');
  const r=spawnSync(process.execPath,['tools/ota-bootstrap.mjs','--config',file,'--out',path.join(dir,'out')],{encoding:'utf8'});
  assert.equal(r.status,1);assert.ok(!r.stderr.includes('PRIVATE_'));assert.ok(!fs.existsSync(path.join(dir,'out')));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
const settings={wifiSsid:'test-only',wifiPassword:'test$&"\\\n',mqttBroker:'192.0.2.1',mqttPort:1883,prefix:'test-ota',device:'robot-test'};
const core='class OtaEngine:\n    pass\n';
const loader='from ota_core import OtaEngine\ndef main():\n    pass\nif __name__ == "__main__":\n    main()\n';
test('bootstrap preserves literals, inlines one core, and hashes exact bytes',()=>{
 const artifact=buildBootstrap(settings,{core,loader});
 assert.equal(artifact.kind,'mbot-ota-bootstrap-v1');assert.equal(artifact.files.length,1);assert.equal(artifact.files[0].name,'main.py');
 const r=spawnSync('python3',['-c','import ast,json,sys; s=sys.stdin.read(); t=ast.parse(s); compile(t,"<bootstrap>","exec"); print(json.dumps({n.targets[0].id:ast.literal_eval(n.value) for n in t.body if isinstance(n,ast.Assign) and isinstance(n.targets[0],ast.Name)}))'],{input:artifact.files[0].content,encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);const constants=JSON.parse(r.stdout);assert.equal(constants.WIFI_PASSWORD,settings.wifiPassword);assert.equal('OTA_KEY_HEX' in constants,false);assert.equal(constants.OTA_DEVICE,settings.device);
 assert.ok(!artifact.files[0].content.includes('from ota_core import'));assert.equal(artifact.sha256.length,64);
});
test('USB bootstrap invokes entrypoint regardless of vendor execution namespace',()=>{
 const candidate=loader.replace('    pass','    global reached\n    reached = True');
 const artifact=buildBootstrap(settings,{core,loader:candidate});
 const script='import json,sys;source=sys.stdin.read();results=[]\nfor name in ["__main__","main1","vendor_user_script"]:\n ns={"__name__":name};exec(source,ns);results.append(ns.get("reached",False))\nprint(json.dumps(results))';
 const r=spawnSync('python3',['-c',script],{input:artifact.files[0].content,encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),[true,true,true]);
});
for(const patch of [{device:'../x'},{prefix:'a/#'},{mqttPort:0},{mqttPort:65536},{wifiSsid:''},{mqttBroker:''}])test('reject invalid provisioning '+JSON.stringify(Object.keys(patch)),()=>{assert.throws(()=>buildBootstrap({...settings,...patch},{core,loader}));});
