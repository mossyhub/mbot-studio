// Read-only mLink serial monitor. Allowed RPC methods: discover/list/connect/close.
const $=id=>document.getElementById(id);
let ws=null,channel=null,opening=false,requestId=100,callbackId=500,bytes=0;
let log='',decoder=new TextDecoder();const pending=new Map(),callbacks=new Map();
const MAX=1048576;
function status(text){$('status').textContent=text;}
function note(text){log=(log+new Date().toISOString()+' '+text+'\n').slice(-MAX);}
function received(data){
 const values=data?.params?.[0];if(!Array.isArray(values)||!values.length||!values.every(n=>Number.isInteger(n)&&n>=0&&n<=255))return;
 const b=Uint8Array.from(values);bytes+=b.length;
 $('output').textContent=($('output').textContent+decoder.decode(b,{stream:true})).slice(-MAX);$('output').scrollTop=$('output').scrollHeight;
 note('RX '+Array.from(b,n=>n.toString(16).padStart(2,'0')).join(' '));
 status(`Listening — ${bytes} bytes received. No commands sent.`);
}
function register(fn){const id=++callbackId;callbacks.set(id,fn);return {type:'JSON_RPC_CALLBACK',id};}
function rpc(service,method,params){
 if(!ws||ws.readyState!==WebSocket.OPEN)return Promise.reject(new Error('mLink disconnected'));
 const id=++requestId;
 return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error('mLink timeout: '+method));},5000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({jsonrpc:'2.0',id,service,method,params}));});
}
async function session(){
 if(ws?.readyState===WebSocket.OPEN)return;
 await new Promise((resolve,reject)=>{
  const socket=new WebSocket('ws://127.0.0.1:52384/');ws=socket;
  const timer=setTimeout(()=>{reject(new Error('mLink connection timeout'));socket.close();},5000);
  socket.onopen=()=>{clearTimeout(timer);socket.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'rpc.discover',params:{}}));resolve();};
  socket.onmessage=e=>{let m;try{m=JSON.parse(e.data);}catch{return;}
   if(m.type==='JSON_RPC_CALLBACK'){callbacks.get(m.id)?.(m);return;}
   const p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);if(m.error)p.reject(new Error('mLink RPC rejected'));else p.resolve(m.result);
  };
  socket.onerror=()=>{clearTimeout(timer);reject(new Error('Cannot reach mLink. Keep mLink2 running and allow this site to access local-network devices if the browser asks.'));};
  socket.onclose=()=>{clearTimeout(timer);reject(new Error('mLink connection closed'));for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('mLink connection closed'));}pending.clear();callbacks.clear();channel=null;opening=false;$('start').disabled=true;$('stop').disabled=true;$('find').disabled=false;status('Disconnected from mLink. Find USB ports to reconnect.');};
 });
}
$('find').onclick=async()=>{
 $('find').disabled=true;
 try{await session();const ports=await rpc('data-channel','list',['serialport']);$('port').replaceChildren();
  for(const p of Array.isArray(ports)?ports:[]){if(p.id===undefined)continue;const o=document.createElement('option');o.value=String(p.id);o.textContent=p.info?.comName||p.info?.path||String(p.id);o.dataset.id=JSON.stringify(p.id);$('port').append(o);}
  $('start').disabled=!$('port').options.length;status($('port').options.length?'Select the robot USB port, then Start listening.':'No serial ports found. Check USB cable and mLink.');
 }catch(e){status(e.message);}finally{$('find').disabled=false;}
};
$('start').onclick=async()=>{
 if(channel!==null||opening)return;opening=true;$('start').disabled=true;$('find').disabled=true;status('Opening serial port…');
 let attempted=null;
 try{
  const selected=$('port').selectedOptions[0];if(!selected)throw new Error('Select a port first');attempted=JSON.parse(selected.dataset.id);
  let resolveOpen,rejectOpen;const opened=new Promise((r,j)=>{resolveOpen=r;rejectOpen=j;});
  const timer=setTimeout(()=>rejectOpen(new Error('Serial port did not acknowledge opening')),4500);
  // Attach rejection handler immediately, before awaiting the RPC acknowledgement.
  opened.catch(()=>{});
  const response=register(m=>{const [error,result]=m.params||[];if(error){clearTimeout(timer);rejectOpen(new Error('Serial port is busy or could not open'));}else if(result?.open===true){clearTimeout(timer);resolveOpen();}});
  const data=register(received);const closed=register(()=>{clearTimeout(timer);rejectOpen(new Error('USB serial channel closed'));channel=null;note('SERIAL CLOSED');status('USB serial channel closed. Find ports and reconnect.');$('stop').disabled=true;$('find').disabled=false;$('start').disabled=true;});
  bytes=0;decoder=new TextDecoder();
  try{await rpc('data-channel','connect',[attempted,{baudRate:115200,connectType:'serialport'},response,data,closed]);await opened;}finally{clearTimeout(timer);}
  channel=attempted;note('LISTEN '+selected.textContent+' 115200');$('stop').disabled=false;if(!bytes)status('Listening — 0 bytes received. Waiting for serial output.');
 }catch(e){if(attempted!==null){try{await rpc('data-channel','close',[attempted]);}catch{}}callbacks.clear();status(e.message);$('find').disabled=false;$('start').disabled=false;}finally{opening=false;}
};
$('stop').onclick=async()=>{const id=channel;channel=null;$('stop').disabled=true;try{if(id!==null)await rpc('data-channel','close',[id]);}catch(e){note(e.message);}finally{callbacks.clear();ws?.close();note('DISCONNECTED');}};
$('clear').onclick=()=>{$('output').textContent='';log='';};
$('save').onclick=()=>{const blob=new Blob(['USB serial monitor\n\nTEXT\n'+$('output').textContent+'\n\nBYTE LOG\n'+log],{type:'text/plain'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='mbot-usb-serial.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
window.addEventListener('pagehide',()=>ws?.close());
