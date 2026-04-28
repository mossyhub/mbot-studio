import { Router } from 'express';
import { parseRobotConfig } from '../services/ai-service.js';
import { calibrationChat } from '../services/calibration-service.js';
import { MqttService } from '../services/mqtt-service.js';
import { discoverMlink, diagnoseCyberpiPrograms, execCyberpiSnippet, listMlinkSerialPorts, probeMlinkServices, probeProgramNamingApis, probePythonTerminal, probeVirtualFs, uploadViaMlink, virtualFsListDir } from '../services/mlink-bridge.js';
import { SessionStore } from '../services/session-store.js';
import { getSessionId, validateMessage } from '../services/validation.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../..');
const CONFIG_PATH = path.join(DATA_DIR, 'robot-config.json');
const FIRMWARE_DIR = path.join(__dirname, '../../..', 'firmware');
const REQUIRED_FIRMWARE_FILES = [
  'main.py',
  'mbot_dashboard.py',
  'mbot_config.py',
  'mbot_mqtt.py',
  'mbot_motor.py',
  'mbot_sensor.py',
  'mbot_commands.py',
];

export const configRoutes = Router();

// ---------------------------------------------------------------------------
// Server-side config substitution — applies user settings to mbot_config.py
// ---------------------------------------------------------------------------

function replaceConfigValue(content, key, value) {
  const escaped = String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const regex = new RegExp(`^${key}\\s*=\\s*".*"`, 'm');
  if (regex.test(content)) {
    return content.replace(regex, `${key} = "${escaped}"`);
  }
  return content;
}

function applySettingsToFiles(files, settings) {
  if (!Array.isArray(files)) return files;
  if (!settings || typeof settings !== 'object') {
    console.warn('[upload] No settings received from client — config will use placeholder values');
    return files;
  }

  console.log('[upload] Applying settings — WIFI_SSID:', JSON.stringify(settings.wifiSsid || ''),
    'MQTT_BROKER:', JSON.stringify(settings.mqttBroker || ''));

  return files.map((file) => {
    const name = String(file.name || '');
    if (name === 'mbot_config.py' || name.endsWith('/mbot_config.py')) {
      let content = file.content;
      content = replaceConfigValue(content, 'WIFI_SSID', settings.wifiSsid || 'YOUR_WIFI_NAME');
      content = replaceConfigValue(content, 'WIFI_PASSWORD', settings.wifiPassword || 'YOUR_WIFI_PASSWORD');
      content = replaceConfigValue(content, 'MQTT_BROKER', settings.mqttBroker || 'YOUR_COMPUTER_IP');
      content = content.replace(/^MQTT_PORT\s*=\s*\d+/m,
        `MQTT_PORT = ${Math.max(1, Number(settings.mqttPort) || 1883)}`);
      content = replaceConfigValue(content, 'MQTT_TOPIC_PREFIX', settings.topicPrefix || 'mbot-studio');
      content = replaceConfigValue(content, 'MQTT_CLIENT_ID', settings.clientId || 'mbot2-rover');

      // Log the effective config values for debugging
      const ssidMatch = content.match(/^WIFI_SSID\s*=\s*"(.*)"/m);
      const brokerMatch = content.match(/^MQTT_BROKER\s*=\s*"(.*)"/m);
      console.log('[upload] Config after substitution — WIFI_SSID:', ssidMatch?.[1],
        'MQTT_BROKER:', brokerMatch?.[1]);

      return { ...file, content };
    }
    return file;
  });
}

// ---------------------------------------------------------------------------
// Firmware bundler – merges all firmware modules into a single main.py
// ---------------------------------------------------------------------------
// The CyberPi's MicroPython runtime cannot reliably import custom modules
// from /flash/.  Following the pattern used by every known working mBot2
// project (including mBlock itself), we concatenate all modules into one file
// before uploading.

/** Module names that are OUR firmware files (used to strip cross-imports). */
const OUR_MODULES = new Set(
  REQUIRED_FIRMWARE_FILES.map(f => f.replace(/\.py$/, '')),
);

/**
 * Given an array of { name, content } firmware file objects, return a single
 * { name: 'main.py', content } that inlines everything in dependency order.
 */
