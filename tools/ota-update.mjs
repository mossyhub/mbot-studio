#!/usr/bin/env node
// Operator-only CLI. No environment fallback, web route, automatic upload or confirm.
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { parseArgs } from 'node:util';
import { OtaClient } from '../server/src/services/ota-client.js';

const usage = 'Usage: node tools/ota-update.mjs --config OPERATOR.json [--boot-timeout-ms 90000] [--request-timeout-ms 1500] <status | upload APP.py | activate SHA256 | confirm SHA256 | rollback>';

async function loadConfig(path) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 4096) {
      throw new Error('file');
    }
    const config = JSON.parse(await file.readFile('utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).sort().join(',') !== 'brokerUrl,device,prefix') throw new Error('schema');
    return config;
  } catch {
    throw new Error('OTA config must be a valid JSON file with brokerUrl, prefix, device');
  } finally { await file?.close(); }
}

async function loadApp(path) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 131072) throw new Error('Invalid OTA app size');
    const bytes = Buffer.alloc(131073);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size < 1 || size > 131072) throw new Error('Invalid OTA app size');
    return bytes.subarray(0, size);
  } finally { await file?.close(); }
}

async function main() {
  let parsed;
  try { parsed = parseArgs({ options: { config: { type: 'string' }, 'boot-timeout-ms': { type: 'string' }, 'request-timeout-ms': { type: 'string' } }, allowPositionals: true, strict: true }); }
  catch { throw new Error(usage); }
  const { values, positionals } = parsed;
  const [command, argument] = positionals;
  const arity = { status: 1, upload: 2, activate: 2, confirm: 2, rollback: 1 };
  if (!values.config || !Object.hasOwn(arity, command) || positionals.length !== arity[command]) throw new Error(usage);
  if (['activate', 'confirm'].includes(command) && !/^[0-9a-f]{64}$/.test(argument)) throw new Error(usage);
  const config = await loadConfig(values.config);
  const bytes = command === 'upload' ? await loadApp(argument) : null;
  const timing = {};
  for (const [flag, property] of [['boot-timeout-ms', 'bootTimeoutMs'], ['request-timeout-ms', 'requestTimeoutMs']]) {
    if (values[flag] !== undefined) {
      if (!/^[1-9][0-9]{0,5}$/.test(values[flag]) || Number(values[flag]) > 600000) throw new Error(usage);
      timing[property] = Number(values[flag]);
    }
  }
  const client = new OtaClient({ ...config, ...timing });
  try {
    const status = await client.connect();
    let result = status;
    if (command === 'upload') result = await client.upload(bytes);
    else if (command === 'activate') result = await client.activate(argument);
    else if (command === 'confirm') result = await client.confirm(argument);
    else if (command === 'rollback') result = await client.rollback();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally { await client.close(); }
}

try { await main(); }
catch (error) {
  // Never print input, provisioning, library errors or stack traces.
  const safe = /^(Usage:|OTA config must)/.test(error.message) ? error.message : 'OTA command failed; outcome unverified. Check provisioning and query status before retrying.';
  process.stderr.write(`${safe}\n`);
  process.exitCode = 1;
}
