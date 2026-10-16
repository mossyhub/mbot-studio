import test from 'node:test';
import assert from 'node:assert/strict';
import {canUseRecordings} from '../web/src/services/voice-recording.js';

test('explicit broker loss overrides heartbeat; legacy omitted broker remains supported',()=>{
  const status={robotOnline:true,capabilities:['recorded_audio_v1']};
  assert.equal(canUseRecordings({...status,mqttConnected:false}),false);
  assert.equal(canUseRecordings({...status,mqttConnected:true}),true);
  assert.equal(canUseRecordings(status),true);
});
