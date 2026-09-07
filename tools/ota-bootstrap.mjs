#!/usr/bin/env node
// Offline provisioning: all output artifacts contain or accompany secrets.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildBootstrap} from '../server/src/services/ota-bootstrap.js';
const args=process.argv.slice(2);
if(args.length!==4||args[0]!=='--config'||args[2]!=='--out'){
 console.error('Usage: node tools/ota-bootstrap.mjs --config PRIVATE_SETTINGS.json --out NEW_PRIVATE_DIRECTORY');process.exit(2);
}
try {
 const config=JSON.parse(fs.readFileSync(args[1],'utf8'));
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 const settings=config;
 const artifact=buildBootstrap(settings,{core:fs.readFileSync(path.join(root,'firmware/ota_core.py'),'utf8'),loader:fs.readFileSync(path.join(root,'firmware/ota_loader.py'),'utf8')});
 // mkdir without recursive deliberately refuses existing output directories.
 fs.mkdirSync(args[3],{mode:0o700});
 const write=(name,data)=>fs.writeFileSync(path.join(args[3],name),data,{flag:'wx',mode:0o600});
 write('bootstrap.json',JSON.stringify(artifact,null,2));
 write('operator.json',JSON.stringify({brokerUrl:`mqtt://${settings.mqttBroker.includes(':')?'['+settings.mqttBroker+']':settings.mqttBroker}:${settings.mqttPort}`,prefix:settings.prefix,device:settings.device},null,2));
 write('diagnostic.py',fs.readFileSync(path.join(root,'firmware/ota_diagnostic_app.py')));
 console.log(JSON.stringify({created:true,device:settings.device,bootstrapSha256:artifact.sha256,outputDirectory:path.resolve(args[3]),warning:'Bootstrap contains WiFi credentials: keep it outside Git. Nothing uploaded or installed.'}));
} catch(e){console.error('Bootstrap generation failed:',e instanceof SyntaxError ? 'invalid settings JSON' : (e.code||e.message));process.exitCode=1;}
