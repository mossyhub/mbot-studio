# mBot Studio

**AI-Powered Robot Programming for Kids**

A kid-friendly platform that blends block coding with AI-powered natural language programming for the Makeblock mBot2 rover. Designed for children ages 6-12.

## How It Works

1. **Talk to the AI**: Type what you want the robot to do in plain English — *"Make the robot drive in a square"*, *"Do a happy dance!"*
2. **See the blocks**: The AI generates colorful code blocks that kids can drag, reorder, and modify
3. **Send to robot**: Upload the program to your mBot2 over WiFi (MQTT) and watch it go!
4. **Live control**: Switch to Live Mode for real-time commands — directional pad, voice commands, hardware controls

## Architecture

```
┌──────────────────────────────┐
│    Web Interface (React)     │
│   Chat + Blocks + Controls   │
│   + Debug REPL + HW Wizard   │
└──────────────┬───────────────┘
               │ HTTP / WebSocket
┌──────────────┴───────────────┐
│   Backend Server (Node.js)   │
│  AI Service + MQTT Bridge    │
│  Code Generator + Bundler    │
└──────────────┬───────────────┘
               │ MQTT (WiFi)
┌──────────────┴───────────────┐
│     mBot2 (MicroPython)      │
│  Motors + Sensors + Display  │
│  Deferred command execution  │
└──────────────────────────────┘
```

## Prerequisites

