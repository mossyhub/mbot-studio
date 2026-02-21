# mBot2 Firmware — MicroPython on CyberPi (ESP32)

## Overview

These MicroPython files run on the mBot2's CyberPi (ESP32). They handle WiFi/MQTT connection, motor/sensor control, and command dispatch. All modules are bundled into a single `main.py` by the server's bundler before upload.

## Architecture

**Critical constraint:** The CyberPi's MicroPython has a very low recursion limit (~20 frames). All MQTT message handlers **must not execute robot commands directly**. Instead, callbacks set flags/queues that the main loop picks up. This "deferred execution" pattern is the core architectural decision.

```
MQTT callback → sets _cmd_pending / _repl_pending / _diag_pending / _program_pending
                    ↓
Main loop    → checks flags → executes at shallow call stack depth
```

## Files

| File | Purpose |
|------|---------|
| `main.py` | Entry point — WiFi/MQTT connect, main loop, deferred command/REPL/diagnostic/program execution |
| `mbot_config.py` | WiFi SSID/password, MQTT broker IP/port, speed limits |
| `mbot_mqtt.py` | MQTT client (umqtt), topic subscriptions, message callbacks |
| `mbot_motor.py` | Drive motors (`mbot2.forward/backward/turn`), DC motors (`mbot2.motor_set`), servos (`mbot2.servo_set`), emergency stop |
| `mbot_sensor.py` | Sensor reading via `mbuild` and `cyberpi` modules |
| `mbot_commands.py` | Command dispatcher — routes block types to motor/sensor/display actions, variable support |
| `mbot_dashboard.py` | CyberPi screen UI (WiFi/MQTT status + IP address) |
| `test_motors.py` | Standalone motor test firmware (flash separately for hardware testing) |

## Verified mBot2 / CyberPi API Reference

These APIs were verified via the remote REPL on actual hardware (CyberPi firmware 44.01.008, ESP32):

### Drive Motors (`import mbot2`)

| Function | Verified | Notes |
|----------|----------|-------|
| `mbot2.forward(speed)` | Yes | Drive forward at speed (0-100). Known working. |
| `mbot2.backward(speed)` | Yes | Drive backward |
| `mbot2.turn(angle)` | Yes | Turn by angle (positive=right, negative=left) |
| `mbot2.EM_stop()` | Yes | Stop encoder motors |

**Important:** `mbot2.forward()` is the primary drive API. Other high-level wrappers like `mbot2.drive_speed()`, `mbot2.EM_set_speed()` exist but may silently fail.

### Servo & DC Motor Ports (`mbot2.starter_shield`)

The high-level `mbot2.servo_set()` and `mbot2.motor_set()` **silently fail** — they run without error but don't move hardware. The correct working APIs are on `mbot2.starter_shield`:

| Function | Verified | Notes |
|----------|----------|-------|
| `mbot2.starter_shield.servo_set_angle(port, angle)` | **Yes** | Set servo angle (port 1-4, angle 0-180). **This is the working servo API.** |
| `mbot2.starter_shield.servo_get_angle(port)` | Yes | Read current servo angle |
| `mbot2.starter_shield.servo_release(port)` | Yes | Release servo hold |
| `mbot2.starter_shield.dc_motor_set_power(port, speed)` | **Yes** | DC motor (port 1-4, speed -100 to 100). **This is the working DC motor API.** |
| `mbot2.starter_shield.dc_motor_stop()` | Yes | Stop all DC motors |

**Critical:** Do NOT use `mbot2.servo_set()` or `mbot2.motor_set()` — they exist but silently fail. Always use `mbot2.starter_shield.*` for servo and DC motor control.

### Sensors (`import mbuild`)

