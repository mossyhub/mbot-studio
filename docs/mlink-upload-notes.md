# mLink upload (how it works + what we learned)

This document is a “paper trail” of how the CyberPi firmware upload flow in this repo was made reliable using **mLink2**.

## Scope / goal

- Goal: upload the repo’s firmware Python files into the CyberPi’s `/flash/` filesystem, from the web UI, without WebSerial or native tools.
- Constraint: use **mLink2** as the local bridge (Windows), because it already knows how to talk to Makeblock devices.

## What I inspected on your machine/workspace

Most of the work was limited to the opened VS Code workspace and runtime output produced by the repo.
However, to answer “where did we learn how to talk to the device?”, we also verified the **local Makeblock tools** that provide the bridge (mLink2) and the official IDE (mBlock) on this PC.

- Repo files under the workspace root:
  - Firmware files in [firmware/](../firmware/)
  - Server-side mLink implementation in [server/src/services/mlink-bridge.js](../server/src/services/mlink-bridge.js)
  - API routes in [server/src/routes/config.js](../server/src/routes/config.js)
  - Web uploader UI in [web/src/components/FirmwareFlasher.jsx](../web/src/components/FirmwareFlasher.jsx)

### Local PC artifacts inspected (mLink2 + mBlock)

These were inspected from PowerShell on this machine.

#### mLink2 (the local JSON-RPC WebSocket bridge)

- Verified **a process listening on the default mLink2 port** `52384`:
  - Command: `Get-NetTCPConnection -LocalPort 52384 -State Listen | Select-Object -ExpandProperty OwningProcess`
  - Result: a running `mLink2.exe` PID owned the listener.

- Verified the **running binary path** and that there were multiple `mLink2` helper processes:
  - Command: `Get-Process | Where-Object { $_.ProcessName -match '(?i)mlink|mblock|makeblock' } | Select-Object ProcessName,Id,Path`
  - Result (path): `C:\Users\Public\Programs\mLink2\mLink2.exe`

- Captured **mLink2 file/version metadata**:
  - File: `C:\Users\Public\Programs\mLink2\mLink2.exe`
  - `FileVersion`: `2.1.1` (as reported by Windows file version info)

- Located the **mLink2 app data directories** (mostly generic Electron/Chromium storage logs; not protocol docs):
  - `C:\Users\lamos\AppData\Roaming\mlink2\...`

What we actually learned from mLink2 on this PC:
- The *existence* of the bridge and its *version/port*.
- The **authoritative list of supported services** came from live JSON-RPC discovery over the websocket (`rpc.discover` / `notifyConnected`), not from on-disk logs.

#### Vendor source files inspected (this is where the “working upload” details came from)

These are **unpacked JavaScript bundles shipped with mLink2** (not part of this repo). We did not copy/paste their code into this repo; we only used them to understand behavior and then validated by calling mLink2 at runtime.

- `C:\Users\Public\Programs\mLink2\resources\app\mlink-v2\worker.js`
  - Shows the JSON-RPC message shape that mLink2 expects/produces:
    - JSON-RPC version `"2.0"`
    - `method`, `params`, `id`
    - critically: the `service` field (mLink2 routes `method` by `service`)
    - callback payload type `JSON_RPC_CALLBACK`
  - Also shows the default websocket port behavior (`process.env.PORT || 52384`).

- `C:\Users\Public\Programs\mLink2\resources\app\mlink-v2\extension\data-channel\index.js`
  - Implements the `data-channel` service:
    - `list('serialport')`
    - `connect(...)` using SerialPort
    - `writeData(channelId, bytes)`
    - `close(channelId)`
  - Confirms the serial defaults used by the official bridge (including `baudRate: 115200`).

- `C:\Users\Public\Programs\mLink2\resources\app\mlink-v2\extension\realFS\index.js` and `...\extension\virtualfs\index.js`
  - Implement `realFS`/`virtualfs` services.
  - Important nuance discovered here: on this mLink2 build, these services are primarily **host-side filesystem helpers** under the user data path (not a reliable window into the CyberPi `/flash`).

What we did *not* recover from installed vendor sources:
- The exact CyberPi “offline/upload mode” raw byte packet (`0xF3 0xF6 ...`) and Halocode script-packet framing were **not found as obvious literals** in the installed mLink2 extension sources during this pass.
- That part of the uploader was validated empirically (device accepts the packet + behaves more reliably) rather than copied from a vendor file.

#### mBlock (official IDE)

- Verified the running mBlock executable and version:
  - Path: `C:\Users\Public\Programs\mblock\mBlock.exe`
  - `ProductVersion`: `5.6.0.31`

- Confirmed mBlock is packaged as an Electron app with a large `app.asar` bundle:
  - File: `C:\Users\Public\Programs\mblock\resources\app.asar`
  - Note: we did **not** unpack/decompile this bundle as part of this repo work.

What we actually learned from mBlock on this PC:
- Primarily that it’s installed and running (useful for sanity-checking COM port contention).
- We did not rely on mBlock’s internal code to implement the uploader. mBlock is packaged in `app.asar`, and we did not unpack/decompile it as part of this repo work.
- The `.mblock` file you added at repo root:
  - [(EN) Self-introduction.mblock](../(EN)%20Self-introduction.mblock)
  - We verified it is a ZIP archive and inspected its internal `project.json`/`mscratch.json` content to see if it contained a program display-name that maps to CyberPi’s “switch program” list. It didn’t.
