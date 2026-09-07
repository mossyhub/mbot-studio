import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import net from 'node:net';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {Aedes} from 'aedes';
import mqtt from 'mqtt';
import {OtaClient} from '../server/src/services/ota-client.js';

test('Node updater and real Python OTA engine transfer, trial, confirm, fail and recover',{timeout:45000},async()=>{
 const broker=await Aedes.createBroker();const tcp=net.createServer(broker.handle);tcp.listen(0,'127.0.0.1');await once(tcp,'listening');
 const url=`mqtt://127.0.0.1:${tcp.address().port}`;const peer=await mqtt.connectAsync(url);
 const child=spawn('python3',[new URL('./helpers/ota-peer.py',import.meta.url).pathname],{stdio:['pipe','pipe','pipe']});let stderr='';child.stderr.on('data',b=>stderr+=b);
 const lines=createInterface({input:child.stdout});const topic='local-test/ota/integration';
 // Publish in Python output order on the same MQTT connection, just as the
 // loader does. Delaying only hello lets newer status replies overtake it;
 // a fresh operator session can then adopt an obsolete next_seq.
 lines.on('line',line=>{try{const result=JSON.parse(line);if(result.response)peer.publish(topic+'/response',JSON.stringify(result.response),{retain:false});if(result.hello)peer.publish(topic+'/hello',JSON.stringify(result.hello),{retain:false});}catch(e){stderr+=e.message;}});
 peer.on('message',(t,p)=>child.stdin.write(JSON.stringify({request:JSON.parse(p)})+'\n'));
 await peer.subscribeAsync(topic+'/request');const timer=setInterval(()=>{if(!child.killed)child.stdin.write('{"hello":true}\n');},100);
 const client=new OtaClient({brokerUrl:url,prefix:'local-test',device:'integration',timeoutMs:5000,requestTimeoutMs:500,bootTimeoutMs:6000,pollIntervalMs:20});
 try{
  const first=await client.connect();assert.equal(first.confirmed,null);
  const source=await readFile(new URL('../firmware/ota_diagnostic_app.py',import.meta.url));
  const a=await client.upload(source);assert.equal(a.size,source.length);
  const trial=await client.activate(a.sha256);assert.equal(trial.selected.sha256,a.sha256);assert.equal(trial.healthy,true);
  const confirmed=await client.confirm(a.sha256);assert.equal(confirmed.confirmed.sha256,a.sha256);assert.equal(confirmed.trial,null);
  const bad=await client.upload(Buffer.from('raise RuntimeError("intentional fixture failure")\n'));
  // The boot budget can expire between polls or during the final status request.
  // Neither a protocol/sequence rejection nor a boot-change error is expected.
  await assert.rejects(client.activate(bad.sha256), /OTA (?:healthy trial timeout; activation unverified|request timeout; outcome unknown)/);
  // Fresh operator session reads actual persisted engine state after simulated restart.
  await client.close();const next=new OtaClient({brokerUrl:url,prefix:'local-test',device:'integration',timeoutMs:5000,requestTimeoutMs:500,bootTimeoutMs:6000,pollIntervalMs:20});
  try{
   const recovered=await next.connect();assert.equal(recovered.confirmed.sha256,a.sha256);assert.equal(recovered.selected.sha256,a.sha256);assert.equal(recovered.trial,null);
   const b=await next.upload(Buffer.concat([source,Buffer.from('\n# second candidate\n')]));await next.activate(b.sha256);const final=await next.confirm(b.sha256);assert.equal(final.confirmed.sha256,b.sha256);
  }finally{await next.close();}
  assert.equal(stderr,'');
 }finally{clearInterval(timer);await client.close();child.stdin.end();child.kill();lines.close();await peer.endAsync(true);await new Promise(r=>broker.close(r));await new Promise(r=>tcp.close(r));}
});