- **Node.js** 18+ — [Download](https://nodejs.org/)
- **MQTT Broker** — An external [Mosquitto](https://mosquitto.org/) server on your network
- **Makeblock mLink2** — required for one-time firmware upload (runs locally on your computer)
- **GitHub account** with Copilot subscription (for AI features via GitHub Models API)
- **mBot2** with CyberPi (ESP32) and WiFi capability

## Quick Start

### 1. Clone & Install

```bash
cd d:\personal\mbot
npm install
```

### 2. Configure Environment

```bash
copy .env.example .env
```

Edit `.env`:

```env
GITHUB_TOKEN=ghp_your_token_here
AI_MODEL=openai/gpt-5-chat
AI_BASE_URL=https://models.github.ai/inference
MQTT_BROKER_URL=mqtt://your-mqtt-server:1883
PORT=3001
```

### 3. Start the Platform

```bash
npm run dev
```

This starts both the backend (port 3001) and frontend (port 5173).

Open **http://localhost:5173** in your browser.

### 4. Upload Firmware to mBot2

1. Connect mBot2 via USB-C
2. Ensure mLink2 is running on your computer
3. Go to **Setup** tab → fill in WiFi + MQTT settings → click **Upload Firmware via mLink**
4. **Full power cycle**: disconnect USB-C, power off, wait 3 seconds, power back on

See [firmware/README.md](firmware/README.md) for the complete firmware reference including verified API documentation.

## Features

### Tabs

| Tab | Purpose |
|-----|---------|
| **Program** | AI chat + visual block editor + code preview |
| **Live Control** | D-pad, servo/motor port controls, voice commands, telemetry |
| **Challenges** | Guided coding challenges for kids |
| **Achievements** | Badge system and progress tracking |
| **Setup** | Hardware wizard, firmware upload, AI config, calibration |
| **Debug** | Remote REPL, motor diagnostic, live robot logs |

### AI Chat Programming
Type what you want in plain English. The AI generates block programs using the robot's hardware config context — it knows about your custom servos, motors, and their named actions.

### Visual Block Editor
27 block types across 7 categories: Movement, Sensors, Sound & Display, Control, Sensors+, Variables, Hardware. All blocks execute end-to-end on the robot.

The block palette includes a dynamic **"My Robot"** category that shows named actions from your hardware config (e.g., "Arm Servo: up", "Claw Motor: open").

### Live Control
- D-pad for drive motor control (forward, backward, turn left/right, stop)
- Generic servo S1-S4 angle controls and motor M1-M4 FWD/REV/OFF buttons
- Natural language live commands via AI
- Live telemetry dashboard

### Hardware Setup Wizard
Guided step-by-step wizard for adding servos and motors:
1. Select port (S1-S4 / M1-M4)
2. Test it live (servo angle slider, motor direction buttons)
3. Name positions ("up" at 45°, "down" at 120°)
4. Label and group into assemblies
5. Review and save

The wizard output feeds directly into AI program generation, the block palette, and live control.

### Debug Terminal
Remote MicroPython REPL — execute code directly on the robot:
- Quick command buttons (motors, sensors, LEDs, battery)
- Motor diagnostic (tests all 5 motor APIs)
- Live log streaming from the robot
- Use `rprint()` for output capture

## Project Structure

```
mbot/
├── package.json              # Root workspace config
├── .env.example              # Environment template
├── Dockerfile / compose.yml  # Docker deployment
│
├── server/                   # Backend (Node.js + Express)
│   ├── src/
│   │   ├── index.js              # Server entry + WebSocket setup
│   │   ├── services/
│   │   │   ├── ai-service.js         # AI program generation + config parsing
│   │   │   ├── mqtt-service.js       # MQTT broker bridge + hardware state tracking
│   │   │   ├── code-generator.js     # Blocks → MicroPython code + firmware bundler
│   │   │   ├── websocket.js          # WebSocket gateway (commands, REPL, diagnostics)
│   │   │   ├── mlink-bridge.js       # mLink2 JSON-RPC + F3F4 upload protocol
│   │   │   ├── telemetry-service.js  # Sensor data enrichment
│   │   │   ├── calibration-service.js# Speed/distance calibration chat
│   │   │   └── validation.js         # Input validation
│   │   └── routes/
│   │       ├── ai.js             # POST /api/ai/generate, /api/ai/chat
│   │       ├── robot.js          # POST /api/robot/command, /program, /repl, /diagnostic
│   │       └── config.js         # GET/POST /api/config, firmware upload, mLink bridge
│   └── robot-config.json        # Saved hardware configuration
│
├── web/                      # Frontend (React + Vite)
│   └── src/
│       ├── App.jsx               # Tab routing, state management
│       └── components/
│           ├── ChatPanel.jsx         # AI conversation interface
│           ├── BlocklyEditor.jsx     # Visual block editor + config-aware palette
│           ├── LiveControl.jsx       # D-pad + servo/motor controls + telemetry
│           ├── DebugTerminal.jsx     # Remote REPL + diagnostics
│           ├── HardwareWizard.jsx    # Guided hardware setup wizard
│           ├── RobotConfig.jsx       # Setup page (wizard + AI config + firmware)
│           ├── FirmwareFlasher.jsx   # mLink firmware upload UI
│           ├── CodePreview.jsx       # Python code display
│           ├── Header.jsx            # Navigation + status
│           └── StatusBar.jsx         # Connection indicator
│
├── firmware/                 # mBot2 MicroPython firmware
│   ├── main.py                   # Entry point + main loop + deferred execution
│   ├── mbot_config.py            # WiFi/MQTT/hardware constants
│   ├── mbot_mqtt.py              # MQTT client + subscriptions
│   ├── mbot_motor.py             # Motor/servo control + estop polling
│   ├── mbot_sensor.py            # Sensors via mbuild + cyberpi
│   ├── mbot_commands.py          # Command dispatch (24 types) + variables
│   ├── mbot_dashboard.py         # CyberPi screen display
│   └── test_motors.py            # Standalone motor test (recovery firmware)
│
└── docs/                     # Technical documentation
    ├── mlink-upload-notes.md     # mLink2 investigation notes (historical)
    └── upload-investigation.md   # F3F4 upload protocol specification (authoritative)
```

## MQTT Topics

| Topic | Direction | Purpose |
|-------|-----------|---------|
| `mbot-studio/robot/command` | Server → Robot | Single command (deferred to main loop) |
| `mbot-studio/robot/program` | Server → Robot | Full block program array (deferred) |
| `mbot-studio/robot/emergency` | Server → Robot | Emergency stop (sets flag only) |
| `mbot-studio/robot/repl` | Server → Robot | REPL code execution (deferred) |
| `mbot-studio/robot/config` | Server → Robot | Hardware config update |
| `mbot-studio/robot/status` | Robot → Server | Heartbeat + state (ready/running/idle) |
| `mbot-studio/robot/sensors` | Robot → Server | Periodic sensor readings |
| `mbot-studio/robot/log` | Robot → Server | Debug log messages |
| `mbot-studio/robot/repl/result` | Robot → Server | REPL execution results |

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
