# OTA commissioning: actual CyberPi evidence

## Current design revision: trusted LAN

The owner explicitly chose no OTA authentication/signing/key provisioning for this hobby project. The current implementation follows that decision; `ota-protocol-v1.md` is the current contract. Earlier authenticated-prototype design notes below are historical and are superseded where they mention authentication. Checksums, transfer IDs, bounded writes and rollback remain for reliability.

The first core's hand-written JSON scanner completed on the actual robot but was far too slow: 16,376 ms for a small metadata-like object. The replacement uses native JSON parsing. The same-shaped object parsed correctly on the real CyberPi in **46 ms** (`lan-device-parser.jsonl`). These are individual observed samples, not guaranteed latency bounds. No startup files were changed by this parser check.

## Scope

On-device commissioning through the existing mBot Studio HTTP REPL -> MQTT -> firmware main-loop execution path. The user explicitly secured the robot and authorized reset/watchdog tests. No motor commands, startup-file replacement, loader installation, vendor firmware flash, or movement test was performed.

Base source: 1f8746d77481ea412eb2bea46b8d04c88a691c56. The installed Python application does not yet expose an immutable build ID, so this source identity must not be presented as an attestation of the running robot application.

Evidence is in `/hermes_work/mbot-ota-evidence/` on the commissioning server. Raw JSONL contains device-originated MQTT responses, not simulator output. Harmless probe files were individually named, collision-checked, and deleted. Existing runtime globals were used by the firmware's diagnostic REPL; no claim of process isolation is made.

## Results

| Capability | Actual result | Evidence |
|---|---|---|
| Runtime identity | MicroPython 1.11.0 | capabilities.jsonl |
| Available heap | 1,245,264 bytes at initial check | capabilities.jsonl |
| Filesystem capacity | statvfs fragment size 4096; available fragments 509 = 2,084,864 bytes at check | file-probe.jsonl, sizing.json |
| Normal main-loop flash I/O | Write/close/read exact bytes, rename, stat, remove succeeded | file-probe.jsonl |
| SHA-256 | Device and host digests agree on identical file bytes | file-probe.jsonl, sizing.json |
| Wi-Fi bundle loading | 65,536 bytes transferred in 8,192-byte chunks; reopened, SHA verified, exec in a new namespace; newly defined harmless function returned expected unique challenge | OTA_BUNDLE_*.jsonl, bundle-verification.json |
| Garbage collection | 1,252,176 free heap bytes after bundle test | OTA_BUNDLE_EXEC.jsonl |
| Software reset | machine.reset interrupted request; device reconnected without USB; uptime restarted | reset-probe.jsonl, reset-verify.jsonl |
| Persistence across reset | Exact marker bytes read after reset, then removed | reset-verify.jsonl |
| Watchdog construction | machine.WDT(timeout=8000) accepted | watchdog-probe.jsonl |
| Watchdog control | Unarmed time.sleep(12) completed and returned a correlated success | wait-control.jsonl |
| Watchdog intervention | Armed wait did not reach fallback; device restarted/reconnected; persistent checkpoint proves software fallback was not reached | watchdog-checkpoint.jsonl, watchdog-checkpoint-verify.jsonl |

The 64 KiB bundle contains a tiny function and comment padding. It proves transfer/file/loading size handling, NOT memory capacity for 64 KiB of complex compiled application logic. The current seven raw application source files total 49,573 bytes; full application loading still needs separate verification.

## Crucial distinctions

- The historical USB serial script-packet file-I/O panic does not apply to the tested main-loop REPL path. Do not generalize that old failure into a ban on normal application filesystem access.
- The device reports reset_cause=5, equal to its SOFT_RESET constant, even after the watchdog-controlled trial; WDT_RESET is 3. Do not classify recovery using that value alone. Persisted trial records, uptime and correlated startup identity are required.
- Deliberate reset interrupts REPL completion. HTTP sent=true and a missing response are not success. Success was established by a subsequent device request, restarted uptime, and persisted marker readback.
- The watchdog trial tests a blocked, unserviced sleep, not all possible interpreter/native deadlocks, flash failures, networking hangs, or malicious candidate code. Candidate code must not own watchdog feeding; same-process code cannot be fully isolated.
- Hardware restart/reconnection was observed; actuator power removal and physical stop deadlines were not measured.
- File rename worked normally. Atomicity and durability through power loss, torn metadata writes and a full filesystem remain untested.
- All probe data files were cleaned up. No new executable application is selected for boot.

## Architecture selected by these results

Persistent application OTA is feasible; RAM-only delivery is not required as the primary path. Retain the Makeblock runtime and its boot conventions. Use a small resident recovery loader plus two versioned application data slots; these are files, not native ESP32 OTA partitions.

1. Keep the resident loader, provisioning credentials and recovery configuration separate from candidate files. Do not overwrite the loader during ordinary updates.
2. Transfer to an inactive slot with an authenticated manifest, transfer ID, bounded offsets/chunks, size limits and digest verification. A digest alone does not authenticate code.
3. Preserve the confirmed slot and use redundant validated metadata records; do not assume rename alone is power-fail safe.
4. Activate only while disarmed. Persist a trial record before restarting. Loader enters recovery if the candidate failed or a trial is unconfirmed; no automatic movement on boot.
5. A trial must report boot ID, application digest/build ID, loader version and compatible protocol. Require a health/communication handshake before explicit confirmation.
6. Feed a verified watchdog only after healthy servicing, not from an unconditional timer. Check candidate networking operations against the watchdog budget.
7. Read errors back, retain independent camera evidence, reject stale movement messages, and require an explicit new arm after boot/update/stop.
8. Keep USB recovery available for loader/filesystem/vendor faults. No claim that USB will never be needed.

## Remaining installation gate

Implement and software-test the loader/protocol and negative cases first. Then obtain authorization for the first startup-file replacement, with USB recovery available. The reset-test authorization specifically excluded startup-file replacement. Do not silently install the loader through diagnostic exec.

Acceptance on device: provision -> authenticated A transfer -> boot A -> authenticated B transfer -> boot B -> malformed/truncated/replayed update rejection -> deliberately failed trial -> recovery/rollback -> successful next update. Test the actual current application, not only comment-padded probes. Preserve cameras and do not start autonomous movement as part of OTA acceptance.
