# OTA loader and updater — commissioning release

This feature is **not installed on the robot automatically**. It does not replace Makeblock's native firmware. The legacy robot program remains unchanged until an explicit USB commissioning installation.

## What's included

- Plain trusted-LAN MQTT requests and replies, with boot/sequence IDs for stale messages and retries. No update keys, signing, or authentication.
- Bounded application transfer to an inactive file slot, whole-file SHA verification, explicit activation and explicit confirmation.
- Two validated metadata copies. A trial is marked attempted before execution so an unconfirmed trial is not blindly started again after reset.
- Cooperative resident loader and a **nonmoving diagnostic application**. The loader does not subscribe to the legacy command/program/REPL topics.
- Private bootstrap generator, operator CLI, and an explicit private-file import under Setup -> Upload Robot Software -> OTA recovery loader.

The current monolithic `firmware/main.py` is NOT a compatible cooperative OTA application. Uploading it would not migrate the robot controls. Integration of those controls is a later, separately validated change. Arbitrary candidate Python shares the interpreter: authentication is not a sandbox or independent motor safety system.

## Prepare installation files (operator/server)

Use an owner-only file outside the repository containing:

```json
{
  "wifiSsid": "YOUR_WIFI_NAME",
  "wifiPassword": "YOUR_WIFI_PASSWORD",
  "mqttBroker": "YOUR_LAN_BROKER_HOST",
  "mqttPort": 1883,
  "prefix": "mbot-studio",
  "device": "mbot2-rover"
}
```

No update key is required. Bootstrap settings and bootstrap.json still contain the WiFi password; keep them outside Git. Anyone with publish access to the OTA topics can update the application.

```
node tools/ota-bootstrap.mjs --config /private/settings.json --out /private/new-ota-kit
```

Output directory must not already exist. It contains:
- `bootstrap.json`: PRIVATE USB loader artifact including credentials.
- `operator.json`: updater configuration containing brokerUrl, prefix, and device; no OTA credentials.
- `diagnostic.py`: initial nonmoving OTA application.

On a laptop with USB and mLink, select `bootstrap.json` in the explicit OTA commissioning section, confirm that the robot is secured, then choose Install. This replaces the normal robot application. A USB transfer acknowledgement is not a boot/OTA success indication. Verify through the server-side updater. Do not use the ordinary motor-test button as recovery without understanding that it runs movement tests.

## Operator update loop

```
node tools/ota-update.mjs --config /private/new-ota-kit/operator.json status
node tools/ota-update.mjs --config /private/new-ota-kit/operator.json upload /private/new-ota-kit/diagnostic.py
node tools/ota-update.mjs --config /private/new-ota-kit/operator.json activate DIGEST_FROM_UPLOAD
node tools/ota-update.mjs --config /private/new-ota-kit/operator.json confirm DIGEST_FROM_UPLOAD
node tools/ota-update.mjs --config /private/new-ota-kit/operator.json rollback
```

Upload stages only. Activate restarts and verifies the new boot/trial. Confirm is a distinct operation after health and desired tests. Rollback abandons an unconfirmed trial and restarts the last confirmed application (or empty recovery if none exists). It is **not** a historical version manager: after confirmation, a future staged upload may overwrite the older inactive slot.

A CLI failure means outcome unverified; query live status before retrying. A disconnected operator must reconnect with a new client; do not reset device sequences or assume an old retained status is current. Keep only one updater active for a device. OTA topics are `<prefix>/ota/<device>/{request,response,hello}`.

## Test evidence and limits

`npm run test:unit` runs Node tests and Python OTA tests via a wrapper; Python 3 is a dev prerequisite. The cross-language test uses the actual Python core and application loader with a local broker and temporary files. Its restart is a new Python engine instance, NOT a hardware reset. Firmware runtime tests inject transport/watchdog adapters; they establish control flow, not vendor SDK scheduling or actuator behaviour.

`npm run test:local` tests the actual web UI against the isolated offline-AI harness. The commissioning UI test verifies file digest checks, consent gating and canceled installation; it never flashes a device.

Before first installation, review all warnings in `ota-commissioning.md`. Still needed on actual hardware: bootstrap startup, connection time under watchdog, complete app memory use, trial confirmation and failed-candidate recovery, interrupted update/restart handling, and another successful update. Normal filesystem redundancy is not proof of durability during physical power loss. A watchdog reset is not proof motors lost power. A corrupt loader/filesystem/vendor runtime may require USB recovery.
