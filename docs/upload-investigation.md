# CyberPi Upload Investigation — Running Notes

## Problem Statement
User reports: "I don't think the program upload stuff is actually working."
- CyberPi shows no reboot after upload
- "Switch Program" menu shows blank Program1–Program8
- FirmwareFlasher UI shows false "✅ mLink upload complete. Robot is rebooting."

## Environment
- **mLink2 v2.1.1** at `ws://127.0.0.1:52384/` — WebSocket JSON-RPC bridge
- **CyberPi** on COM4, CH340 USB-serial (VID 1A86, PID 7523)
- **Firmware**: MicroPython 44.01.008-13-g6cc07873-dirty (Sep 21 2022), ESP32
- **System firmware**: 44.01.011
- **Node.js** v22.21.0, server on port 3001

---

## Root Causes Identified

### Root Cause 1: Semicolons as statement separators
`buildWriteChunkScripts()` in mlink-bridge.js joins Python statements with `.join(';')`.
CyberPi's script packet execution **rejects semicolons** — produces `SyntaxError`.
```
a=1;print(a)  →  SyntaxError
```
**Fix**: Use `exec()` wrapper with `\n`-separated lines, or newlines directly.

### Root Cause 2: File I/O crashes ESP32
ANY file I/O operation via script packets causes an ESP32 kernel panic:
```
Guru Meditation Error: Core 1 panic'ed (Cache disabled but cached memory region accessed)
PC: 0x4008723e
```
The script packet execution handler runs in a context where **SPI flash cache is disabled at the hardware level**. This is a firmware-level issue — the Makeblock firmware disables flash cache during script execution.

This affects ALL execution contexts tested:
- Direct `open()` / `f.write()` / `f.close()`
- `exec()` wrapper
- `_thread` (new thread also crashes)
- `micropython.schedule()` (also crashes)
- `machine.Timer` callback during script execution (100ms delay → crashes)
- `machine.Timer` with 2s delay → no crash but no output captured (fires after handler returns)
- `machine.Timer` callback → FreeRTOS assertion failure (`vTaskNotifyGiveFromISR`)
- `cyberpi.config.write_config()` → same cache crash
- `uos.listdir()` → same cache crash

**Conclusion**: There is NO way to write to flash from within script packet execution context.

### Root Cause 3: Reset command uses semicolons too
`import machine;machine.reset()` → SyntaxError
**Fix**: `exec('import machine\nmachine.reset()')`

---

## What Works

- `print('hello')` via script packets → works perfectly
- `exec('import X\nprint(X.something)')` → works for non-flash operations
- Multi-line code via `exec()` with `\n` → works
- Reading module attributes / calling methods that don't touch flash → works
- Device survives crashes and comes back after reboot (~5-8 seconds)

---

## Approaches Tested and Exhausted

### 1. Fix semicolons → use exec() wrapper ❌
Fixes syntax but doesn't fix flash access crash.

### 2. _thread module ❌
```python
import _thread
_thread.start_new_thread(write_file, ())
```
Thread also runs with cache disabled → same crash.

### 3. micropython.schedule() ❌
Same crash. Scheduled callback runs in same context.

### 4. machine.Timer with delay ❌
- 100ms → crash (fires during handler execution)
- 2000ms → no crash, no output (timer fires after handler returns, output missed)
- 3000ms ONE_SHOT → FreeRTOS assertion failure on callback

### 5. REPL access ❌
After `machine.reset()` + Ctrl+C spam (10 seconds):
- MicroPython `>>>` prompt IS visible in output
- BUT typed commands produce NO response
- Device's protocol handler intercepts serial INPUT while allowing OUTPUT
- REPL is effectively output-only

### 6. Different packet modes (0x00-0x05) ❌
- Modes 0-4: all execute script immediately, modes 1-4 also return `{"ret":None}` response
- Mode 5: executes but no response packet
- No mode "saves to program slot without executing"

### 7. Different packet types ❌
- Type 0x28 = script execution (the one we use)
- Type 0x03 = "common protocol" (tries to parse JSON)
- Type 0x0e = silent
- Type 0x50 = returns status bytes
- None provide file transfer

### 8. mLink services (virtualFS, realFS, etc.) ❌
ALL mLink2 services are local PC operations only:
- `virtualFS` → reads/writes files on host PC
- `realFS` → reads/writes files on host PC
- `systemCore` → manages host PC processes
- `python-terminal` → local Python via node-pty
- `executor` → empty stub
- `data-channel` → raw serial port wrapper (the one we use)

