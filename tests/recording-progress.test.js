// No MQTT connection, real assets, microphone or server startup.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import express from 'express';
import {RecordingTransfer} from '../server/src/services/recording-transfer.js';
import {createRecordingRoutes} from '../server/src/routes/recordings.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture() {
 const audio=Buffer.alloc(600,7),id=createHash('sha256').update(audio).digest('hex');
 const asset={id,sha256:id,size:audio.length,duration_ms:1000,audio},packets=[];
 const mqtt={connected:true,client:{connected:true},robotState:'ready',driveHold:{active:null},robotStatusLastSeen:Date.now(),constructor:{ROBOT_TIMEOUT:60000},
  robotStatusMetadata:{application:'cooperative-v1',build:'mbot-av-control-v1',boot:'boot-A',capabilities:['recorded_audio_v1']},
  isRobotOnline:()=>true,isCooperativeApp:()=>true,topicPrefix:'fixture',publishRecorded:(_topic,raw)=>packets.push(JSON.parse(raw))};
 const transfer=new RecordingTransfer(mqtt,{ackTimeoutMs:5000,sessionTimeoutMs:10000});
 const ack=(offset,extra={})=>{const p=packets.at(-1);transfer.handleAck({transfer_id:p.transfer_id,boot:p.boot,op:p.op,id,ok:true,offset,...extra});};
 return {transfer,mqtt,packets,asset,ack};
}
test('progress counts only matched ACK bytes, distinguishes verification, and retains terminal result',async t=>{
 const f=fixture();t.after(()=>f.transfer.invalidate('teardown'));
 assert.equal(f.transfer.getProgress().active,false);
 const run=f.transfer.run([f.asset.id],()=>f.asset);await tick();
 const begin=f.transfer.getProgress();assert.equal(begin.active,true);assert.equal(begin.phase,'beginning');assert.equal(begin.totalBytes,600);assert.equal(begin.ackedBytes,0);assert.equal(begin.assetId,f.asset.id);
 f.ack(0);await tick();assert.equal(f.transfer.getProgress().phase,'transferring');assert.equal(f.transfer.getProgress().ackedBytes,0);
 f.ack(511);await tick();assert.equal(f.transfer.getProgress().ackedBytes,0);
 f.ack(512);await tick();assert.equal(f.transfer.getProgress().ackedBytes,512);
 f.ack(600);await tick();assert.equal(f.transfer.getProgress().phase,'verifying');assert.equal(f.transfer.getProgress().ackedBytes,600);assert.equal(f.transfer.verifications.size,0);
 const detached=f.transfer.getProgress();detached.ackedBytes=0;assert.equal(f.transfer.getProgress().ackedBytes,600);
 f.ack(600);await run;
 assert.equal(f.transfer.getProgress().phase,'succeeded');assert.equal(f.transfer.getProgress().active,false);assert.equal(f.transfer.verifications.size,1);
 assert.deepEqual(f.transfer.getProgress(),f.transfer.getProgress());
 const publicKeys=['active','generation','sessionId','bootId','assetId','assetIndex','assetCount','phase','ackedBytes','totalBytes','startedAt','updatedAt','endedAt','error'];
 assert.ok(Object.keys(f.transfer.getProgress()).every(key=>publicKeys.includes(key)));
 assert.equal(JSON.stringify(f.transfer.getProgress()).includes(f.asset.audio.toString('hex')),false);
});
test('cancel and stale old continuations cannot overwrite a new owner progress',async t=>{
 const f=fixture();t.after(()=>f.transfer.invalidate('teardown'));let release;
 const old=f.transfer.run([f.asset.id],()=>new Promise(r=>release=r));const rejected=assert.rejects(old,/Stop/);
 const generation=f.transfer.getProgress().generation;assert.equal(f.transfer.getProgress().phase,'loading');assert.equal(f.transfer.getProgress().totalBytes,null);
 f.transfer.invalidate('Emergency Stop');await rejected;assert.equal(f.transfer.getProgress().phase,'canceled');
 const fresh=f.transfer.run([f.asset.id],()=>f.asset);const canceled=assert.rejects(fresh,/Stop/);await tick();
 assert.ok(f.transfer.getProgress().generation>generation);const next=f.transfer.getProgress();release(f.asset);await tick();assert.deepEqual(f.transfer.getProgress(),next);
 f.transfer.invalidate('Emergency Stop');await canceled;
});
test('transfer timeout is a safe terminal failure retaining last confirmed offset',async t=>{
 const f=fixture();t.after(()=>f.transfer.invalidate('teardown'));f.transfer.ackTimeoutMs=5;f.transfer.retries=0;
 const run=f.transfer.run([f.asset.id],()=>f.asset);const rejected=assert.rejects(run,/ACK timeout/);await rejected;
 assert.equal(f.transfer.getProgress().phase,'failed');assert.equal(f.transfer.getProgress().active,false);assert.equal(f.transfer.getProgress().ackedBytes,0);assert.match(f.transfer.getProgress().error,/confirm|timeout/i);
});
test('real router exposes only snapshot and returns bounded409 on actual transfer Stop',async t=>{
 const f=fixture();const service={syncAdapter:f.transfer,sync:()=>f.transfer.run([f.asset.id],()=>f.asset)};
 const app=express();app.use('/api/robot/recordings',createRecordingRoutes({service}));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{f.transfer.invalidate('teardown');await new Promise(r=>server.close(r));});
 const base=`http://127.0.0.1:${server.address().port}/api/robot/recordings`;
 let response=await fetch(`${base}/transfer-status`);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal((await response.json()).active,false);assert.equal(f.packets.length,0);
 const pending=fetch(`${base}/${f.asset.id}/sync`,{method:'POST'});while(!f.transfer.active)await tick();await tick();
 const snapshot=await (await fetch(`${base}/transfer-status`)).json();assert.equal(snapshot.active,true);assert.equal(snapshot.ackedBytes,0);
 f.transfer.invalidate('Emergency Stop');response=await pending;assert.equal(response.status,409);const body=await response.json();assert.equal(body.code,'RECORDING_TRANSFER_REJECTED');assert.match(body.error,/cancel/i);assert.doesNotMatch(body.error,/internal/);
 assert.equal((await (await fetch(`${base}/transfer-status`)).json()).phase,'canceled');
});
