# mBot Studio 🤖

**AI-Powered Robot Programming for Kids**

A kid-friendly platform that blends block coding with AI-powered natural language programming for the Makeblock mBot2 rover. Designed for children ages 6-12.

## How It Works

1. **Talk to the AI**: Type what you want the robot to do in plain English — *"Make the robot drive in a square"*, *"Do a happy dance!"*
2. **See the blocks**: The AI generates colorful code blocks that kids can drag, reorder, and modify
3. **Send to robot**: Upload the program to your mBot2 over WiFi (MQTT) and watch it go!
4. **Live control**: Switch to Live Mode for real-time commands — directional pad, voice commands, and more

## Architecture

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

## Prerequisites

- **Node.js** 18+ — [Download](https://nodejs.org/) *(local dev only)*
- **Docker** — [Download](https://docs.docker.com/get-docker/) *(for containerized deployment)*
- **MQTT Broker** — An external [Mosquitto](https://mosquitto.org/) server on your network
- **GitHub account** with Copilot subscription (for AI features)
- **mBot2** with CyberPi (ESP32) and WiFi capability

## Quick Start

### 1. Clone & Install

```bash
cd d:\personal\mbot
npm install
```

This installs dependencies for both the server and web frontend (npm workspaces).

### 2. Configure Environment

Copy the example environment file and fill in your values:

```bash
copy .env.example .env
```

Edit `.env`:

```env
# Required: Your GitHub personal access token (with Copilot access)
GITHUB_TOKEN=ghp_your_token_here

# AI model fallback (server auto-selects best available OpenAI model at startup)
AI_MODEL=openai/gpt-5-chat
AI_BASE_URL=https://models.github.ai/inference

# MQTT broker — point to your external Mosquitto server
MQTT_BROKER_URL=mqtt://your-mqtt-server:1883

# Server port
PORT=3001

# WiFi for the robot (must match your home WiFi)
WIFI_SSID=YourWiFiName
WIFI_PASSWORD=YourWiFiPassword
```

### 3. Start the Platform (Local Dev)

```bash
npm run dev
```

This starts both the backend (port 3001) and frontend (port 5173) concurrently.

Open **http://localhost:5173** in your browser.

### 3b. Live Debug Mode (no cloud AI required)

If the Program tab keeps replying with "Oops! I had trouble thinking about that...", run in local debug mode:

1) In `.env`, set:

```env
AI_LOCAL_DEBUG=true
```

2) Start with Node inspector enabled:

```bash
npm run dev:debug
```

3) Verify AI mode:

```bash
curl http://localhost:3001/api/ai/diagnostics
```

You should see `"localDebug": true` and model `local/debug-rule-engine`.

### 4. Upload Firmware to mBot2

See [firmware/README.md](firmware/README.md) for detailed upload instructions.

## Docker Deployment

The app ships as a single container — the Node.js server serves both the API and the built React frontend.

### Build & Run Locally

```bash
# Build the image
docker build -t mbot-studio .

# Run with your .env file
docker run -d \
  --name mbot-studio \
  -p 3001:3001 \
  --env-file .env \
  -e DATA_DIR=/app/data \
  -v mbot-data:/app/data \
  --restart unless-stopped \
  mbot-studio
```

Open **http://your-server-ip:3001** in your browser.

### Using Docker Compose

```bash
# Make sure .env is configured, then:
docker compose up -d

# View logs
docker compose logs -f

# Stop
docker compose down
```

### Push to Docker Hub

```bash
# Tag for your Docker Hub account
docker tag mbot-studio:latest yourusername/mbot-studio:latest

# Push
docker push yourusername/mbot-studio:latest
```

Then on any machine on your network:

```bash
docker run -d \
  --name mbot-studio \
  -p 3001:3001 \
  -e GITHUB_TOKEN=ghp_your_token \
  -e MQTT_BROKER_URL=mqtt://your-mqtt-server:1883 \
  -e DATA_DIR=/app/data \
  -v mbot-data:/app/data \
  --restart unless-stopped \
  yourusername/mbot-studio:latest
```

### Environment Variables (Docker)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GITHUB_TOKEN` | Yes | — | GitHub PAT with Copilot access |
| `MQTT_BROKER_URL` | Yes | `mqtt://localhost:1883` | Your external Mosquitto server |
| `AI_MODEL` | No | `openai/gpt-5-chat` | Fallback model if auto-selection is unavailable |
| `AI_BASE_URL` | No | `https://models.github.ai/inference` | GitHub Models endpoint |
| `PORT` | No | `3001` | Server port inside container |
| `DATA_DIR` | No | `/app/data` | Persistent config directory (mount a volume here) |
| `MQTT_TOPIC_PREFIX` | No | `mbot-studio` | MQTT topic namespace |

### Network Requirements

The Docker container needs to reach:
- **Your MQTT broker** — the mBot2 and the container must both be able to reach it
- **GitHub Models API** (`models.github.ai`) — for AI features
- The mBot2 connects to the MQTT broker directly (not to this container)

```
Browser ──► Container:3001 ──► MQTT Broker ◄── mBot2
                              (your server)
```

## Features

### 🗣️ AI Chat Programming
Type what you want in plain English. The AI generates block programs:
- *"Drive forward for 3 seconds then turn right"*
- *"If something is in front, turn around"*
- *"Play a melody and flash the lights"*

### 🧩 Visual Block Editor
- Colorful blocks organized by category (Movement, Sensors, Sound, Display, Control)
- Drag to reorder, click to delete
- Loops and conditionals with nesting
- Always see and edit what the AI generated

