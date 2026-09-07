# Live OTA acceptance — passed on CyberPi

## Actual device results

Following the user's corrected USB bootstrap installation and reported `OTA: mqtt_connected`, the host queried live OTA status successfully. All following operations used MQTT/Wi-Fi, not USB transfer. No movement commands or native Makeblock firmware replacement were performed.

1. Uploaded nonmoving diagnostic v1 (1093 bytes), digest `e5f39b54ec88f2d90bbc4ccee7e001cad9a429e2b817d0dd6edbc34d0e4d1762` into slot a.
2. Activated it; host observed a new boot with matching selected/candidate/trial digest and healthy=true. Explicitly confirmed it.
3. Uploaded a deliberately failing candidate whose `ota_init` raises RuntimeError (no hardware calls). Activated it. Device returned on a new boot with the prior confirmed v1 selected, healthy=true, trial cleared.
4. Uploaded diagnostic v2 (same cooperative app with updated build label), digest `116817e347daac4e8c47dc3fb20a774decf47e8b4445b6d86ca18026f5758837` into slot b. Activated, observed healthy exact digest, confirmed.
5. Requested another restart through rollback operation (no pending trial). Device returned with confirmed v2 still selected and healthy.
6. Staged incomplete transfer; finish returned `incomplete`. Aborted it.
7. Staged full bytes with incorrect expected digest; finish returned `digest`. Aborted it.
8. Readback: confirmed/selected v2 unchanged, healthy=true, candidate/trial/receiving all null.

Evidence: `/hermes_work/mbot-ota-evidence/live-acceptance.json`, `live-upload-a.json`, `live-activate-a.json`, `live-confirm-a.json`, `live-transfer-rejections.json`. Timestamps and distinct boot IDs are recorded. These are device replies, not the software peer fixture.

## Limits and observation

A later fresh-client status connection timed out waiting for hello once. A passive 65-second observation then received 12 healthy hellos under the same boot ID, and a subsequent fresh client completed both transfer rejection tests. Do not call network reliability exhaustively proven or infer a device reset from this timeout. Its cause is unclassified.

The serial attachment decoded into 396 valid successful binary file-transfer ACKs plus startup protocol frames. It did not contain textual OTA stage diagnostics; current operation is proved by fresh host requests and subsequent exact-version boots, not the absence of a traceback.

The bootstrap source now invokes main unconditionally, unlike the first installed guard-based loader. A successful replacement establishes this build starts, but the first failure's precise cause was not independently isolated from all other startup changes.

## Current state

Robot runs the confirmed NONMOVING diagnostic v2, not the previous driving application. Normal app UI may still show its legacy robot status offline because this loader uses separate `/ota/mbot2-rover/*` topics and does not publish legacy `/robot/status`. Do not flash ordinary firmware to fix that indicator; doing so replaces the loader.

Next implementation boundary is migrating real command execution/telemetry into the cooperative OTA application, and exposing OTA status in the application UI. No motor/servo motion, physical-stop deadline, power-cut durability, or arbitrary native-hang recovery is certified by these tests. The original startup backups remain available.
