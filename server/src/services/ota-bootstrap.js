import {createHash} from 'node:crypto';

/** Build an explicitly selected USB commissioning artifact; never an OTA update. */
export function buildBootstrap(settings, {core,loader}) {
  if (!settings || typeof settings !== 'object') throw new Error('Provisioning settings required');
  const {wifiSsid,wifiPassword,mqttBroker,mqttPort,prefix,device}=settings;
  if(typeof wifiSsid!=='string'||!wifiSsid||wifiSsid.length>128) throw new Error('WiFi SSID required');
  if(typeof wifiPassword!=='string'||wifiPassword.length>256) throw new Error('WiFi password must be a string');
  if(typeof mqttBroker!=='string'||!mqttBroker||mqttBroker.length>253||/[\s\x00/]/.test(mqttBroker)) throw new Error('MQTT host required (no URL)');
  if(!Number.isInteger(mqttPort)||mqttPort<1||mqttPort>65535) throw new Error('Invalid MQTT port');
  if(typeof prefix!=='string'||!/^[-A-Za-z0-9_]+(?:\/[-A-Za-z0-9_]+)*$/.test(prefix)||prefix.length>100) throw new Error('Invalid topic prefix');
  if(typeof device!=='string'||!/^[-A-Za-z0-9_]{1,48}$/.test(device)) throw new Error('Invalid device ID');
  if(typeof core!=='string'||typeof loader!=='string') throw new Error('Loader sources required');
  const imports=loader.match(/^from ota_core import OtaEngine\r?$/gm)||[];
  if(imports.length!==1) throw new Error('Unexpected loader import contract');
  const constants={WIFI_SSID:wifiSsid,WIFI_PASSWORD:wifiPassword,MQTT_BROKER:mqttBroker,MQTT_PORT:mqttPort,MQTT_TOPIC_PREFIX:prefix,OTA_DEVICE:device};
  const provision=Object.entries(constants).map(([k,v])=>`${k} = ${JSON.stringify(v)}`).join('\n');
  const startup=/^if __name__ == ["']__main__["']:\r?\n    main\(\)\r?\n?$/m;
  if(!startup.test(loader)) throw new Error('Unexpected loader startup contract');
  // USB bootstrap is a script, not an importable library. Vendor execution may
  // supply a name other than __main__; invoke its entrypoint unconditionally.
  const script=loader.replace(/^from ota_core import OtaEngine\r?\n/m,'').replace(startup,'main()\n');
  const content='# mBot OTA commissioning loader. Contains PRIVATE provisioning.\n'+provision+'\n\n'+core+'\n\n'+script;
  return {kind:'mbot-ota-bootstrap-v1',device,sha256:createHash('sha256').update(content).digest('hex'),files:[{name:'main.py',content}]};
}
