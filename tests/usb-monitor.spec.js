import {test,expect} from '@playwright/test';
test('read-only USB monitor displays serial data and never writes to robot',async({page})=>{
 const methods=[];let serialDataId;
 await page.routeWebSocket('ws://127.0.0.1:52384/',ws=>{
  ws.onMessage(raw=>{const r=JSON.parse(raw);methods.push(r.method);
   if(r.method==='rpc.discover')return ws.send(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{}}));
   if(r.method==='list')return ws.send(JSON.stringify({jsonrpc:'2.0',id:r.id,result:[{id:7,info:{comName:'COM7'}}]}));
   if(r.method==='connect'){
    serialDataId=r.params[3].id;ws.send(JSON.stringify({jsonrpc:'2.0',id:r.id,result:true}));
    ws.send(JSON.stringify({type:'JSON_RPC_CALLBACK',id:r.params[2].id,params:[null,{open:true}]}));
    return ws.send(JSON.stringify({type:'JSON_RPC_CALLBACK',id:serialDataId,params:[Array.from(Buffer.from('BOOT: fixture serial output\n'))]}));
   }
   if(r.method==='close')return ws.send(JSON.stringify({jsonrpc:'2.0',id:r.id,result:true}));
  });
 });
 await page.goto('/usb-monitor.html');await page.getByRole('button',{name:'Find USB ports'}).click();
 await page.getByLabel('USB port').selectOption('7');await page.getByRole('button',{name:'Start listening',exact:true}).click();
 await expect(page.locator('#output')).toContainText('BOOT: fixture serial output');
 await expect(page.locator('#status')).toContainText('Listening');await page.getByRole('button',{name:'Disconnect',exact:true}).click();
 expect(methods).toContain('close');expect(methods.every(m=>['rpc.discover','list','connect','close'].includes(m))).toBe(true);
});
