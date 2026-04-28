---
applyTo: "server/src/services/mlink-bridge.js"
description: "mLink bridge for CyberPi firmware upload: F3F4 binary protocol, JSON-RPC over WebSocket, serial data channels, file transfer to device flash."
---

# mLink Bridge Instructions

## Purpose
Communicates with CyberPi microcontroller via Makeblock mLink2 desktop app (localhost WebSocket on port 52384).

## Protocol stack
- **Transport**: WebSocket to `ws://127.0.0.1:{port}/serials/` or `/`.
- **RPC**: JSON-RPC 2.0 for service/method calls.
- **File transfer**: F3F4 binary framing (header 0xF3, length, payload, checksum, footer 0xF4).
- **Integrity**: `xorHash4()` — 4-byte rolling XOR over file content.

## Upload flow
1. `discoverMlink()` — Check if mLink is running.
2. `listMlinkSerialPorts()` — Find available COM ports.
3. `uploadViaMlink({ files, port, serialPort, slot })` — Open session, transfer files, close.

## Key constraints
- mLink is localhost-only (127.0.0.1) — no remote uploads.
- File paths are sanitized via `sanitizeFlashRelativePath()`.
- Serial data channels use ACK-based flow control.
- Upload targets a "slot" (program index) on the CyberPi.

## Diagnostics
- `probeMlinkServices()` — Test available RPC services.
- `diagnoseCyberpiPrograms()` — List programs on device.
- `execCyberpiSnippet()` — Run arbitrary Python on device.
- `probeVirtualFs()` / `virtualFsListDir()` — Explore device filesystem.
