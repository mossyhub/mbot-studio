import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {MqttService} from '../server/src/services/mqtt-service.js';

test('default recording transfer tolerates multi-tick device BEGIN latency', async () => {
  const m=new MqttService(), audio=Buffer.from('test'), id=createHash('sha256').update(audio).digest('hex');
  m.connected=true;m.robotState='ready';m.robotLastSeen=m.robotStatusLastSeen=Date.now();
  m.robotStatusMetadata={application:'cooperative-v1',build:'mbot-av-control-v1',boot:'latency-test',capabilities:['recorded_audio_v1','play_recording']};
  const timers=[];let begins=0;
  m.client={connected:true,publish(topic,payload,options,callback){
    callback?.();const p=JSON.parse(payload);if(p.op==='abort')return;
    if(p.op==='begin')begins++;
    timers.push(setTimeout(()=>m.recordingTransfer.handleAck({op:p.op,transfer_id:p.transfer_id,boot:p.boot,id,ok:true,offset:p.op==='begin'?0:audio.length}),p.op==='begin'?2800:0));
  }};
  try {
    await m.recordingTransfer.run([id],async()=>({id,sha256:id,size:audio.length,duration_ms:1000,audio}));
    assert.equal(begins,1,'healthy multi-tick BEGIN should not be retried early');
    assert.equal(m.recordingTransfer.getVerification(id).verified,true);
  } finally { for(const t of timers)clearTimeout(t);m.recordingTransfer.invalidate('test cleanup'); }
});