---

## Key Discoveries

### CyberPi config system (from `cyberpi.config.current_config`)
```python
{
  'run_file_name': 'main1.py',
  'run_script_idx': 1,
  'run_script_type': 1,       # 1 = user script
  'gui_mode': 1,
  'user_script1': 'Program1',  # Display names for Switch Program menu
  'user_script2': 'Program2',
  ...
  'user_script8': 'Program8',
  'fact_script1': 'Voice-reactive Lights',
  ...
  'fact_script8': 'mBot2_joystick control',
  'board_name': 'cyberpi',
  'config_ver': 2,
  'repl_enable': 0,
  'wifi_launch': 1,
  'espnow_channel': 6,
}
```

Key insight: The device runs `main1.py` (slot 1). Program names are in `user_script1-8`.

### Firmware modules found
```python
# Critical modules for file transfer
'common_protocol.common_user_trans_file'  # "user transfer file" protocol!
'system.script_manager'                    # manages scripts/slots
'project_operation'                        # has restart + xx_xx functions

# common_user_trans_file methods:
['get', 'set', 'get_info', 'on_upload_mode_message_come', 'broadcast',
 'build_message_frame', 'get_info_status',
 'upload_mode_message_value_dict', 'UPLOAD_MODE_MESSAGE_PROTOCOL_ID']

# script_manager methods:
['get_current_exe_type', 'get_current_exe_id', 'set_current_exe_id',
 'set_current_exe_type', 'set_script_name', 'get_script_name',
 'reset_script', 'get_current_exe_script', 'set_run_file',
 'get_factory_script_name',
 'TYPE_USER_SCRIPT', 'TYPE_FACTORY_SCRIPT', 'SCRIPT_NUMBER_MAX',
 'WRITE_BUFFER_LEN_MAX', 'SERVER_ID', 'SEND_HEADER', 'SEND_BODY',
 'RESPOND_CMD', 'STATE_OK', 'STATE_ERR']

# cyberpi.makeblock methods of interest:
['set_temporary_script', 'get_temporary_script',
 'set_mp_mode', 'get_mp_mode',
 'set_system_mode', 'get_system_mode',
 'MP_MODE_USER_SCRIPT', 'MP_MODE_FACTORY_SCRIPT',
 'MP_MODE_ONLINE_SCRIPT', 'MP_MODE_EMPTY_LOOP_SCRIPT',
 'SYSTEM_MODE_OFFLINE', 'SYSTEM_MODE_ONLINE',
 'SYSTEM_MODE_UPDATE_FIRMWARE']
```

### Key question: Does `set_temporary_script` write to flash?
It's a C-level function (not Python), so it might properly handle cache enabling.
Need to test this.

### Key question: Does `common_user_trans_file` implement a binary file transfer protocol?
The presence of `UPLOAD_MODE_MESSAGE_PROTOCOL_ID`, `build_message_frame`, `SEND_HEADER`, `SEND_BODY`, `RESPOND_CMD` suggests this module handles file transfer at the protocol level (type 0x03 = "common protocol" in our packet type tests → "parse common protocol").

The "common protocol" (packet type 0x03) expects JSON input. This could be the file transfer channel!

---

## Resolution: F3F4 Binary File Transfer Protocol

### Discovery Path
The firmware module names (`common_user_trans_file`, `script_manager`) hinted at a binary
protocol separate from Python script execution. By unpacking mBlock5's `app.asar` and extracting
the CyberPi extension source from `exts.zip`, we found the complete upload implementation in the
webpack bundle `4465.98e979c7.js`.

Key functions found:
- `bytes2Protocol()` — F3F4 frame encoder
- `doUpload()` in CyberPi extension — orchestrates file transfer with mode switching
- Path logic: firmware >=44.01.006 uses `/flash/_xx_<projectName>.py` instead of `/flash/main.py`
- Mode commands: `[0x0d, 0x00, 0x00]` = offline/upload, `[0x0d, 0x00, 0x01]` = debug/online

### Protocol Specification

**F3F4 Frame Format:**
```
[0xF3, sumByte, lenLo, lenHi, ...payload, checksum, 0xF4]
  sumByte  = (0xF3 + lenLo + lenHi) & 0xFF
  checksum = sum(payload) & 0xFF
  len      = payload.length (16-bit LE)
```

