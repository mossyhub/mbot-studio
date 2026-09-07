import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {buildRobotApp} from '../server/src/services/robot-app-builder.js';
const cfg={broker:'192.0.2.1',port:1883,prefix:'mbot-studio',device:'mbot2-rover'};
test('app bundle inlines engine and disables motion with explicit configuration',()=>{
 const a=buildRobotApp(cfg,{engine:'class RobotEngine:\n    pass\n',app:'from robot_engine import RobotEngine\nOTA_APP_PROTOCOL=1\ndef ota_init(context):\n    pass\ndef ota_step(context):\n    pass\n'});
 assert.ok(a.bytes.length>0);assert.match(a.sha256,/^[0-9a-f]{64}$/);assert.ok(!a.bytes.toString().includes('from robot_engine import'));
 const r=spawnSync('python3',['-c','import ast,sys,json;t=ast.parse(sys.stdin.read());compile(t,"<app>","exec");print(json.dumps({n.targets[0].id:ast.literal_eval(n.value) for n in t.body if isinstance(n,ast.Assign)}))'],{input:a.bytes,encoding:'utf8'});assert.equal(r.status,0,r.stderr);const values=JSON.parse(r.stdout);assert.equal(values.MOTION_ENABLED,false);assert.equal(values.ROBOT_MQTT_BROKER,cfg.broker);assert.equal(values.ROBOT_DEVICE,cfg.device);
});
test('app builder rejects arbitrary or missing provisioning',()=>{for(const bad of [{...cfg,device:'a/#'},{...cfg,port:0},{...cfg,broker:''},{...cfg,prefix:'a/#'}])assert.throws(()=>buildRobotApp(bad,{engine:'',app:''}));});