| Function | Returns | Notes |
|----------|---------|-------|
| `mbuild.ultrasonic2.get()` | Float (cm) | Distance sensor. **NOT** `mbot2.ultrasonic2` |
| `mbuild.dual_rgb_sensor.is_line()` | Bool | Line follower — is on line? |
| `mbuild.dual_rgb_sensor.get_line_sta()` | Int | Line status value |
| `mbuild.dual_rgb_sensor.get_offset_track()` | Int | Offset from track center |
| `mbuild.dual_rgb_sensor.get_color()` | String | Detected color |
| `mbuild.dual_rgb_sensor.is_color(color)` | Bool | Is the detected color X? |
| `mbuild.quad_rgb_sensor.is_color(color, port)` | Bool | Color check with port (L1/L2) |
| `mbuild.quad_rgb_sensor.get_color(port)` | Hex string | Raw color value |

**Important:** Sensors are on the `mbuild` module, NOT `mbot2`. `mbot2.line_follower` and `mbot2.color_sensor` do NOT exist.

### CyberPi (`import cyberpi`)

| Function | Returns | Notes |
|----------|---------|-------|
| `cyberpi.get_brightness()` | Int | Light sensor. **NOT** `get_lightness()` |
| `cyberpi.get_loudness()` | Int | Sound sensor |
| `cyberpi.get_battery()` | Int (0-100) | Battery percentage |
| `cyberpi.get_yaw()` | Int | Gyro yaw angle |
| `cyberpi.get_pitch()` | Int | Gyro pitch |
| `cyberpi.get_roll()` | Int | Gyro roll |
| `cyberpi.led.show("red red red red red")` | — | Set all 5 LEDs |
| `cyberpi.led.off()` | — | Turn off LEDs |
| `cyberpi.led.on(r, g, b)` | — | RGB color |
| `cyberpi.led.breathe(color)` | — | Breathing effect |
| `cyberpi.led.rainbow_effect()` | — | Rainbow animation |
| `cyberpi.audio.play("score")` | — | Play named sound |
| `cyberpi.audio.play_melody(name)` | — | Play melody |
| `cyberpi.audio.play_tone(freq, dur)` | — | Play tone |
| `cyberpi.display.show_label(text, size, pos, index=0)` | — | Show text on screen |
| `cyberpi.controller.is_press("a")` | Bool | Button press check |
| `cyberpi.wifi.is_connect()` | Bool | WiFi connected? |

### What does NOT work / common wrong assumptions

- `mbot2.servo_set(port, angle)` — **exists but silently fails**. Use `mbot2.starter_shield.servo_set_angle(port, angle)`
- `mbot2.motor_set(port, speed)` — **exists but silently fails**. Use `mbot2.starter_shield.dc_motor_set_power(port, speed)`
- `mbot2.motor_stop("all")` — **exists but silently fails**. Use `mbot2.starter_shield.dc_motor_stop()`
- `mbot2.ultrasonic2` — does not exist. Use `mbuild.ultrasonic2`
- `mbot2.line_follower` — does not exist. Use `mbuild.dual_rgb_sensor`
- `mbot2.color_sensor` — does not exist. Use `mbuild.quad_rgb_sensor`
- `cyberpi.get_lightness()` — does not exist. Use `cyberpi.get_brightness()`
- `cyberpi.wifi.get_ip()` — may not exist on all firmware versions

## Supported Command Types (firmware dispatch)

All 24 command types handled by `_dispatch()` in `mbot_commands.py`:

