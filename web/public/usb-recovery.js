import {listSerialPorts,uploadViaMlink} from './recovery-mlink.js';
const $=id=>document.getElementById(id);let template=null,busy=false;
function update(){$('install').disabled=busy||!template||!$('serial').value||!$('consent').checked;$('find').disabled=busy;}
function status(t){$('status').textContent=t;}
try{const r=await fetch('/ota-recovery-template.json',{cache:'no-store'});if(!r.ok)throw new Error();template=await r.json();if(template.kind!=='mbot-ota-bootstrap-v1'||template.files?.length!==1||template.files[0].name!=='main.py')throw new Error();status('Corrected loader ready. Enter WiFi settings and find the USB port.');}catch{status('Could not load corrected loader. Reload before proceeding.');template=null;}update();
$('consent').onchange=update;$('serial').onchange=update;
$('find').onclick=async()=>{busy=true;update();try{const d=await listSerialPorts();if(!d.ok)throw new Error('mLink could not list ports');$('serial').replaceChildren();for(const p of d.ports){const name=p.info?.comName||p.info?.path;if(!name)continue;const o=document.createElement('option');o.value=name;o.textContent=name;$('serial').append(o);}status($('serial').options.length?'USB port found. Confirm it is the robot.':'No USB ports. Check cable and mLink.');}catch(e){status(e.message);}finally{busy=false;update();}};
$('form').onsubmit=async event=>{
 event.preventDefault();if(busy||!template||!$('consent').checked||!$('serial').value)return;
 const values={WIFI_SSID:$('ssid').value,WIFI_PASSWORD:$('password').value,MQTT_BROKER:$('broker').value,MQTT_PORT:Number($('mqttport').value),MQTT_TOPIC_PREFIX:$('prefix').value,OTA_DEVICE:$('device').value};
 if(!/^[-A-Za-z0-9_]{1,48}$/.test(values.OTA_DEVICE)||!/^[-A-Za-z0-9_]+(?:\/[-A-Za-z0-9_]+)*$/.test(values.MQTT_TOPIC_PREFIX)||!Number.isInteger(values.MQTT_PORT)||values.MQTT_PORT<1||values.MQTT_PORT>65535||!values.MQTT_BROKER||/[\s/\x00]/.test(values.MQTT_BROKER)){status('Invalid broker, port, topic prefix or device ID.');return;}
 if(!confirm('Install corrected OTA loader in program slot 1? This replaces the current startup program. Robot must remain secured.'))return;
 busy=true;update();$('progress').textContent='';
 try{
  let content=template.files[0].content;
  for(const [key,value] of Object.entries(values)){
   const pattern=new RegExp('^'+key+' = .*$', 'm');if(!pattern.test(content))throw new Error('Loader provisioning contract mismatch');
   content=content.replace(pattern,()=>key+' = '+JSON.stringify(value));
  }
  status('Uploading through this laptop’s mLink. Do not disconnect.');
  const result=await uploadViaMlink({files:[{name:'main.py',content}],serialPort:$('serial').value,slot:1,onProgress:line=>{if(!line.includes('program is running'))$('progress').textContent+=line+'\n';}});
  if(!result.ok)throw new Error('mLink did not acknowledge transfer');
  status('Transfer acknowledged. Now read the CyberPi screen and tell the assistant the exact message. OTA boot/connectivity is not yet verified.');
 }catch(e){status('Upload failed: '+e.message);}finally{busy=false;update();}
};
