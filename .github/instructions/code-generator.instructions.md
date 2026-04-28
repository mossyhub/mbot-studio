---
applyTo: "server/src/services/code-generator.js"
description: "Block-to-MicroPython code generation: block type mapping, sensor expressions, motor commands, control flow, hardware port mapping."
---

# Code Generator Instructions

## Purpose
Converts JSON block programs (from AI or visual editor) into executable MicroPython for mBot2.

## Two modes
- `blocksToMicroPython(blocks, robotConfig)` — Full program with imports, init, loop wrapper.
- `blockToMqttCommand(block)` — Single block → MQTT command object for live execution.

## Block type → Python mapping
- Movement: `mbot2.forward(speed, duration)`, `mbot2.backward()`, `mbot2.turn(angle, speed)`.
- Sensors: `mbuild.ultrasonic2.get()`, `mbuild.dual_rgb_sensor`, `cyberpi.get_*()`.
- Sound: `cyberpi.audio.play_tone(freq, duration)`.
- Display: `cyberpi.display.show_label(text)`.
- Hardware: `mbot2.starter_shield.dc_motor_set_power(port, speed)`, `.servo_set(port, angle)`.

## Port mapping
- Motor ports `M1`–`M4` → integers `1`–`4` for starter_shield API.
- Servo ports `S1`–`S4` → integers `1`–`4`.

## Control flow
- `repeat` → `for _ in range(N):` with indented body.
- `repeat_forever` → `while True:` with estop check.
- `if_obstacle`, `if_sensor_range`, `while_sensor` → sensor reads + comparisons.

## Security note
- String values from blocks (e.g., `display_text.text`) are interpolated into Python strings.
- Sensor expression names map to fixed API calls — do not allow arbitrary expressions.
