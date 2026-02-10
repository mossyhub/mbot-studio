import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import http from 'http';
import { aiRoutes } from './routes/ai.js';
import { robotRoutes } from './routes/robot.js';
import { configRoutes } from './routes/config.js';
import { MqttService } from './services/mqtt-service.js';
import { setupWebSocket } from './services/websocket.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env from project root (parent of server/)
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Routes
app.use('/api/ai', aiRoutes);
app.use('/api/robot', robotRoutes);
app.use('/api/config', configRoutes);

// Serve built frontend in production
const publicDir = path.join(__dirname, '../public');
app.use(express.static(publicDir));

// SPA fallback — serve index.html for non-API routes
app.get(/^(?!\/api|\/ws).*/, (req, res, next) => {
  const indexPath = path.join(publicDir, 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) next(); // file not found — dev mode, no build
  });
});

// Create HTTP server
const server = http.createServer(app);

// WebSocket server (for live mode real-time communication)
const wss = new WebSocketServer({ server, path: '/ws' });
setupWebSocket(wss);

// Initialize MQTT service
const mqttService = MqttService.getInstance();
mqttService.connect().then(() => {
  console.log('📡 MQTT service ready');
}).catch(err => {
  console.warn('⚠️  MQTT not available (robot live mode will be limited):', err.message);
  console.warn('   Install Mosquitto or run: docker run -p 1883:1883 eclipse-mosquitto');
});

// Start server
const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`\n🤖 mBot Studio Server running on http://${HOST}:${PORT}`);
  console.log(`🔌 WebSocket available on ws://localhost:${PORT}/ws`);
  console.log(`\n📋 Endpoints:`);
  console.log(`   POST /api/ai/generate    - Generate blocks from natural language`);
  console.log(`   POST /api/ai/chat        - Chat with AI assistant`);
  console.log(`   POST /api/robot/command   - Send command to robot`);
  console.log(`   GET  /api/config          - Get robot configuration`);
  console.log(`   POST /api/config          - Save robot configuration\n`);
});

export { mqttService };
