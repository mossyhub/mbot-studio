import { Router } from 'express';
import { parseRobotConfig } from '../services/ai-service.js';
import { calibrationChat } from '../services/calibration-service.js';
import { MqttService } from '../services/mqtt-service.js';
import { SessionStore } from '../services/session-store.js';
import { checkNativeFlashSupport, flashFirmwareNative, formatNativeFlashError, listNativeSerialPorts } from '../services/native-flash.js';
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
  'config.py',
  'mqtt_client.py',
  'motor_controller.py',
  'sensor_reader.py',
  'command_handler.py',
];

export const configRoutes = Router();

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
 * Return required firmware files for one-time USB flashing from Setup UI
 */
configRoutes.get('/firmware', (req, res) => {
  try {
    const files = REQUIRED_FIRMWARE_FILES.map((name) => {
      const filePath = path.join(FIRMWARE_DIR, name);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Missing firmware file: ${name}`);
      }
      const content = fs.readFileSync(filePath, 'utf-8');
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
 * GET /api/config/flash-native/check
 * Check whether native flashing prerequisites are installed
 */
configRoutes.get('/flash-native/check', async (req, res) => {
  const result = await checkNativeFlashSupport();
  if (!result.ok) {
    return res.status(200).json(result);
  }
  return res.json(result);
});

/**
 * GET /api/config/flash-native/ports
 * List available serial ports for native flashing
 */
configRoutes.get('/flash-native/ports', async (req, res) => {
  try {
    const ports = await listNativeSerialPorts();
    res.json({ ok: true, ports });
  } catch (error) {
    const formatted = formatNativeFlashError(error);
    res.status(500).json({ ok: false, error: formatted.error, hint: formatted.hint });
  }
});

/**
 * POST /api/config/flash-native
 * Native firmware flash path using Python + mpremote
 */
configRoutes.post('/flash-native', async (req, res) => {
  try {
    const { files, port } = req.body || {};
    const result = await flashFirmwareNative({ files, port });
    res.json(result);
  } catch (error) {
    const formatted = formatNativeFlashError(error);
    res.status(500).json({
      ok: false,
      error: formatted.error,
      hint: formatted.hint,
      installHint: formatted.installHint,
    });
  }
});

/**
 * POST /api/config
 * Save robot configuration
 */
configRoutes.post('/', (req, res) => {
  try {
    const config = {
      ...loadConfig(),
      ...req.body,
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
