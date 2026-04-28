---
applyTo: "firmware/**"
description: "MicroPython firmware for mBot2 CyberPi (ESP32): bundled single-file deployment, MQTT command dispatch, motor/sensor abstraction, emergency stop, dashboard display."
---

# Firmware (MicroPython) Instructions

## Deployment
- All modules bundled into a single `main.py` before upload — CyberPi cannot reliably import custom modules from `/flash/`.
- Bundling is done server-side in `server/src/routes/config.js` → `bundleFirmwareFiles()`.
- Cross-imports between our modules are stripped; stdlib imports are deduplicated.

## Module structure (dependency order)
1. `mbot_config` — Pure constants (WiFi, MQTT, motor defaults). No deps.
2. `mbot_dashboard` — CyberPi display rendering with dirty-flag + lock mechanism.
3. `mbot_sensor` — Sensor abstraction over `mbuild` (add-on) and `cyberpi` (built-in).
4. `mbot_motor` — Motor control: rover wheels, DC motors (M1–M4), servos (S1–S4) via starter_shield.
5. `mbot_mqtt` — WiFi + MQTT connection management with callback routing.
6. `mbot_commands` — Command dispatcher: movement, sensors, sound, display, control flow, variables.
7. `main` — Entry point: WiFi/MQTT init, event loop, REPL handler.

## Hardware APIs
- `mbot2` library: `forward()`, `backward()`, `turn()`, `EM_stop()` — rover wheel control.
- `mbot2.starter_shield`: `dc_motor_set_power(port, speed)`, `servo_set(port, angle)`.
- `mbuild.ultrasonic2`: Distance sensor.
- `mbuild.dual_rgb_sensor` / `mbuild.quad_rgb_sensor`: Line/color detection.
- `cyberpi`: Display, battery, IMU (yaw/pitch/roll), brightness, loudness, buttons.

## Emergency stop
- `_estop` flag set by MQTT callback.
- Motor `_drive()` polls this flag every 50ms during movement.
- All motors halted via `mbot2.EM_stop()` + `starter_shield` power-off.

## MQTT topics (subscribe)
- `robot/command` — Single JSON command.
- `robot/program` — Full program (JSON array of blocks).
- `robot/emergency` — Emergency stop signal.
- `robot/repl` — Python code for `exec()`.

## MQTT topics (publish)
- `robot/status` — `ready`, `running`, `idle`.
- `robot/sensors` — Sensor telemetry JSON.
- `robot/log` — Debug messages.
- `robot/repl/result` — REPL output.

## Command dispatch
- `CommandHandler._dispatch()` is a large if/elif chain routing by `block["type"]`.
- Supports: movement, sensors, sound, display, LEDs, control flow (repeat, if/else, while), variables, math, DC motors, servos.
- `_resolve(value)` converts block params to numbers or looks up variables.
- `_run_blocks(blocks)` executes a list with estop checking between each.

## Known constraints
- No sensor feedback for motors — relies on timed duration.
- `move_until` and `while_sensor` have no timeout safety.
- Sensor magic values: distance returns -1 (error) or 999 (no obstacle).
- WiFi credentials embedded in `mbot_config.py` at upload time.
