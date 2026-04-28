import dotenv from 'dotenv';
import fs from 'fs';
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
import { initializeModelSelection } from './services/ai-service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env from project root (parent of server/)
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Routes
app.use('/api/ai', aiRoutes);
app.use('/api/robot', robotRoutes);
app.use('/api/config', configRoutes);

function sendDevUiHint(req, res) {
  const host = req.headers.host || `localhost:${PORT}`;
  res
    .status(200)
    .type('text/plain')
    .send(
      [
        'mBot Studio backend is running.',
        '',
        'Frontend is not being served from this port (no build found).',
        'Start the web UI dev server and open:',
        '  http://localhost:5173/',
        '',
        `API health: http://${host}/api/health`,
      ].join('\n'),
    );
}

// Serve built frontend in production (when present)
const publicDir = path.join(__dirname, '../public');
const indexHtmlPath = path.join(publicDir, 'index.html');
const hasBuiltFrontend = fs.existsSync(indexHtmlPath);
if (hasBuiltFrontend) {
  app.use(express.static(publicDir));
}

// Root hint for dev mode
app.get('/', (req, res) => {
  if (hasBuiltFrontend) return res.sendFile(indexHtmlPath);
  return sendDevUiHint(req, res);
});

// SPA fallback — serve index.html for non-API routes (or hint in dev)
app.get(/^(?!\/api|\/ws).*/, (req, res) => {
  if (hasBuiltFrontend) return res.sendFile(indexHtmlPath);
  return sendDevUiHint(req, res);
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
});

// Start server
const HOST = process.env.HOST || '0.0.0.0';

async function startServer() {
  initializeModelSelection();

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
}

startServer().catch((error) => {
  console.error('❌ Failed to start server:', error);
  process.exit(1);
});

export { mqttService };
