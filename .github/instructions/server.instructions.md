---
applyTo: "server/**"
description: "Node.js Express backend conventions: ES modules, route/service structure, validation, MQTT/WebSocket patterns, AI service adaptive compatibility, singleton services."
---

# Server (Node.js) Instructions

## Module system
- ES modules only (`import`/`export`). No `require()`.
- `"type": "module"` in `server/package.json`.

## Structure
- Routes in `server/src/routes/` — thin handlers that validate input, call services, return JSON.
- Services in `server/src/services/` — business logic, singletons, external integrations.
- Entry point: `server/src/index.js`.

## Validation
- Always validate at route boundaries using helpers from `validation.js`.
- `validateMessage()`, `validateBlocks()`, `validateCommand()`, `getSessionId()`.
- Return `{ ok, error, value }` pattern — check `ok` before proceeding.

## Singletons
- `MqttService.getInstance()` and `TelemetryService.getInstance()` — never construct directly.
- `SessionStore` is instantiated per-route file (not singleton).

## AI service
- Uses OpenAI-compatible client. Supports direct OpenAI, Azure OpenAI, or any compatible endpoint (`AI_BASE_URL`).
- Adaptive parameter pruning: records unsupported params per model, removes them on retry.
- Local debug mode (`AI_LOCAL_DEBUG=true`) returns deterministic programs without API calls.
- Model set via `AI_MODEL` env var (default: `gpt-4o`). No catalog auto-discovery.

## MQTT
- All topics under `mbot-studio/robot/*` prefix.
- QoS 0 (fire-and-forget). Commands are JSON objects.
- Hardware state tracking is server-side (robot has no feedback for DC motors/servos).

## WebSocket
- Single path: `/ws`. Bridges MQTT messages to browser clients.
- Message types: `command`, `emergency_stop`, `repl`, `diagnostic`.
- Broadcast pattern: all connected clients receive all MQTT-bridged data.

## Error handling
- Routes catch errors and return `{ error: message }` with appropriate HTTP status.
- Services log with `console.error`/`console.warn` and throw or return error objects.
- Never expose stack traces to clients.

## Config
- `robot-config.json` at project root (or `DATA_DIR` env var in Docker).
- `.env` loaded from project root: `dotenv.config({ path: '../../.env' })`.
- Firmware bundling: `bundleFirmwareFiles()` in `config.js` merges all firmware modules into single `main.py`.
