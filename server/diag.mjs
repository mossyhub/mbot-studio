// Quick diagnostic: check CyberPi flash contents and try imports
const BASE = 'http://localhost:3001/api/config/mlink/exec';

async function run(script) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serialPort: 'COM4', script }),
  });
  const j = await res.json();
  return j.output?.text || JSON.stringify(j);
}

console.log('--- Files in /flash ---');
console.log(await run("import os\nprint(os.listdir('/flash'))"));

console.log('--- Try import config ---');
console.log(await run("import config\nprint('config OK')"));

console.log('--- Try import dashboard ---');
console.log(await run("import dashboard\nprint('dashboard OK')"));

console.log('--- Try import sensor_reader ---');
console.log(await run("import sensor_reader\nprint('sensor_reader OK')"));

console.log('--- Try import motor_controller ---');
console.log(await run("import motor_controller\nprint('motor_controller OK')"));

console.log('--- Try import mqtt_client ---');
console.log(await run("import mqtt_client\nprint('mqtt_client OK')"));

console.log('--- Try import command_handler ---');
console.log(await run("import command_handler\nprint('command_handler OK')"));

console.log('--- Try import cyberpi ---');
console.log(await run("import cyberpi\nprint('cyberpi OK, dir:', [x for x in dir(cyberpi) if not x.startswith('_')][:20])"));

console.log('--- Try import mbot2 ---');
console.log(await run("import mbot2\nprint('mbot2 OK, dir:', [x for x in dir(mbot2) if not x.startswith('_')][:20])"));

console.log('--- Check cyberpi.audio methods ---');
console.log(await run("import cyberpi\nprint([x for x in dir(cyberpi.audio) if not x.startswith('_')])"));