function bundleFirmwareFiles(files) {
  // Dependency order – modules listed earlier are pasted first.
  const MODULE_ORDER = [
    'mbot_config',     // pure constants, no deps
    'mbot_dashboard',  // depends on: cyberpi, time
    'mbot_sensor',     // depends on: mbot2, cyberpi
    'mbot_motor',      // depends on: mbot2, mbot_config
    'mbot_mqtt',       // depends on: cyberpi, mbot_config
    'mbot_commands',   // depends on: mbot_motor, mbot_sensor, mbot_config
    'main',            // entry point, depends on everything
  ];

  const byModule = new Map();
  for (const f of files) {
    const mod = f.name.replace(/\.py$/, '');
    byModule.set(mod, f.content);
  }

  const seenImports = new Set();  // track stdlib imports we've already emitted
  const sections = [];

  for (const mod of MODULE_ORDER) {
    let src = byModule.get(mod);
    if (src == null) continue;

    const cleaned = [];
    const srcLines = src.split('\n');
    let i = 0;
    while (i < srcLines.length) {
      const rawLine = srcLines[i];

      // Strip cross-imports to our own modules (handles multi-line too)
      if (/^\s*from\s+(mbot_\w+)\s+import\s/.test(rawLine)) {
        const imported = rawLine.match(/^\s*from\s+(\w+)/)[1];
        if (OUR_MODULES.has(imported)) {
          // If this is a multi-line import (ends with open paren, no close),
          // skip all continuation lines until closing paren
          if (/\(\s*$/.test(rawLine) && !/\)/.test(rawLine)) {
            i++;
            while (i < srcLines.length && !/\)/.test(srcLines[i])) {
              i++;
            }
            i++; // skip the closing paren line too
          } else {
            i++;
          }
          continue;  // skip – already inlined
        }
      }
      if (/^\s*import\s+(mbot_\w+)/.test(rawLine)) {
        const imported = rawLine.match(/^\s*import\s+(\w+)/)[1];
        if (OUR_MODULES.has(imported)) { i++; continue; }
      }

      // Deduplicate TOP-LEVEL stdlib imports only (not indented ones inside functions/classes)
      const isTopLevel = !rawLine.startsWith(' ') && !rawLine.startsWith('\t');
      if (isTopLevel) {
        const stdMatch = rawLine.match(/^(import\s+\S+)\s*$/);
        if (stdMatch) {
          const key = stdMatch[1].trim();
          if (seenImports.has(key)) { i++; continue; }
          seenImports.add(key);
        }
        // Also deduplicate "from X import Y" for stdlib
        const fromMatch = rawLine.match(/^(from\s+\S+\s+import\s+.+)$/);
        if (fromMatch && !/mbot_/.test(rawLine)) {
          const key = fromMatch[1].trim();
          if (seenImports.has(key)) { i++; continue; }
          seenImports.add(key);
        }
      }

      cleaned.push(rawLine);
      i++;
    }

    // Strip leading/trailing blank lines and comment banners at top
    let body = cleaned.join('\n').trim();
    // Remove the big ====== header comments to save flash space
    body = body.replace(/^#\s*={5,}[\s\S]*?^#\s*={5,}\s*\n?/m, '').trim();
    body = body.replace(/^#\s*-{5,}.*$/gm, '');  // also strip ---- separators

    if (body) {
      sections.push(`# --- ${mod} ---\n${body}`);
    }
  }

  return { name: 'main.py', content: sections.join('\n\n') + '\n' };
}

function buildDefaultRoverAdditions() {
  return [
    {
      port: 'S1',
      type: 'servo',
      label: 'Left Claw Servo',
      description: 'Left half of the Rover claw gripper. Works together with S2.',
      partOf: 'Rover Claw',
      purpose: 'Moves the left side of the claw to open and close the gripper.',
      orientation: 'horizontal',
      feedbackType: 'position',
      states: ['open', 'closed'],
      homeState: 'open',
      stallBehavior: 'safe',
      actions: [
        {
          name: 'open',
          targetState: 'open',
          angle: 30,
          description: 'Set left claw servo to open position.',
        },
        {
          name: 'close',
          targetState: 'closed',
          angle: 95,
          description: 'Set left claw servo to closed position.',
        },
      ],
      settings: {
        defaultOpenAngle: 30,
        defaultClosedAngle: 95,
      },
    },
    {
      port: 'S2',
      type: 'servo',
      label: 'Right Claw Servo',
      description: 'Right half of the Rover claw gripper. Works together with S1.',
      partOf: 'Rover Claw',
      purpose: 'Moves the right side of the claw to open and close the gripper.',
      orientation: 'horizontal',
      feedbackType: 'position',
      states: ['open', 'closed'],
      homeState: 'open',
      stallBehavior: 'safe',
      actions: [
        {
          name: 'open',
          targetState: 'open',
          angle: 150,
          description: 'Set right claw servo to open position.',
        },
        {
          name: 'close',
          targetState: 'closed',
          angle: 85,
          description: 'Set right claw servo to closed position.',
        },
      ],
      settings: {
        defaultOpenAngle: 150,
        defaultClosedAngle: 85,
      },
    },
  ];
}

// Default robot configuration
const DEFAULT_CONFIG = {
  name: 'My mBot2 Rover',
  additions: buildDefaultRoverAdditions(),
  notes: '',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

/**
 * GET /api/config
 * Load the current robot configuration
 */
configRoutes.get('/', (req, res) => {
  const config = loadConfig();
  res.json(config);
});

/**
 * GET /api/config/firmware
 * Return required firmware files for one-time Setup upload via mLink
 */
configRoutes.get('/firmware', (req, res) => {
  try {
    const files = REQUIRED_FIRMWARE_FILES.map((name) => {
      const filePath = path.join(FIRMWARE_DIR, name);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Missing firmware file: ${name}`);
      }
      const content = fs.readFileSync(filePath, 'utf-8');

      // Keep original filenames (all at /flash/) for maximum compatibility with CyberPi's
      // MicroPython import behavior.
      return { name, content };
    });

    const mqttUrl = process.env.MQTT_BROKER_URL || '';
    let broker = '';
    let port = 1883;
    if (mqttUrl) {
      try {
        const parsed = new URL(mqttUrl);
        broker = parsed.hostname || '';
        port = parsed.port ? parseInt(parsed.port, 10) : 1883;
      } catch {
        // ignore malformed URL and send empty defaults
      }
    }

    res.json({
      files,
      suggested: {
        mqttBroker: broker,
        mqttPort: Number.isFinite(port) ? port : 1883,
        topicPrefix: process.env.MQTT_TOPIC_PREFIX || 'mbot-studio',
        clientId: 'mbot2-rover',
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/config/mlink/discover
 * Probe local mLink bridge and return announced channels
 */
configRoutes.get('/mlink/discover', async (req, res) => {
  try {
    const port = Number(req.query.port) || Number(process.env.MLINK_PORT) || 52384;
    const result = await discoverMlink({ port, timeoutMs: 2500 });
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/config/mlink/serialports
 * List available serial ports reported by mLink data-channel
 */
configRoutes.get('/mlink/serialports', async (req, res) => {
  try {
    const port = Number(req.query.port) || Number(process.env.MLINK_PORT) || 52384;
    const result = await listMlinkSerialPorts({ port });
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/config/mlink/virtualfs/probe
 * Diagnostics: try common virtualfs methods against a path (defaults to /flash)
 */
configRoutes.get('/mlink/virtualfs/probe', async (req, res) => {
  try {
    const port = Number(req.query.port) || Number(process.env.MLINK_PORT) || 52384;
    const path = req.query.path ? String(req.query.path) : '/flash';
    const result = await probeVirtualFs({ port, path });
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/config/mlink/virtualfs/ls
 * Best-effort: list a directory via virtualfs (defaults to /flash)
 */
configRoutes.get('/mlink/virtualfs/ls', async (req, res) => {
  try {
    const port = Number(req.query.port) || Number(process.env.MLINK_PORT) || 52384;
    const path = req.query.path ? String(req.query.path) : '/flash';
    const result = await virtualFsListDir({ port, path });
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/config/mlink/python-terminal/probe
 * Diagnostics: probe python-terminal methods to find program/project list + rename capabilities.
 */
configRoutes.get('/mlink/python-terminal/probe', async (req, res) => {
  try {
    const port = Number(req.query.port) || Number(process.env.MLINK_PORT) || 52384;
    const result = await probePythonTerminal({ port });
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/config/mlink/program-naming/probe
 * Diagnostics: probe multiple mLink services for any supported program list / naming APIs.
 */
configRoutes.get('/mlink/program-naming/probe', async (req, res) => {
  try {
    const port = Number(req.query.port) || Number(process.env.MLINK_PORT) || 52384;
    const result = await probeProgramNamingApis({ port });
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/config/mlink/probe
 * Run a targeted probe against known mLink services and return diagnostics
 */
configRoutes.get('/mlink/probe', async (req, res) => {
  try {
    const port = Number(req.query.port) || Number(process.env.MLINK_PORT) || 52384;
    const result = await probeMlinkServices({ port });
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/config/mlink/device-programs
 * Diagnostics: query CyberPi /flash contents to learn how the device stores program names
 */
configRoutes.get('/mlink/device-programs', async (req, res) => {
  try {
    const port = Number(req.query.port) || Number(process.env.MLINK_PORT) || 52384;
    const serialPort = req.query.serialPort ? String(req.query.serialPort) : null;
    const result = await diagnoseCyberpiPrograms({ port, serialPort });
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/config/mlink/exec
 * Diagnostics: run a single script snippet over the CyberPi exec channel and return serial output.
 */
configRoutes.post('/mlink/exec', async (req, res) => {
  if (process.env.ENABLE_REPL === 'false') {
    return res.status(403).json({ ok: false, error: 'REPL is disabled. Set ENABLE_REPL=true in .env to enable.' });
  }
  try {
    const port = Number(req.body?.port) || Number(process.env.MLINK_PORT) || 52384;
    const serialPort = req.body?.serialPort ? String(req.body.serialPort) : null;
    const script = typeof req.body?.script === 'string' ? req.body.script : '';
    const result = await execCyberpiSnippet({ port, serialPort, script });
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/config/mlink/upload-test
 * Upload minimal motor test firmware (bypasses bundler)
 */
configRoutes.post('/mlink/upload-test', async (req, res) => {
  try {
    const { port, serialPort, settings, slot } = req.body || {};
    const testPath = path.join(FIRMWARE_DIR, 'test_motors.py');
    if (!fs.existsSync(testPath)) {
      return res.status(404).json({ ok: false, error: 'test_motors.py not found' });
    }

    let content = fs.readFileSync(testPath, 'utf-8');
    // Apply WiFi/MQTT settings directly (use replaceConfigValue for proper escaping)
    if (settings) {
      content = replaceConfigValue(content, 'WIFI_SSID', settings.wifiSsid || 'YOUR_WIFI_NAME');
      content = replaceConfigValue(content, 'WIFI_PASSWORD', settings.wifiPassword || 'YOUR_WIFI_PASSWORD');
      content = replaceConfigValue(content, 'MQTT_BROKER', settings.mqttBroker || 'YOUR_COMPUTER_IP');
      content = content.replace(/^MQTT_PORT\s*=\s*\d+/m,
        `MQTT_PORT = ${Math.max(1, Number(settings.mqttPort) || 1883)}`);
      content = replaceConfigValue(content, 'MQTT_TOPIC_PREFIX', settings.topicPrefix || 'mbot-studio');
    }

    console.log('[upload-test] Uploading minimal motor test firmware (' + content.length + ' bytes)');
    console.log('[upload-test] Preview:\n' + content.substring(0, 300));

    const targetSlot = Math.max(1, Math.min(8, Math.floor(Number(slot) || 1)));
    console.log('[upload-test] Target program slot:', targetSlot);

    const result = await uploadViaMlink({
      files: [{ name: 'main.py', content }],
      port: Number(port) || Number(process.env.MLINK_PORT) || 52384,
      serialPort: serialPort || null,
      slot: targetSlot,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

/**
 * POST /api/config/mlink/upload
 * Upload firmware files through local mLink websocket bridge
 */
configRoutes.post('/mlink/upload', async (req, res) => {
  try {
    const { port, serialPort, settings, slot } = req.body || {};

    // Always read firmware files fresh from disk to ensure latest code is uploaded
    const freshFiles = REQUIRED_FIRMWARE_FILES.map((name) => {
      const filePath = path.join(FIRMWARE_DIR, name);
      return { name, content: fs.readFileSync(filePath, 'utf-8') };
    });
    console.log('[upload] Read', freshFiles.length, 'firmware files fresh from disk');

    // Apply user settings to mbot_config.py server-side (authoritative substitution).
    const patchedFiles = applySettingsToFiles(freshFiles, settings);

    // Bundle all firmware modules into a single main.py for reliable upload.
    const bundled = bundleFirmwareFiles(patchedFiles);

    // Verify WIFI_SSID survived bundling
    const ssidInBundle = bundled.content.match(/WIFI_SSID\s*=\s*"(.*)"/);
    console.log('[upload] After bundling — WIFI_SSID in final output:', ssidInBundle?.[1] || 'NOT FOUND');
    if (!ssidInBundle || ssidInBundle[1] === 'YOUR_WIFI_NAME') {
      console.warn('[upload] WARNING: WIFI_SSID is still placeholder after bundling!');
    }

    // Dump first 600 chars of bundled content for debugging
    console.log('[upload] Bundle preview (first 600 chars):\n' + bundled.content.substring(0, 600));

    // Verify key functions are present in bundle
    const hasOldRepl = bundled.content.includes('__builtins__');
    const hasNewRepl = bundled.content.includes('_repl_output');
    const hasRprint = bundled.content.includes('def rprint');
    const hasExecCode = bundled.content.includes('exec(code)');
    console.log('[upload] Bundle check — has __builtins__:', hasOldRepl, '| has _repl_output:', hasNewRepl, '| has rprint:', hasRprint, '| has exec(code):', hasExecCode);
    console.log('[upload] Bundle total size:', bundled.content.length, 'chars');

    const targetSlot = Math.max(1, Math.min(8, Math.floor(Number(slot) || 1)));
    console.log('[upload] Target program slot:', targetSlot);

    // Save bundle to disk for debugging
    const debugBundlePath = path.join(FIRMWARE_DIR, '_bundled_debug.py');
    fs.writeFileSync(debugBundlePath, bundled.content);
    console.log('[upload] Saved debug bundle to', debugBundlePath);

    const result = await uploadViaMlink({
      files: [bundled],
      port: Number(port) || Number(process.env.MLINK_PORT) || 52384,
      serialPort: serialPort || null,
      slot: targetSlot,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
      details: error.details || null,
    });
  }
});

/**
 * POST /api/config
 * Save robot configuration
 */
const ALLOWED_CONFIG_KEYS = new Set(['name', 'additions', 'notes', 'turnMultiplier', 'calibrations', 'physicalDescription', 'constraints', 'taskPatterns']);

configRoutes.post('/', (req, res) => {
  try {
    const existing = loadConfig();
    const update = {};
    for (const key of Object.keys(req.body)) {
      if (ALLOWED_CONFIG_KEYS.has(key)) {
        update[key] = req.body[key];
      }
    }
    const config = {
      ...existing,
      ...update,
      updatedAt: new Date().toISOString(),
    };

    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

    const mqtt = MqttService.getInstance();
    mqtt.initHardwareStatesFromConfig(config);
    if (mqtt.isConnected()) {
      mqtt.sendConfig(config);
    }

    res.json({ success: true, config });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/config/parse
 * Use AI to parse a natural language robot configuration description
 */
configRoutes.post('/parse', async (req, res) => {
  try {
    const { description, existingAdditions = [] } = req.body;

    if (!description) {
      return res.status(400).json({ error: 'Description is required' });
    }

    const result = await parseRobotConfig(description, existingAdditions);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/config/addition
 * Add a hardware addition to the robot configuration
 */
configRoutes.post('/addition', (req, res) => {
  try {
    const config = loadConfig();
    const addition = req.body;

    if (!addition || typeof addition !== 'object') {
      return res.status(400).json({ error: 'Addition must be an object' });
    }
    if (!addition.port || typeof addition.port !== 'string') {
      return res.status(400).json({ error: 'port is required and must be a string' });
    }
    if (!addition.type || !['servo', 'dc_motor', 'sensor'].includes(addition.type)) {
      return res.status(400).json({ error: 'type must be "servo", "dc_motor", or "sensor"' });
    }

    // Check if port is already used
    const existingIdx = config.additions.findIndex(a => a.port === addition.port);
    if (existingIdx >= 0) {
      config.additions[existingIdx] = addition;
    } else {
      config.additions.push(addition);
    }

    config.updatedAt = new Date().toISOString();
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

    const mqtt = MqttService.getInstance();
    mqtt.initHardwareStatesFromConfig(config);
    if (mqtt.isConnected()) {
      mqtt.sendConfig(config);
    }

    res.json({ success: true, config });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/config/addition/:port
 * Remove a hardware addition
 */
configRoutes.delete('/addition/:port', (req, res) => {
  try {
    const config = loadConfig();
    config.additions = config.additions.filter(a => a.port !== req.params.port);
    config.updatedAt = new Date().toISOString();

    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

    const mqtt = MqttService.getInstance();
    mqtt.initHardwareStatesFromConfig(config);
    if (mqtt.isConnected()) {
      mqtt.sendConfig(config);
    }

    res.json({ success: true, config });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Calibration / Teaching Endpoints ───────────────────────────

const calibrationConversations = new SessionStore({
  maxMessagesPerSession: 30,
  maxSessions: 100,
});

/**
 * POST /api/config/calibrate
 * AI-guided calibration chat — the child teaches the robot about its physical properties
 * The AI can ask the robot to move (returns commands) and the child reports measurements.
 */
configRoutes.post('/calibrate', async (req, res) => {
  try {
    const { message } = req.body;
    const sessionId = getSessionId(req.body?.sessionId, 'calibration');
    const msgValidation = validateMessage(message);
    if (!msgValidation.ok) {
      return res.status(400).json({ error: msgValidation.error });
    }

    const config = loadConfig();
    const history = calibrationConversations.get(sessionId);
    const mqtt = MqttService.getInstance();

    const result = await calibrationChat(msgValidation.value, config, history);

    calibrationConversations.append(sessionId, [
      { role: 'user', content: msgValidation.value },
      { role: 'assistant', content: JSON.stringify(result) },
    ]);

    // If the AI wants to run the robot, execute the command
    if (result.robotCommand && mqtt.isConnected()) {
      mqtt.sendCommand(result.robotCommand);
    }

    // If the AI produced calibration data points, save them
    if (result.calibrationData) {
      config.calibrations = config.calibrations || {};
      for (const [key, entries] of Object.entries(result.calibrationData)) {
        if (!config.calibrations[key]) config.calibrations[key] = [];
        // Append new entries (avoid exact duplicates)
        for (const entry of entries) {
          const isDup = config.calibrations[key].some(e =>
            e.speed === entry.speed && e.duration === entry.duration && e.distance_inches === entry.distance_inches
          );
          if (!isDup) {
            config.calibrations[key].push(entry);
          }
        }
      }
      config.updatedAt = new Date().toISOString();
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    }

    res.json(result);
  } catch (error) {
    console.error('Calibration chat error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/config/calibrate/clear
 * Clear calibration conversation history
 */
configRoutes.post('/calibrate/clear', (req, res) => {
  const sessionId = getSessionId(req.body?.sessionId, 'calibration');
  calibrationConversations.clear(sessionId);
  res.json({ success: true });
});

/**
 * GET /api/config/calibrations
 * Get all stored calibration data
 */
configRoutes.get('/calibrations', (req, res) => {
  const config = loadConfig();
  res.json({ calibrations: config.calibrations || {} });
});

/**
 * DELETE /api/config/calibrations
 * Clear all calibration data
 */
configRoutes.delete('/calibrations', (req, res) => {
  try {
    const config = loadConfig();
    config.calibrations = {};
    config.updatedAt = new Date().toISOString();
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Load configuration from file
 */
export function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const data = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(data);

      const hasExistingAdditions = Array.isArray(parsed?.additions) && parsed.additions.length > 0;
      if (hasExistingAdditions) {
        return parsed;
      }

      return {
        ...parsed,
        name: parsed?.name || DEFAULT_CONFIG.name,
        additions: buildDefaultRoverAdditions(),
      };
    }
  } catch (e) {
    console.warn('Could not load config, using defaults:', e.message);
  }
  return {
    ...DEFAULT_CONFIG,
    additions: buildDefaultRoverAdditions(),
  };
}
