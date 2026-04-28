import { MqttService } from './mqtt-service.js';
import { TelemetryService } from './telemetry-service.js';
import { validateCommand } from './validation.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '../..', 'robot-config.json');

function getTurnMultiplier() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    return cfg.turnMultiplier || 1;
  } catch {
    return 1;
  }
}

const wsClients = new Set();

/**
 * Set up WebSocket server for real-time communication with the frontend
 * This handles live mode, sensor updates, and status messages
 */
export function setupWebSocket(wss) {
  const mqtt = MqttService.getInstance();
  const telemetry = TelemetryService.getInstance();

  wss.on('connection', (ws) => {
    console.log('🔌 WebSocket client connected');
    wsClients.add(ws);

    // Send initial status
    ws.send(JSON.stringify({
      type: 'status',
      mqtt: mqtt.isConnected(),
      message: mqtt.isConnected() ? 'Connected to robot' : 'Robot not connected (MQTT offline)',
    }));

    // Send latest telemetry snapshot immediately on connect
    const currentTelemetry = telemetry.getTelemetry();
    if (currentTelemetry.timestamp) {
      ws.send(JSON.stringify({ type: 'telemetry', data: currentTelemetry }));
    }

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        handleWebSocketMessage(ws, msg);
      } catch (e) {
        console.error('WebSocket message parse error:', e);
      }
    });

    ws.on('close', () => {
      wsClients.delete(ws);
      console.log('🔌 WebSocket client disconnected');
    });
  });

  // Forward MQTT messages from robot to all WebSocket clients
  mqtt.onMessage('websocket-bridge', (topic, payload) => {
    const parsedData = tryParseJSON(payload);

    // Feed sensor data into the telemetry service
    if (topic === 'robot/sensors' && typeof parsedData === 'object') {
      telemetry.updateSensors(parsedData);

      // Broadcast enriched telemetry instead of raw sensor data
      const telemetryPayload = telemetry.getTelemetry();
      broadcast({ type: 'telemetry', data: telemetryPayload });
    }

    // Still forward raw MQTT messages for the activity log
    const message = {
      type: 'mqtt',
      topic,
      data: parsedData,
    };

    for (const client of wsClients) {
      if (client.readyState === 1) { // OPEN
        client.send(JSON.stringify(message));
      }
    }
  });
}

function handleWebSocketMessage(ws, msg) {
  const mqtt = MqttService.getInstance();

  switch (msg.type) {
    case 'command': {
      // Validate command structure
      const cmdValidation = validateCommand(msg.command);
      if (!cmdValidation.ok) {
        ws.send(JSON.stringify({ type: 'error', message: cmdValidation.error }));
        break;
      }
      // Apply turn multiplier if this is a turn command
      let cmd = cmdValidation.value;
      if ((cmd.type === 'turn_left' || cmd.type === 'turn_right') && cmd.angle) {
        const mult = getTurnMultiplier();
        if (mult !== 1) {
          cmd = { ...cmd, angle: Math.round(cmd.angle * mult) };
        }
      }
      if (mqtt.sendCommand(cmd)) {
        ws.send(JSON.stringify({ type: 'ack', command: cmd.type }));
      } else {
        ws.send(JSON.stringify({ type: 'error', message: 'Robot not connected' }));
      }
      break;
    }

    case 'emergency_stop':
      mqtt.emergencyStop();
      broadcast({ type: 'emergency_stop', timestamp: Date.now() });
      break;

    case 'request_sensors':
      mqtt.requestSensors();
      break;

    case 'repl':
      // Forward REPL code to robot via MQTT (guarded by ENABLE_REPL env var)
      if (process.env.ENABLE_REPL === 'false') {
        ws.send(JSON.stringify({ type: 'error', message: 'REPL is disabled. Set ENABLE_REPL=true in .env to enable.' }));
        break;
      }
      if (msg.code) {
        const replId = msg.id || `repl_${Date.now()}`;
        mqtt.sendRepl(msg.code, replId);
        ws.send(JSON.stringify({ type: 'repl_ack', id: replId }));
      }
      break;

    case 'diagnostic':
      mqtt.sendDiagnostic();
      ws.send(JSON.stringify({ type: 'ack', command: 'run_diagnostic' }));
      break;

    case 'ping':
      ws.send(JSON.stringify({ type: 'pong' }));
      break;

    default:
      console.log('Unknown WebSocket message type:', msg.type);
  }
}

function broadcast(message) {
  const data = JSON.stringify(message);
  for (const client of wsClients) {
    if (client.readyState === 1) {
      client.send(data);
    }
  }
}

function tryParseJSON(str) {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

export { wsClients, broadcast };