| Type | Category | Parameters |
|------|----------|------------|
| `move_forward` | Movement | speed, duration |
| `move_backward` | Movement | speed, duration |
| `turn_left` | Movement | speed, angle |
| `turn_right` | Movement | speed, angle |
| `stop` | Movement | — |
| `set_speed` | Movement | left, right |
| `if_obstacle` | Sensor | distance, then[], else[] |
| `if_line` | Sensor | then[], else[] |
| `if_color` | Sensor | color, then[], else[] |
| `if_sensor_range` | Sensor | sensor, min, max, then[], else[] |
| `while_sensor` | Control | sensor, operator, value, do[] |
| `move_until` | Control | direction, speed, sensor, operator, value |
| `display_value` | Display | sensor, label |
| `play_tone` | Sound | frequency, duration |
| `play_melody` | Sound | melody |
| `display_text` / `say` | Display | text, size |
| `display_image` | Display | image |
| `set_led` | Display | color |
| `wait` | Control | duration |
| `repeat` | Control | times, do[] |
| `repeat_forever` | Control | do[] |
| `if_button` | Control | button, then[] |
| `set_variable` | Variables | name, value/source |
| `change_variable` | Variables | name, by |
| `math_operation` | Variables | result, a, operator, b |
| `dc_motor` | Hardware | port, speed, duration |
| `servo` | Hardware | port, angle |
| `read_sensors` | Admin | — |
| `emergency_stop` | Admin | — |
| `run_diagnostic` | Admin | — (deferred to main loop) |
| `repl_exec` | Admin | code, id (deferred to main loop) |

## Flashing Firmware

### Via mBot Studio (recommended)

1. Connect mBot2 via USB-C
2. Run **mLink2** on your computer (Makeblock bridge software)
3. Open mBot Studio web UI → **Setup** tab
4. Fill in WiFi SSID, password, and MQTT broker IP
5. Click **Upload Firmware via mLink**
6. **Full power cycle required** — disconnect USB-C, power off robot, wait 3 seconds, power back on

**Important notes:**
- The server bundles all firmware modules into a single `main.py` file before upload
- The server reads firmware files **fresh from disk** on each upload (not cached)
- The file is written to `/flash/_xx_main.py` (Makeblock slot convention)
- Do NOT write to `/flash/main.py` — it conflicts with CyberPi's boot sequence and causes black screen
- After upload, the CyberPi must be fully power cycled (not just reboot) for new code to take effect

### Via "Test Motors Only" button

For hardware debugging, the Setup tab has a "Test Motors Only" button that uploads the standalone `test_motors.py`. This is useful if the main firmware bricks the robot.

## Button Controls

| Button | Action |
|--------|--------|
| **A** (left) | Emergency Stop — sets `_estop` flag, main loop calls `motor.emergency_stop()` |
| **B** (right) | Run Motor Diagnostic — tests all 5 motor APIs, logs results via MQTT |

## Remote REPL (Debug Tab)

The firmware includes a remote REPL accessible from the web UI's Debug tab:

- Send arbitrary MicroPython code via MQTT topic `robot/repl`
- Code executes via `exec(code, globals())` in the main loop (deferred, shallow stack)
- Results returned via MQTT topic `robot/repl/result`
- Use `rprint()` instead of `print()` to capture output back to the Debug terminal
- Available objects: `mbot2`, `cyberpi`, `mbuild`, `time`, `motor`, `sensor`, `handler`, `mqtt`

## Emergency Stop Architecture

The stop system uses a flag-based approach for reliability:

1. MQTT callback sets `_estop = True` (just a flag, no function calls)
2. Motor sleep loops check `self._estop_check()` every 50ms and break
3. Main loop picks up `_estop` flag and calls `motor.emergency_stop()`

This works even during blocking motor commands because the sleep polling catches the flag.

## Troubleshooting

### Black screen after flash
The firmware likely crashed at boot. Use "Test Motors Only" to recover, then reflash the full firmware. Most common cause: writing to `/flash/main.py` instead of `/flash/_xx_main.py`.

### Motors don't respond
Check `mbot2.forward(30)` via the Debug REPL. If that works but Live Control doesn't, the issue is in the command dispatch chain. All commands must execute from the main loop, not inside MQTT callbacks.

### "maximum recursion depth exceeded"
Code is executing too deep in the call stack. Move execution to the main loop using the deferred flag pattern.

### Robot reconnects WiFi/MQTT after diagnostic
The diagnostic or command was running inside the MQTT callback, blocking `check_msg()` for too long. Defer it to the main loop.
