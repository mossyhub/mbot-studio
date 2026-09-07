import {createHash} from 'node:crypto';
/** Application-only OTA artifact. No boot selection, WiFi secrets or movement permission. */
export function buildRobotApp(config,{engine,app}){
 const {broker,port,prefix,device}=config||{};
 if(typeof broker!=='string'||!broker||broker.length>253||/[\s\x00/]/.test(broker))throw new Error('Invalid broker host');
 if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid broker port');
 if(typeof prefix!=='string'||prefix.length>100||!/^[-A-Za-z0-9_]+(?:\/[-A-Za-z0-9_]+)*$/.test(prefix))throw new Error('Invalid topic prefix');
 if(typeof device!=='string'||!/^[-A-Za-z0-9_]{1,48}$/.test(device))throw new Error('Invalid device ID');
 if(typeof engine!=='string'||typeof app!=='string'||(app.match(/^from robot_engine import RobotEngine\r?$/gm)||[]).length!==1)throw new Error('Unexpected application sources');
 const constants={ROBOT_MQTT_BROKER:broker,ROBOT_MQTT_PORT:port,ROBOT_TOPIC_PREFIX:prefix,ROBOT_DEVICE:device};
 const provision=Object.entries(constants).map(([k,v])=>`${k} = ${JSON.stringify(v)}`).join('\n');
 const source='# mBot cooperative application: motion is disabled in this build.\n'+provision+'\nMOTION_ENABLED = False\n\n'+engine+'\n\n'+app.replace(/^from robot_engine import RobotEngine\r?\n/m,'');
 const bytes=Buffer.from(source);if(bytes.length>131072)throw new Error('Application exceeds OTA limit');
 return {bytes,sha256:createHash('sha256').update(bytes).digest('hex'),motionEnabled:false};
}
