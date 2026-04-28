---
applyTo: "web/**"
description: "React frontend conventions: functional components, props-based state, CSS modules, WebSocket patterns, localStorage persistence, Web Audio sound effects, achievement system."
---

# Frontend (React) Instructions

## Components
- Functional components with hooks only. No class components.
- Each component has a paired `.css` file (CSS Modules pattern).
- State lives in `App.jsx` and is passed down as props. No Redux/Zustand/Context.

## State management
- `App.jsx` is the single source of truth for: `blocks`, `pythonCode`, `messages`, `robotStatus`, `profiles`, `currentProfileId`.
- Child components receive state and callbacks via props.
- `blockHistory` and `historyIndex` refs for undo/redo.

## Persistence
- Profiles and projects saved to `localStorage`.
- Achievements are client-side only (`localStorage`), scoped per profile via `achievements.js`.
- No backend persistence for user data.

## WebSocket
- Components manage their own WS connections (`LiveControl`, `DebugTerminal`, `TelemetryPanel`).
- Auto-reconnect with exponential backoff.
- Protocol: `wss://` for HTTPS, `ws://` for HTTP, auto-detected.
- Message format: `{ type: string, ...payload }`.

## API calls
- All API calls use `fetch()` to `/api/*` endpoints (proxied by Vite in dev).
- Robot status polled every 5 seconds.
- AI generation via `POST /api/ai/generate`.

## Sound
- Web Audio API oscillator-based sound effects (`sound-service.js`).
- No external audio files. Mute state persisted in `localStorage`.

## Block editor
- Custom visual editor (not Blockly library despite the name).
- 40+ block types with parameter schemas (ranges, selects, text).
- Drag-to-reorder, block palette with categories.
- Templates are static JSON arrays.

## Achievements
- 40 badges across 6 categories.
- `checkProgramAchievements(blocks)` analyzes block composition.
- Time-based achievements (night owl, early bird).
- Client-side only — no backend verification.