### 🎮 Live Control Mode
- D-pad for real-time directional control
- Natural language live commands (*"go forward slowly"*)
- Custom hardware buttons (claw, arm, etc.)
- Live sensor data display

### ⚙️ Robot Configuration
- Describe custom hardware in plain English: *"My Rover claw uses two servos on S1 and S2"*
- AI parses descriptions into structured config
- Supports DC motors (M1-M4), servos (S1-S4), and mBuild sensors (P1-P4)

### 📝 Code Preview
- See the generated MicroPython code
- Copy or download for offline use
- Learn programming concepts by reading the output

## Project Structure

```
mbot/
├── package.json          # Root workspace config
├── .env.example          # Environment template
├── Dockerfile            # Multi-stage Docker build
├── docker-compose.yml    # Compose config (external MQTT)
├── .dockerignore
├── .gitignore
│
├── server/               # Backend (Node.js + Express)
│   ├── package.json
│   └── src/
│       ├── index.js          # Server entry point
│       ├── services/
│       │   ├── ai-service.js      # GitHub Models AI integration
│       │   ├── mqtt-service.js    # MQTT broker connection
│       │   ├── code-generator.js  # Blocks → MicroPython
│       │   └── websocket.js       # WebSocket real-time bridge
│       └── routes/
│           ├── ai.js         # AI chat & generation endpoints
│           ├── robot.js      # Robot command & program endpoints
│           └── config.js     # Robot configuration endpoints
│
├── web/                  # Frontend (React + Vite)
│   ├── package.json
│   ├── vite.config.js
│   ├── index.html
│   └── src/
│       ├── main.jsx
│       ├── App.jsx           # Main app with tabs
│       └── components/
│           ├── Header.jsx        # Navigation & status
│           ├── ChatPanel.jsx     # AI chat interface
│           ├── BlocklyEditor.jsx # Visual block editor
│           ├── CodePreview.jsx   # Python code display
│           ├── RobotConfig.jsx   # Hardware configuration
│           ├── LiveControl.jsx   # Real-time robot control
│           └── StatusBar.jsx     # Connection status
│
└── firmware/             # mBot2 MicroPython firmware
    ├── main.py               # Entry point
    ├── config.py             # WiFi/MQTT/hardware settings
    ├── mqtt_client.py        # MQTT communication
    ├── motor_controller.py   # Motor & servo control
    ├── sensor_reader.py      # Sensor reading
    └── command_handler.py    # Command dispatch
```

## Getting a GitHub Token

1. Go to [github.com/settings/tokens](https://github.com/settings/tokens)
2. Click **"Generate new token (classic)"**
3. Give it a name like "mBot Studio"
4. Select scopes: `read:user` (and `copilot` if available)
5. Copy the token into your `.env` file

> **Note**: You need an active GitHub Copilot subscription. The platform uses the GitHub Models API which is available to Copilot subscribers.

## MQTT Topics

| Topic | Direction | Purpose |
|-------|-----------|---------|
| `mbot-studio/robot/command` | Server → Robot | Single live command |
| `mbot-studio/robot/program` | Server → Robot | Full block program |
| `mbot-studio/robot/emergency` | Server → Robot | Emergency stop |
| `mbot-studio/robot/config` | Server → Robot | Hardware config update |
| `mbot-studio/robot/status` | Robot → Server | Connection/run status |
| `mbot-studio/robot/sensors` | Robot → Server | Sensor readings |
| `mbot-studio/robot/log` | Robot → Server | Debug log messages |

## Supported Block Types

| Category | Blocks |
|----------|--------|
| **Movement** | `move_forward`, `move_backward`, `turn_left`, `turn_right`, `stop`, `set_speed` |
| **Sensors** | `if_obstacle`, `if_line`, `read_distance`, `read_color` |
| **Sound** | `play_sound`, `play_tone`, `say_text` |
| **Display** | `show_text`, `show_image`, `set_led` |
| **Control** | `wait`, `repeat`, `if_then` |
| **Hardware** | `dc_motor`, `servo_set`, `custom_action` |

## Troubleshooting

### "Cannot connect to MQTT"
- Verify your MQTT broker is running on the network
- Check `MQTT_BROKER_URL` in `.env` points to the right host and port
- From the Docker host, test: `mosquitto_pub -h your-mqtt-server -t test -m hello`
- If running in Docker, make sure the container can reach the broker (not `localhost`)

### "AI not responding"  
- Verify your `GITHUB_TOKEN` is valid and not expired
- Check you have an active Copilot subscription
- Test the token: `curl -H "Authorization: Bearer YOUR_TOKEN" https://models.inference.ai.azure.com/models`
- For offline local debugging, set `AI_LOCAL_DEBUG=true` and use `npm run dev:debug`
- Check runtime diagnostics: `GET /api/ai/diagnostics`

### "Robot not connecting"
- Ensure the robot and computer are on the same WiFi network
- Check `firmware/config.py` has the correct WiFi credentials
- Press button B on CyberPi to see connection status

### "Blocks not generating"
- Check the browser console for errors (F12)
- Verify the backend is running on port 3001
- Try refreshing the page

## For Parents

This platform is designed to be safe and educational:
- **No internet content** — AI only generates robot programs
- **No data collection** — everything runs on your own server/network
- **Emergency stop** — press the big red button or CyberPi button A anytime
- **Safe defaults** — motor speeds are capped, obstacle detection is built-in
- **Learning tool** — kids see real Python code generated from their ideas

## License

MIT — Built with ❤️ for young makers
