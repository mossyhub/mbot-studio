import React, {useRef,useState} from 'react';
import {uploadViaMlink} from '../services/mlink-client.js';

export default function OtaBootstrap({flashing,onBusy,serialPort,slot}) {
 const [artifact,setArtifact]=useState(null);
 const [error,setError]=useState('');
 const [status,setStatus]=useState('');
 const [consent,setConsent]=useState(false);
 const generation=useRef(0);
 async function choose(event){
  const current=++generation.current;
  setArtifact(null);setError('');setStatus('');setConsent(false);
  const file=event.target.files?.[0];if(!file)return;
  try {
   if(file.size>524288)throw new Error('file exceeds 512 KiB');
   const value=JSON.parse(await file.text());
   if(value.kind!=='mbot-ota-bootstrap-v1'||!/^[-A-Za-z0-9_]{1,48}$/.test(value.device)||!Array.isArray(value.files)||value.files.length!==1||value.files[0].name!=='main.py'||typeof value.files[0].content!=='string'||!value.files[0].content||!/^[a-f0-9]{64}$/.test(value.sha256))throw new Error('not a commissioning bootstrap');
   if(!globalThis.crypto?.subtle)throw new Error('open Setup using HTTPS or localhost to verify this file');
   const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value.files[0].content));
   const hex=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
   if(hex!==value.sha256)throw new Error('file digest mismatch');
   if(current===generation.current)setArtifact(value);
  }catch(e){if(current===generation.current)setError('Invalid OTA bootstrap: '+(e instanceof SyntaxError?'invalid JSON':e.message));}
 }
 async function install(){
  if(!artifact||!consent||flashing)return;
  if(!window.confirm('Replace the robot program with the commissioning recovery loader? Keep wheels raised, mechanisms clear, and USB recovery available. Normal robot controls will be unavailable until a compatible application is installed.'))return;
  onBusy(true);setError('');setStatus('Uploading commissioning loader through this computer’s mLink…');
  try{
   const result=await uploadViaMlink({files:artifact.files,serialPort:serialPort||null,slot:slot||1,onProgress:()=>{}});
   if(!result.ok)throw new Error('mLink did not confirm transfer');
   setStatus('USB transfer acknowledged. Boot and OTA connectivity are NOT verified. Check the live loader status from the server before continuing.');
  }catch(e){setError('Loader transfer failed: '+e.message);setStatus('');}
  finally{onBusy(false);}
 }
 return <section className="ota-bootstrap">
  <h3>OTA recovery loader — commissioning</h3>
  <p>This replaces the normal robot program. It starts disarmed and initially supports only the nonmoving diagnostic application. Keep USB recovery available. The private file contains WiFi credentials; do not share it.</p>
  <label>Private OTA bootstrap file <input type="file" accept=".json,application/json" onChange={choose} disabled={flashing}/></label>
  {artifact&&<p>Device: {artifact.device} · SHA-256: <code>{artifact.sha256}</code></p>}
  <label><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)} disabled={flashing||!artifact}/> I have secured the robot and am replacing its current program with the commissioning loader.</label>
  <button className="btn-secondary" disabled={flashing||!artifact||!consent} onClick={install}>Install OTA recovery loader via USB</button>
  {error&&<p role="alert">{error}</p>}{status&&<p role="status">{status}</p>}
 </section>;
}
