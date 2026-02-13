import { Router } from 'express';
import { parseRobotConfig } from '../services/ai-service.js';
import { calibrationChat } from '../services/calibration-service.js';
import { MqttService } from '../services/mqtt-service.js';
import { SessionStore } from '../services/session-store.js';
import { getSessionId, validateMessage } from '../services/validation.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../..');
const CONFIG_PATH = path.join(DATA_DIR, 'robot-config.json');

export const configRoutes = Router();

// Default robot configuration
const DEFAULT_CONFIG = {
  name: 'My mBot2',
  additions: [],
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
    const { description } = req.body;

    if (!description) {
      return res.status(400).json({ error: 'Description is required' });
    }

    const result = await parseRobotConfig(description);
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
      return JSON.parse(data);
    }
  } catch (e) {
    console.warn('Could not load config, using defaults:', e.message);
  }
  return { ...DEFAULT_CONFIG };
}
