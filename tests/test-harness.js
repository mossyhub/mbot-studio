/**
 * Test harness — spins up an in-process Aedes MQTT broker, the Express
 * server, and the robot simulator.  Playwright tests import this to get
 * a fully-wired environment with no external dependencies.
 *
 * AI credentials: reads from the project .env file automatically.
 *   - If Azure OpenAI or GitHub Models creds are present → real AI is used.
 *   - If no creds are found (or --local flag) → AI_LOCAL_DEBUG fallback.
 *   - Force local mode: set TEST_AI_LOCAL=true in env or pass forceLocalAI option.
 */
import { Aedes } from 'aedes';
import { createServer as createNetServer } from 'net';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { RobotSimulator } from './robot-simulator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Parse a .env file into a plain object (no overwriting process.env).
 */
function parseDotenv(filePath) {
  const vars = {};
  if (!fs.existsSync(filePath)) return vars;
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    vars[key] = val;
  }
  return vars;
}

export class TestHarness {
  constructor(options = {}) {
    this.mqttPort = options.mqttPort || 18830;
    this.serverPort = options.serverPort || 13001;
    this.vitePort = options.vitePort || 15173;
    this.topicPrefix = options.topicPrefix || 'mbot-studio';
    this.forceLocalAI = options.forceLocalAI || process.env.TEST_AI_LOCAL === 'true';

    // Load credentials from the project .env
    this._dotenv = parseDotenv(path.resolve(__dirname, '../.env'));

    this._aedes = null;
    this._mqttServer = null;
    this._serverProc = null;
    this.simulator = null;
    this.useRealAI = false; // set during start
  }

  /** Start MQTT broker → server → simulator. Returns when all are ready. */
  async start() {
    await this._startMqttBroker();
    await this._startServer();
    this.simulator = new RobotSimulator(
      `mqtt://127.0.0.1:${this.mqttPort}`,
      this.topicPrefix,
    );
    await this.simulator.connect();
    // Give the server a moment to register the simulator's "ready" status
    await new Promise((r) => setTimeout(r, 500));
  }

  /** Tear everything down */
  async stop() {
    if (this.simulator) {
      await this.simulator.disconnect();
      this.simulator = null;
    }
    await this._stopServer();
    await this._stopMqttBroker();
  }

  // ── MQTT broker (Aedes) ────────────────────────────────────────

  async _startMqttBroker() {
    this._aedes = await Aedes.createBroker();
    return new Promise((resolve, reject) => {
      this._mqttServer = createNetServer(this._aedes.handle);
      this._mqttServer.on('error', reject);
      this._mqttServer.listen(this.mqttPort, () => {
        console.log(`[harness] MQTT broker on port ${this.mqttPort}`);
        resolve();
      });
    });
  }

  async _stopMqttBroker() {
    if (this._aedes) {
      await new Promise((resolve) => this._aedes.close(resolve));
      this._aedes = null;
    }
    if (this._mqttServer) {
      await new Promise((resolve) => this._mqttServer.close(resolve));
      this._mqttServer = null;
    }
  }

  // ── Express server ─────────────────────────────────────────────

  async _startServer() {
    return new Promise((resolve, reject) => {
      const serverDir = path.resolve(__dirname, '../server');

      // Determine AI mode: real AI if credentials exist and not forced local
      const hasAzure = this._dotenv.AZURE_OPENAI_ENDPOINT
        && this._dotenv.AZURE_OPENAI_API_KEY
        && this._dotenv.AZURE_OPENAI_DEPLOYMENT;
      const hasGitHub = this._dotenv.GITHUB_TOKEN && this._dotenv.AI_BASE_URL;
      this.useRealAI = !this.forceLocalAI && (hasAzure || hasGitHub);

      const env = {
        ...process.env,
        PORT: String(this.serverPort),
        HOST: '127.0.0.1',
        MQTT_BROKER_URL: `mqtt://127.0.0.1:${this.mqttPort}`,
        MQTT_TOPIC_PREFIX: this.topicPrefix,
        NODE_ENV: 'test',
      };

      if (this.useRealAI) {
        // Forward AI credentials from .env
        const aiKeys = [
          'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_DEPLOYMENT',
          'GITHUB_TOKEN', 'AI_API_KEY', 'AI_BASE_URL', 'AI_MODEL',
        ];
        for (const key of aiKeys) {
          if (this._dotenv[key]) env[key] = this._dotenv[key];
        }
        console.log('[harness] AI mode: REAL (' + (hasAzure ? 'Azure OpenAI' : 'GitHub Models') + ')');
      } else {
        env.AI_LOCAL_DEBUG = 'true';
        console.log('[harness] AI mode: LOCAL DEBUG (deterministic, no API calls)');
      }

      this._serverProc = spawn('node', ['src/index.js'], {
        cwd: serverDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let started = false;

      const onData = (chunk) => {
        const text = chunk.toString();
        if (!started && text.includes('mBot Studio Server running')) {
          started = true;
          console.log(`[harness] Server on port ${this.serverPort}`);
          resolve();
        }
      };

      this._serverProc.stdout.on('data', onData);
      this._serverProc.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        // Suppress expected warnings
        if (!text.includes('MQTT not available')) {
          process.stderr.write(`[server] ${text}`);
        }
      });

      this._serverProc.on('exit', (code) => {
        if (!started) reject(new Error(`Server exited with code ${code}`));
      });

      // Timeout
      setTimeout(() => {
        if (!started) reject(new Error('Server start timeout'));
      }, 15000);
    });
  }

  async _stopServer() {
    if (this._serverProc) {
      this._serverProc.kill('SIGTERM');
      await new Promise((resolve) => {
        this._serverProc.on('exit', resolve);
        setTimeout(() => {
          this._serverProc.kill('SIGKILL');
          resolve();
        }, 3000);
      });
      this._serverProc = null;
    }
  }

  // ── Convenience getters ────────────────────────────────────────

  get serverUrl() {
    return `http://127.0.0.1:${this.serverPort}`;
  }

  get wsUrl() {
    return `ws://127.0.0.1:${this.serverPort}/ws`;
  }

  get baseUrl() {
    // In CI/test mode, Playwright hits the server directly (which serves built frontend)
    // In dev mode, it hits the Vite dev server
    return this.serverUrl;
  }
}
