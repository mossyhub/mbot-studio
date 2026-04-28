# mBot Studio — Copilot Project Instructions

## Project Overview

mBot Studio is an AI-powered robot programming platform for kids (ages 6–12). Children describe what they want the robot to do in natural language, the AI generates visual code blocks, and the program is sent to a Makeblock mBot2 rover over MQTT.

## Architecture

```
Web (React/Vite)  ──HTTP/WS──▶  Server (Node.js/Express)  ──MQTT──▶  mBot2 (MicroPython)
     :5173                              :3001                        CyberPi ESP32
```

### Three components, three languages

| Component | Path | Language | Runtime |
|-----------|------|----------|---------|
| Frontend | `web/` | React JSX, CSS | Vite dev server / static build |
| Backend | `server/` | Node.js ES modules | Express + WS + MQTT client |
| Firmware | `firmware/` | MicroPython | CyberPi (ESP32, mBot2 board) |

### Data flow

1. User types a natural-language request in the chat panel.
2. Frontend sends `POST /api/ai/generate` with the message + current blocks.
3. Server calls OpenAI-compatible API → gets JSON block program.
4. Server converts blocks to MicroPython via `code-generator.js`.
5. Frontend displays blocks in the visual editor; user clicks Run.
6. `POST /api/robot/program` → server sends blocks via MQTT to robot.
7. Firmware dispatches commands (motors, sensors, display, sound).
8. Robot publishes sensor telemetry back via MQTT → WebSocket → frontend.

### Communication protocols

- **HTTP REST**: AI generation, config, robot commands, firmware upload orchestration
- **WebSocket** (`/ws`): Live control, telemetry streaming, REPL, emergency stop
- **MQTT**: Robot ↔ server bridge. Topics under `mbot-studio/robot/*`
- **mLink**: Local WebSocket (port 52384) to Makeblock mLink2 for USB firmware flashing

## Key conventions

### Server (Node.js)

- ES modules throughout (`"type": "module"` in package.json).
- Express routes in `server/src/routes/`, services in `server/src/services/`.
- Singleton pattern for `MqttService` and `TelemetryService` (`getInstance()`).
- AI model compatibility is adaptive: tracks unsupported params per model, prunes before retry.
- Supports OpenAI, Azure OpenAI, or any OpenAI-compatible endpoint (via `AI_BASE_URL`).
- Config lives in `robot-config.json` at project root (or `DATA_DIR` in Docker).
- `.env` is loaded from project root via `dotenv.config({ path: '../../.env' })`.
- Validation helpers in `validation.js` — always validate at route boundaries.

### Frontend (React)

- Functional components with hooks only. No class components.
- State lives in `App.jsx` and is passed down as props. No Redux/Zustand.
- CSS Modules pattern: each component has a paired `.css` file.
- WebSocket management is per-component (`LiveControl`, `DebugTerminal`, `TelemetryPanel` each own a connection or share a ref).
- Profiles and projects persist in `localStorage`.
- Achievements are client-side only (`localStorage`), scoped per profile.
- Sound effects are generated via Web Audio API (no audio files).

### Firmware (MicroPython)

- All firmware modules are bundled into a single `main.py` before upload (CyberPi cannot reliably import custom modules from `/flash/`).
- Bundling is done server-side in `config.js` → `bundleFirmwareFiles()`.
- Modules: `mbot_config` (constants), `mbot_dashboard` (display), `mbot_sensor` (sensor abstraction), `mbot_motor` (motor control), `mbot_mqtt` (MQTT connection), `mbot_commands` (command dispatch), `main` (entry point/event loop).
- Emergency stop: `_estop` flag checked every 50ms during motor operations.
- Sensor reads use `mbuild` (mBot2 add-on board) and `cyberpi` (built-in) libraries.
- Hardware additions (extra servos, DC motors) are on the starter_shield via ports S1–S4, M1–M4.

## MQTT topic structure

| Topic | Direction | Purpose |
|-------|-----------|---------|
| `mbot-studio/robot/command` | Server → Robot | Single command (JSON) |
| `mbot-studio/robot/program` | Server → Robot | Full program (JSON array) |
| `mbot-studio/robot/emergency` | Server → Robot | Emergency stop signal |
| `mbot-studio/robot/repl` | Server → Robot | Python code for REPL execution |
| `mbot-studio/robot/status` | Robot → Server | Status updates (ready/running/idle) |
| `mbot-studio/robot/sensors` | Robot → Server | Sensor telemetry (JSON) |
| `mbot-studio/robot/log` | Robot → Server | Debug log messages |
| `mbot-studio/robot/repl/result` | Robot → Server | REPL execution results |

## Block program format

Blocks are JSON objects with a `type` field. Examples:

```json
{ "type": "move_forward", "speed": 50, "duration": 1.5 }
{ "type": "turn_right", "speed": 40, "angle": 90 }
{ "type": "repeat", "times": 4, "do": [ ... ] }
{ "type": "if_obstacle", "threshold": 15, "then": [ ... ], "else": [ ... ] }
{ "type": "servo", "port": "S1", "angle": 90 }
{ "type": "dc_motor", "port": "M1", "speed": 70, "duration": 2 }
```

## Hardware state tracking

DC motors and servos on the starter_shield are stateless — the server tracks assumed positions via `MqttService.setHardwareState()`. The AI receives these assumed states in its system prompt so it can generate appropriate home/reset actions.

## Performance priorities

1. AI response latency: Keep prompt construction lean; use `max_completion_tokens` to bound responses.
2. MQTT command delivery: QoS 0 currently; consider QoS 1 for critical commands.
3. Emergency stop: Must propagate within 50ms polling window on firmware side.
4. WebSocket broadcast: All connected clients receive all MQTT-bridged data.

## Security notes

- `AI_API_KEY` is the only secret; lives in `.env`, never committed.
- No authentication on HTTP/WS endpoints (local-network-only design for home use).
- REPL endpoint executes arbitrary Python on the robot — by design for the debug terminal.
- Firmware upload via mLink is localhost-only (127.0.0.1:52384).
- WiFi credentials are embedded in firmware config at upload time.

## Testing

- No automated test suite yet. `firmware/test_motors.py` is a standalone manual motor test.
- AI local debug mode (`AI_LOCAL_DEBUG=true`) returns deterministic block programs without hitting the API.

## Build & run

```bash
npm install          # installs root + server + web workspaces
npm run dev          # starts server (:3001) + Vite (:5173) via concurrently
npm run build        # builds web frontend for production
npm start            # runs server with pre-built frontend
```

## Docker

```bash
docker compose up --build   # builds + runs on :3001
```

The Docker image is a two-stage build: frontend build → production Node.js image serving static files + API.