- Temporary probe outputs produced by the VS Code tooling:
  - Some long JSON responses were written by the chat tooling into VS Code’s `workspaceStorage` temp files (these are generated artifacts of running commands/probes). They were used only to review diagnostics, not checked into git.

## High-level architecture (the final working path)

1. **Browser UI** calls our backend: `POST /api/config/mlink/upload`.
2. **Node server** connects to the local mLink2 websocket (defaults to `ws://127.0.0.1:52384/`).
3. Server uses mLink’s **`data-channel`** service to:
   - discover serial ports,
   - open a serial connection to the CyberPi (e.g. `COM4`),
   - write raw bytes to that serial channel.
4. Upload is performed by sending Makeblock/Halocode-style **script packets** over serial.
5. Those packets execute on-device and write files into `/flash/<name>.py`.
6. A soft reboot is triggered so the new firmware is used.

## mLink details that mattered

### mLink is JSON-RPC over WebSocket

- Transport: WebSocket
- Protocol: JSON-RPC 2.0
- Key quirk: requests need a `service` field (mLink routes methods by service).

Example request shape:

```json
{
  "jsonrpc": "2.0",
  "id": 123,
  "service": "data-channel",
  "method": "list",
  "params": ["serialport"]
}
```

On connect, mLink announces a set of available “channels/services” (e.g. `data-channel`, `python-terminal`, `realFS`, `virtualfs`, etc.).

Where this came from:
- This list was observed via the live websocket handshake to `ws://127.0.0.1:52384/` (mLink2 running locally), specifically the `notifyConnected` payload.

### `data-channel` is the critical service for CyberPi

The working upload path does *not* depend on `python-terminal` APIs.

We rely on:

- `data-channel.list(['serialport'])` to enumerate ports
- `data-channel.connect(id, { baudRate: 115200, connectType: 'serialport' }, onResponseCb, onDataCb, onCloseCb)`
- `data-channel.writeData(channelId, byteArray)` to send bytes to the device
- `data-channel.close(channelId)`

The key implementation is in [server/src/services/mlink-bridge.js](../server/src/services/mlink-bridge.js).

## Device-side upload protocol (what was reverse engineered)

### “Offline/upload mode” packet

Before sending script packets, we switch the CyberPi into an upload/offline state using:

- `gotoOffline = [0xf3, 0xf6, 0x03, 0x00, 0x0d, 0x00, 0x00, 0x0e, 0xf4]`

This was important for making behavior consistent across different adapters and avoiding partial writes.

### Script packets (Halocode protocol)

Uploads are done by sending packets that contain a small Python script string.

- Packet framing uses `0xF3 ... 0xF4`
- Contains:
  - a type (script)
  - a mode
  - an index (sequence)
  - the script bytes
  - a checksum

The encoder is in [server/src/services/mlink-bridge.js](../server/src/services/mlink-bridge.js) (`encodeHalocodeScriptPacket`).

### Chunked writes to `/flash/<filename>`

We write each file in chunks by sending scripts like:

- first chunk: open with `'wb'`
- subsequent chunks: open with `'ab'`

The chunk itself is base64-encoded and decoded on-device.

That logic is in [server/src/services/mlink-bridge.js](../server/src/services/mlink-bridge.js) (`buildWriteChunkScripts`).

### Reset

After uploading, we send a final script packet:

- `import machine;machine.reset()`

This makes the device reboot into the new firmware.

## What we learned (key takeaways)

- mLink2 already exposes everything needed to do uploads; we just needed to speak its JSON-RPC dialect and use `data-channel`.
- The most stable path is “**write raw serial bytes**” → “**on-device script packet**” → “**write to /flash/**”.
- CyberPi’s “exec” environment can be fragile:
  - Some scripts that include imports or filesystem access caused `SyntaxError` output or even full device reboots (Guru Meditation errors).
  - Because of that, anything exploratory should be kept extremely small and used sparingly.
- Program naming (“My program X”) appears *not* to be controlled by the `.mblock` project file content.
  - It’s likely controlled by a CyberPi-side registry/manifest that the official tooling writes, not just presence of `main.py`.
  - We started moving toward using mLink `virtualfs`/`realFS` services to enumerate and find the manifest without destabilizing the device.

## Where to look in the repo

- Upload implementation: [server/src/services/mlink-bridge.js](../server/src/services/mlink-bridge.js)
- Upload API route: [server/src/routes/config.js](../server/src/routes/config.js)
- Web UI: [web/src/components/FirmwareFlasher.jsx](../web/src/components/FirmwareFlasher.jsx)
- Firmware set: [firmware/](../firmware/)

## Known limitation / next step

- Getting the CyberPi program switcher to show a friendly name is still unresolved.
- The next likely approach is:
  1. Use mLink `virtualfs` (or other mLink service) to list files under `/flash/` safely.
  2. Identify the specific metadata/manifest file that maps slots → display names.
  3. Update that metadata as part of the upload step.
