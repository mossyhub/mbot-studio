# Motor control over application OTA

## Current application

**Source is not proof of the installed feature set.** The published baseline described below is the motor/sensor app. Subsequent bench work confirmed a bounded native-turn candidate (`864b9ab86452bc913009484b18419e895980d5b62e13a9aeb69e49bfeccd959c`); local sound/animation work remains host-tested but device-unverified. Query a fresh device capability status before issuing commands. Do not flash the current working tree just because it builds. See [bench learning](bench-learning.md) for physical observations and their limits.

Use `firmware/robot_control.py`, built with `tools/build-robot-control.py`. This is the small motor-capable application. The larger `robot_engine.py` / `robot_app.py` experiment is **not the installed motor runtime**; its builder explicitly disables motion.

The resident OTA loader is unchanged. These updates replace a Python application file, not Makeblock/ESP32 vendor firmware. The loader brings up Wi-Fi; the application waits for Wi-Fi before opening its own MQTT client. It does not start motion, home the arm, or execute a saved program on startup.

This is the owner's trusted-LAN design: no added authentication, signing keys, or remote REPL. Anyone able to publish commands to the broker can control the robot. Checksums, trial selection, confirmation, and rollback protect update reliability, not against a hostile publisher.

## Published motor/sensor baseline commands

- `move_forward`, `move_backward`: speed 0–50, duration 0–5 seconds. Zero duration never starts a motor.
- `dc_motor`: M1–M4, power −50…50, duration 0–5 seconds.
- `servo`: S1–S4, angle 0–180, immediate positioning only (`speed: 0`).
- `wait`: 0–60 seconds; the loader and application keep servicing their networks.
- `stop`, `display_text`, `set_led`, `read_sensors`, `status`.
- Flat programs of at most 32 blocks; the entire program is validated before the first action.

Turns, differential `set_speed`, loops, inferred claw positions, and slow-servo sweeps are not implemented in the published motor/sensor baseline. The later bench-only turn extension accepts a native angle argument up to 30 per call, rejects speed/duration, and does not promise that angle as measured chassis yaw. Servo/DC physical motion and object transfers were observed after initial commissioning; see [bench learning](bench-learning.md), rather than interpreting every driver completion as successful positioning.

Status identifies the application build, selected digest, supported commands, and current boot. `armed` means the connected runtime is accepting explicit motion commands; it does not mean the motors are moving. There is no automatic motion or separate key-provisioning ceremony. The server skips all legacy automatic homing/position transformation for this runtime.

## Observed device acceptance

The current confirmed application is digest `696d80fbefd0140caa61103c845d36386fd73a12a604b557cfff481df0fa99bd` (14,558 bytes including provisioning). It adds a bounded, one-native-reading-per-tick sensor scan. Actual complete scans returned battery, distance, loudness, brightness, orientation and four floor-color channel readings without driver errors; fresh values were rendered through the real browser Refresh sensors path. OTA and both Stop paths passed again.

The preceding motor-only release candidate was digest `a76416befc4cc8af6d9f5560cbc6a5e0d4c5ccb29b2aade6f3ad53b42f078152` (12,203 bytes including provisioning). It additionally gives standalone command-topic Stop priority over queued/running work and preserves preempted run outcomes across native/publication errors. Its real nonmoving acceptance and explicit confirmation passed; the native motor primitives are unchanged from the physically observed wheel test. `motor-release-confirmed.json` records its confirmed state.

The first confirmed motor build was application digest `6d7f4407d59fa99f814a08767c6e04f9e4956bc4eb5212c8f4a4c8e245cfcbd6`, 10,630 bytes including local provisioning.

Real-device checks passed:

1. The selected application digest matched the live motor-capable status.
2. The robot returned ultrasonic distance and battery values.
3. OTA status remained responsive during a 15-second wait.
4. Dedicated emergency Stop canceled the wait and returned a correlated cancellation.
5. A valid movement prefix followed by an unsupported block was rejected before any block start.
6. A forward command at speed 15 for 0.35 seconds returned timed-stop completion. **The owner independently observed the tracks turn briefly and stop.** The robot was outside the cameras' view during that test; the saved recording is not physical motion proof.
7. A subsequent program completed normally.
8. Explicit confirmation read back the exact digest; another restart selected the same confirmed application, and the nonmoving checks passed again.

Evidence is local to the commissioning workspace (`mbot-ota-evidence/`), not bundled into the repository because operator settings and generated files can contain private network information. `motor-confirmed.json` and `motor-persisted.json` record the first confirmed build. Later follow-up revisions must have their own digest and acceptance evidence.

## Device-specific bugs discovered

- An application MQTT connection attempted before loader Wi-Fi readiness failed. A Wi-Fi-gated probe published successfully from the real device. Gate the application connection on `cyberpi.wifi.is_connect()`.
- The nested scheduler/error-handler path exhausted the CyberPi's runtime stack inside Makeblock's `dc_motor_stop` / `neurons_data_conversion`. The actual serial traceback reported `RuntimeError('maximum recursion depth exceeded')`. Dispatch now queues hardware operations and publications; `ota_step` invokes them after the scheduler stack unwinds. The formerly failing real Stop test passed after this change.
- Loader health and selected digest are not enough to establish application function. Require actual commands, telemetry, outcomes, and independent physical confirmation where applicable.

## Build and update

Operator configuration is a local JSON file with exactly `brokerUrl`, `prefix`, and `device`. Do not commit it or generated provisioned applications.

```sh
python3 tools/build-robot-control.py --config /private/operator.json --out /private/new-control.py
node tools/ota-update.mjs --config /private/operator.json upload /private/new-control.py
node tools/ota-update.mjs --config /private/operator.json activate <printed-sha256>
# Exercise real status, telemetry, Stop, and an explicitly authorized motor test.
node tools/ota-update.mjs --config /private/operator.json confirm <printed-sha256>
```

Each command is explicit; neither builder nor upload activates or confirms automatically. Do not use the legacy ordinary USB flasher to overwrite the working loader. Opening some USB serial ports can reset the device; an unconfirmed trial then rolls back by design.

Native vendor calls and networking are not hard-real-time or independent actuator power cutoffs. Do not treat a software completion event alone as physical positioning accuracy. Keep the test area clear and retain the USB recovery route.
