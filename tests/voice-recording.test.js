import test from 'node:test';
import assert from 'node:assert/strict';
import * as voice from '../web/src/services/voice-recording.js';

test('browser support checks secure context and actual offered MIME types', () => {
  const Recorder = {isTypeSupported: mime => mime === 'audio/webm;codecs=opus'};
  const env = {isSecureContext:true, MediaRecorder:Recorder, navigator:{mediaDevices:{getUserMedia(){}}}};
  assert.equal(voice.recordingSupport(env).mimeType, 'audio/webm;codecs=opus');
  assert.match(voice.recordingSupport({...env,isSecureContext:false}).error, /HTTPS/);
  assert.match(voice.recordingSupport({...env,MediaRecorder:null}).error, /support/);
  assert.match(voice.recordingSupport({...env,MediaRecorder:{isTypeSupported:()=>false}}).error, /format/);
});
test('asset validation rejects malformed, overlong, and unready selection', () => {
  const asset = {id:'clip-1',name:'Hello',durationMs:3000,bytes:1400,ready:true};
  assert.deepEqual(voice.recordingBlock(asset), {type:'play_recording',recording:'clip-1'});
  for (const bad of [{...asset,durationMs:3001},{...asset,bytes:0},{...asset,id:'../x'},{...asset,ready:'yes'}]) {
    assert.throws(()=>voice.validateRecording(bad));
  }
  assert.throws(()=>voice.recordingBlock({...asset,ready:false}));
});
test('upload preserves actual encoded MIME and raw body; list/delete use same-origin API', async () => {
  const asset = {id:'clip-1',name:'Hello',durationMs:450,bytes:1400,ready:true};
  const calls = [];
  const fetcher = async (url, options) => { calls.push({url,options}); return {ok:true,status:200,json:async()=>options?.method==='POST'?asset:options?.method==='DELETE'?{}:{recordings:[asset]}}; };
  const blob = new Blob(['encoded fixture'], {type:'audio/webm;codecs=opus'});
  const signal = new AbortController().signal;
  assert.deepEqual(await voice.uploadRecording(blob, {name:'Hi & bye',signal,fetcher}), asset);
  assert.equal(calls[0].options.body, blob);
  assert.equal(calls[0].options.headers['Content-Type'], blob.type);
  assert.equal(calls[0].options.signal, signal);
  assert.equal(calls[0].url, '/api/robot/recordings?name=Hi%20%26%20bye');
  assert.deepEqual(await voice.listRecordings({fetcher}), [asset]);
  await voice.deleteRecording(asset.id,{fetcher});
  assert.equal(calls.at(-1).options.method,'DELETE');
  await assert.rejects(voice.uploadRecording(new Blob(['x'],{type:'text/plain'}),{fetcher}),/format/);
  await assert.rejects(voice.listRecordings({fetcher:async()=>({ok:false,status:503,json:async()=>({error:'Converter unavailable'})})}),/Converter unavailable/);
});

test('sync is explicit and MP4 codec MIME remains intact', async () => {
  const asset={id:'clip-1',name:'Hello',durationMs:500,bytes:1500,ready:true};
  const calls=[];const fetcher=async(url,options)=>{calls.push({url,options});return {ok:true,status:200,json:async()=>asset};};
  assert.deepEqual(await voice.syncRecording(asset.id,{fetcher}),asset);
  assert.equal(calls[0].url,'/api/robot/recordings/clip-1/sync');
  assert.equal(calls[0].options.method,'POST');
  const blob=new Blob(['fixture'],{type:'audio/mp4;codecs=mp4a.40.2'});
  await voice.uploadRecording(blob,{fetcher});
  assert.equal(calls[1].options.headers['Content-Type'],blob.type);
});

test('recording capability requires explicitly connected installed support', () => {
  assert.equal(voice.canUseRecordings(null), false);
  assert.equal(voice.canUseRecordings({robotOnline:true,capabilities:[]}), false);
  assert.equal(voice.canUseRecordings({robotOnline:false,capabilities:['recorded_audio_v1']}), false);
  assert.equal(voice.canUseRecordings({robotOnline:true,capabilities:['recorded_audio_v1']}), true);
});
