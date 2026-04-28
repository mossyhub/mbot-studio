# mBot Studio

**AI-Powered Robot Programming for Kids**

A kid-friendly platform that blends visual block coding with AI-powered natural language programming for the [Makeblock mBot2](https://www.makeblock.com/pages/mbot2) rover. Children ages 6–12 describe what they want the robot to do in plain English, and the AI generates colorful code blocks they can see, edit, and run.

![License](https://img.shields.io/badge/license-MIT-blue)
![Node](https://img.shields.io/badge/node-20%2B-green)
![Docker](https://img.shields.io/badge/docker-ready-blue)

## How It Works

1. **Talk to the AI** — Type what you want: *"Make the robot drive in a square"*, *"Do a happy dance!"*
2. **See the blocks** — The AI generates visual code blocks kids can drag, reorder, and modify
3. **Run it** — Upload the program to the mBot2 over WiFi and watch it go!
4. **Live control** — Switch to real-time commands with a D-pad, voice input, and hardware controls

```
┌──────────────────────────────┐
│    Web Interface (React)     │
│   Chat + Blocks + Controls   │
└──────────────┬───────────────┘
               │ HTTP / WebSocket
┌──────────────┴───────────────┐
│   Backend Server (Node.js)   │
│  AI Service + MQTT Bridge    │
└──────────────┬───────────────┘
               │ MQTT (WiFi)
┌──────────────┴───────────────┐
│     mBot2 (MicroPython)      │
│  Motors + Sensors + Display  │
└──────────────────────────────┘
```

## Features

- **AI Chat Programming** — Natural language → block programs using your robot's hardware config
- **Visual Block Editor** — 27 block types across 7 categories (movement, sensors, sound, control, variables, hardware)
- **Live Control** — D-pad, servo/motor controls, voice commands, real-time telemetry
- **Hardware Wizard** — Guided setup for servos and motors with live testing and named positions
- **Debug Terminal** — Remote MicroPython REPL, motor diagnostics, live log streaming
- **Challenges & Achievements** — Guided coding challenges and a badge system for kids
- **Custom Hardware** — Config-aware AI that knows about your robot's arms, claws, and accessories
- **One-Click Firmware Upload** — Flash custom firmware to the mBot2 via USB through mLink2

## Requirements

- **mBot2** with CyberPi (ESP32) — [Makeblock store](https://www.makeblock.com/pages/mbot2)
- **MQTT broker** — [Mosquitto](https://mosquitto.org/) running on your network
- **AI provider** (one of):
  - [Azure OpenAI](https://azure.microsoft.com/en-us/products/ai-services/openai-service) (recommended)
  - [GitHub Models](https://github.com/marketplace/models) via GitHub Copilot subscription
- **Makeblock mLink2** — For one-time firmware upload (USB, runs locally)

## Quick Start

### Option A: Docker (recommended)

```bash
# Pull the image
docker pull ghcr.io/mossyhub/mbot-studio:latest

# Create your config
curl -o .env https://raw.githubusercontent.com/mossyhub/mbot-studio/master/.env.example
# Edit .env with your settings (see Configuration below)

# Run
docker run -d \
  --name mbot-studio \
  --restart unless-stopped \
  -p 3001:3001 \
  --env-file .env \
  -v mbot-data:/app/data \
  ghcr.io/mossyhub/mbot-studio:latest
```

Open **http://your-server:3001** in a browser.

### Option B: Docker Compose

```bash
git clone https://github.com/mossyhub/mbot-studio.git
cd mbot-studio
cp .env.example .env
# Edit .env with your settings

docker compose up -d
```

### Option C: Run from source

```bash
git clone https://github.com/mossyhub/mbot-studio.git
cd mbot-studio
npm install
cp .env.example .env
# Edit .env with your settings

npm run dev    # Development (hot reload on :5173 + API on :3001)
# or
npm run build  # Build frontend
npm start      # Production (serves everything on :3001)
```

## Configuration

Copy `.env.example` to `.env` and configure:

### AI Provider (choose one)

**Azure OpenAI** (recommended):
```env
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com/
AZURE_OPENAI_API_KEY=your_api_key
AZURE_OPENAI_DEPLOYMENT=your_deployment_name
```

**GitHub Models** (alternative):
```env
GITHUB_TOKEN=ghp_your_token_here
```

### Required Settings

```env
# MQTT broker on your network (where the mBot2 connects)
MQTT_BROKER_URL=mqtt://192.168.1.100:1883

# WiFi credentials (embedded in firmware for the mBot2 to connect)
WIFI_SSID=YourWiFiName
WIFI_PASSWORD=YourWiFiPassword
```

### Optional Settings

```env
PORT=3001                    # Server port (default: 3001)
AI_LOCAL_DEBUG=false          # Use offline mock AI for testing without API keys
ENABLE_REPL=true             # Enable Debug Terminal REPL (default: true)
```

## First-Time Robot Setup

1. **Install mLink2** on a computer with USB — [download from Makeblock](https://www.mblock.cc/en/download)
2. **Connect mBot2** via USB-C cable
3. Open mBot Studio → **Setup** tab → enter WiFi & MQTT settings → **Upload Firmware via mLink**
4. **Full power cycle**: disconnect USB, power off, wait 3 seconds, power on
5. The robot will connect to your WiFi/MQTT automatically — the status bar turns green

After firmware is uploaded once, the robot connects wirelessly. No USB needed again unless re-flashing.

See [firmware/README.md](firmware/README.md) for the complete firmware reference.

## Tabs

| Tab | What it does |
|-----|-------------|
| **Program** | AI chat + visual block editor + Python code preview |
| **Live Control** | D-pad driving, servo/motor controls, voice commands, telemetry |
| **Challenges** | Guided coding challenges for learning |
| **Achievements** | Badge system and progress tracking |
| **Setup** | Hardware wizard, firmware upload, AI config, calibration |
| **Debug** | Remote REPL, motor diagnostics, live robot logs |

## Project Structure

```
mbot-studio/
├── server/                   # Node.js + Express backend
│   └── src/
│       ├── services/
│       │   ├── ai-service.js         # AI generation (Azure OpenAI / GitHub Models)
│       │   ├── mqtt-service.js       # MQTT bridge + hardware state tracking
│       │   ├── code-generator.js     # Blocks → MicroPython compiler
│       │   ├── websocket.js          # WebSocket gateway
│       │   └── mlink-bridge.js       # mLink2 firmware upload protocol
│       └── routes/                   # REST API endpoints
├── web/                      # React + Vite frontend
│   └── src/components/               # UI components
├── firmware/                 # MicroPython firmware for mBot2
│   ├── main.py                       # Entry point + event loop
│   ├── mbot_commands.py              # Command dispatch (24 block types)
│   ├── mbot_motor.py                 # Motor/servo control
│   ├── mbot_sensor.py                # Sensor abstraction
│   └── mbot_mqtt.py                  # MQTT client
├── Dockerfile                # Multi-stage Docker build
├── docker-compose.yml        # Docker Compose config
└── .env.example              # Environment template
```

## API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/ai/generate` | Generate block program from natural language |
| POST | `/api/ai/chat` | Chat with AI assistant |
| GET | `/api/ai/models` | List available AI models |
| POST | `/api/robot/command` | Send single command to robot |
| POST | `/api/robot/program` | Send full program to robot |
| GET | `/api/config` | Get robot hardware config |
| POST | `/api/config` | Save robot hardware config |
| WS | `/ws` | Live control, telemetry, REPL, diagnostics |

## MQTT Topics

| Topic | Direction | Purpose |
|-------|-----------|---------|
| `mbot-studio/robot/command` | Server → Robot | Single command |
| `mbot-studio/robot/program` | Server → Robot | Full block program |
| `mbot-studio/robot/emergency` | Server → Robot | Emergency stop |
| `mbot-studio/robot/repl` | Server → Robot | REPL code execution |
| `mbot-studio/robot/status` | Robot → Server | Heartbeat + state |
| `mbot-studio/robot/sensors` | Robot → Server | Sensor telemetry |
| `mbot-studio/robot/log` | Robot → Server | Debug messages |

## Development

```bash
npm run dev       # Start dev server (hot reload)
npm run build     # Build frontend for production
npm start         # Run production server
```

The dev server runs the backend on `:3001` and Vite frontend on `:5173` with hot module replacement.

## Security Notes

- **No authentication** — designed for local network / home use only
- API keys live in `.env` (gitignored) and are never exposed to the frontend
- The REPL endpoint executes arbitrary Python on the robot — disable with `ENABLE_REPL=false`
- Firmware upload via mLink is localhost-only (127.0.0.1:52384)

## License

MIT

## Supported Block Types

| Category | Blocks |
|----------|--------|
| **Movement** | `move_forward`, `move_backward`, `turn_left`, `turn_right`, `stop`, `set_speed` |
| **Sensors** | `if_obstacle`, `if_line`, `if_color`, `if_sensor_range`, `display_value` |
| **Sound & Display** | `play_tone`, `play_melody`, `display_text`, `display_image`, `say`, `set_led` |
| **Control** | `wait`, `repeat`, `repeat_forever`, `if_button`, `while_sensor`, `move_until` |
| **Variables** | `set_variable`, `change_variable`, `math_operation` |
| **Hardware** | `dc_motor`, `servo` |

All 27 block types are supported end-to-end: UI → AI → code generator → firmware dispatch.

## Firmware Upload Protocol

The firmware is uploaded via the F3F4 binary protocol through mLink2's `data-channel` serial bridge. See [docs/upload-investigation.md](docs/upload-investigation.md) for the complete protocol specification including frame format, file transfer sub-protocol, and mode switching.

Key points:
- Files are bundled into a single `main.py` and written to `/flash/_xx_main.py`
- The server reads firmware files fresh from disk on each upload (no caching)
- Full power cycle is required after upload for new code to take effect
- Do NOT write to `/flash/main.py` — it conflicts with CyberPi boot

## Docker Deployment

```bash
docker build -t mbot-studio .
docker run -d --name mbot-studio -p 3001:3001 --env-file .env mbot-studio
```

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GITHUB_TOKEN` | Yes | — | GitHub PAT with Copilot access |
| `MQTT_BROKER_URL` | Yes | `mqtt://localhost:1883` | Mosquitto server |
| `AI_MODEL` | No | `openai/gpt-5-chat` | AI model |
| `PORT` | No | `3001` | Server port |
| `DATA_DIR` | No | `/app/data` | Config persistence directory |
| `MQTT_TOPIC_PREFIX` | No | `mbot-studio` | MQTT topic namespace |

## Getting a GitHub Token

1. Go to [github.com/settings/tokens](https://github.com/settings/tokens)
2. Click **"Generate new token (classic)"**
3. Select scopes: `read:user` (and `copilot` if available)
4. Copy the token into `.env`

Requires an active GitHub Copilot subscription for the GitHub Models API.

## Troubleshooting

### Robot doesn't move (commands received on screen)
All motor commands must execute from the main loop, not inside MQTT callbacks (ESP32 recursion limit). The firmware uses deferred execution — if this breaks, commands are received but silently fail.

### Black screen after firmware flash
Writing to `/flash/main.py` conflicts with CyberPi boot. Use "Test Motors Only" button to recover, then reflash. The upload must write to `/flash/_xx_main.py` only.

### Firmware changes not taking effect
1. The server reads firmware files fresh from disk (no restart needed)
2. But the CyberPi requires a **full power cycle** (disconnect USB-C + power off) after flash
3. Verify the bundle content via the server log: `[upload] Bundle check — has __builtins__: false`

### MQTT connection drops after diagnostic/command
Long-running operations (diagnostics, programs) must be deferred to the main loop. Running them inside the MQTT callback blocks `check_msg()` and causes keepalive timeout.

### "maximum recursion depth exceeded"
Code is running too deep in the call stack. The CyberPi has ~20 frame limit. Use the deferred execution pattern: callback sets a flag, main loop executes.

## For Parents

- **No internet content** — AI only generates robot programs
- **No data collection** — everything runs on your own network
- **Emergency stop** — red button in UI or Button A on robot
- **Safe defaults** — motor speeds capped at 80%, obstacle detection built-in
- **Learning tool** — kids see real Python code generated from their ideas

## License

MIT
