import { MqttService } from './mqtt-service.js';
import { TelemetryService } from './telemetry-service.js';

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
    case 'command':
      // Forward command to robot via MQTT
      if (mqtt.sendCommand(msg.command)) {
        ws.send(JSON.stringify({ type: 'ack', command: msg.command.type }));
      } else {
        ws.send(JSON.stringify({ type: 'error', message: 'Robot not connected' }));
      }
      break;

    case 'emergency_stop':
      mqtt.emergencyStop();
      broadcast({ type: 'emergency_stop', timestamp: Date.now() });
      break;

    case 'request_sensors':
      mqtt.requestSensors();
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