**File Transfer Sub-protocol (0x5E):**

Header packet (subcmd 0x01):
```
[1, 0x00, 0x5E, 0x01, lenLo, lenHi, 1, ...dataLen(4bytes LE), ...xorHash4(data), ...pathUTF8bytes]
```

Body packet (subcmd 0x02):
```
[1, 0x00, 0x5E, 0x02, lenLo, lenHi, ...offset(4bytes LE), ...chunkData]
```

ACK response (subcmd 0xF0):
```
[1, 0x00, 0x5E, 0xF0, 0x01, statusByte, 0x00]
  status: 0 = success, 1 = firmware error, 240 (0xF0) = encoding error
```

- Block length: 80 bytes per body chunk
- Each packet (header + every body chunk) gets its own ACK
- `xorHash4` = 4-byte XOR hash over data padded to multiple of 4

**Mode Switch Commands** (wrapped in F3F4):
```
Offline/upload mode: [0x0d, 0x00, 0x00]
Debug/online mode:   [0x0d, 0x00, 0x01]
Get current mode:    [0x0d, 0x80]
```

**Path Convention (firmware >=44.01.006):**
- Main program: `/flash/_xx_<name>.py` — registers as user program slot 1
- Helper modules: `/flash/<name>.py` — accessible via `import`

### Upload Sequence
```
1. Switch to offline mode: wrapF3F4([0x0d, 0x00, 0x00])
2. For each file:
   a. Send header packet → wait for ACK (status=0)
   b. Send body chunks (≤80 bytes each) → wait for ACK per chunk
3. Switch to offline mode again → triggers auto-run of uploaded program
```

**Device responses during upload:**
- `[0x0d, 0x00, 0x00]` — mode switch acknowledgment
- `[0x08, 0xC0]` — script_write_ready signal
- `[1, 0x00, 0x5E, 0xF0, 0x01, 0x00, 0x00]` — file transfer ACK (success)

### CyberPi Config After Successful Upload
```python
{
  'user_script1': '_xx_main',    # Slot 1 named after uploaded file (was 'Program1')
  'run_script_type': 2,          # Was 1
  'gui_mode': 0,                 # Was 1 — device now in offline/program mode
}
```

### Test Results
- `test-file-transfer.mjs`: Binary upload to `/flash/main.py` → "UPLOAD OK!" on CyberPi screen
- `test-full-upload.mjs`: Full sequence with `_xx_` path + mode switching → all 8 packets ACK'd,
  config updated with `user_script1: '_xx_main'`
- End-to-end API test (`POST /api/config/mlink/upload`) → `"ok": true`, device output `PYB: fast reboot`

### Code Changes
- **`server/src/services/mlink-bridge.js`**: Replaced broken `buildWriteChunkScripts()` +
  `uploadFilesToCyberpiFlash()` + `uploadViaMlink()` with F3F4 binary protocol implementation.
  New functions: `wrapF3F4()`, `buildFileTransferHeader()`, `buildFileTransferBody()`,
  `fileToProtocolPackets()`, `parseF3F4Frames()`, `parseFileTransferAck()`
  `uploadViaMlink()` now uses `openDataChannelSerialStreaming` (vs non-streaming) to read ACK responses.
- **`web/src/components/FirmwareFlasher.jsx`**: Updated success message.
- Removed dead code: `buildWriteAttempts()`, `listFlashDirectories()`, `buildEnsureDirScript()`

---

## Session Log

### Test scripts created
All in `d:\personal\mbot\server\`:
- `cyexec.mjs` — Quick CyberPi script execution helper
- `test-repl-v1.mjs` through `test-repl-v9.mjs` — Progressive protocol tests
- `test-timer-write.mjs` — Timer-delayed file write test
- `test-config-explore.mjs` — Config module exploration
- `test-deep-explore.mjs` — Deep firmware module exploration
- `test-protocol-details.mjs` — Protocol constants extraction
- `test-config-write.mjs` — Config write test (crashed)

### Crashes observed
Every flash-touching operation produces the same crash signature:
```
Guru Meditation Error: Core 1 panic'ed (Cache disabled but cached memory region accessed)
PC: 0x4008723e
Backtrace: 0x4008723e:0x3ffb9ee0 0x40084395:0x3ffb9f00 0x40095e92:0x3ffb9f20
```
After crash, device reboots in ~5-8 seconds and is responsive again.
