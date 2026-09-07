#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {buildRobotApp} from '../server/src/services/robot-app-builder.js';
const args=process.argv.slice(2);
if(args.length!==4||args[0]!=='--config'||args[2]!=='--out'){console.error('Usage: node tools/build-robot-app.mjs --config operator.json --out NEW_APP.py');process.exit(2);}
try{
 const config=JSON.parse(fs.readFileSync(args[1],'utf8'));const url=new URL(config.brokerUrl);if(url.protocol!=='mqtt:'||url.username||url.password)throw new Error('Plain LAN mqtt:// host required');
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');const artifact=buildRobotApp({broker:url.hostname,port:Number(url.port||1883),prefix:config.prefix,device:config.device},{engine:fs.readFileSync(path.join(root,'firmware/robot_engine.py'),'utf8'),app:fs.readFileSync(path.join(root,'firmware/robot_app.py'),'utf8')});
 fs.writeFileSync(args[3],artifact.bytes,{flag:'wx',mode:0o600});console.log(JSON.stringify({file:path.resolve(args[3]),size:artifact.bytes.length,sha256:artifact.sha256,motionEnabled:false,uploaded:false}));
}catch(e){console.error(e instanceof SyntaxError?'Invalid operator JSON':e.code||e.message);process.exitCode=1;}
