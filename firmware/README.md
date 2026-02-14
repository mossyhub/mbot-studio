# mBot2 Firmware — Upload Guide

## Overview

These MicroPython files run directly on the mBot2's CyberPi (ESP32) microcontroller. They handle WiFi connection, MQTT communication, and all motor/sensor operations.

## Files

| File | Purpose |
|------|---------|
| `main.py` | Entry point — connects WiFi/MQTT, runs main loop |
| `config.py` | WiFi, MQTT, and hardware settings |
| `mqtt_client.py` | MQTT connection and message handling |
| `motor_controller.py` | Drive motors, DC motors, and servos |
| `sensor_reader.py` | Ultrasonic, line follower, color sensor |
| `command_handler.py` | Dispatches commands to the right subsystem |

## Before Uploading

### 1. Edit `config.py`

Update these values to match your setup:

```python
# Your WiFi network
WIFI_SSID = "YourWiFiName"
WIFI_PASSWORD = "YourWiFiPassword"

# Your computer's IP address (where the MQTT broker runs)
MQTT_BROKER = "192.168.1.100"  # Change to your PC's local IP
MQTT_PORT = 1883
```

To find your PC's IP address:
```bash
# Windows
ipconfig
# Look for "IPv4 Address" under your WiFi adapter
```

### 2. Add Custom Hardware (Optional)

If you've added motors or servos to the mBot2, edit the `CUSTOM_HARDWARE` dict in `config.py`:

```python
CUSTOM_HARDWARE = {
    "claw_left": {"port": "S1", "type": "servo", "default_angle": 30},
    "claw_right": {"port": "S2", "type": "servo", "default_angle": 150},
}
```

## Upload Method (Supported)

### mBot Studio Setup Tab (via Makeblock mLink2)

This project uses Makeblock's local **mLink2** bridge to upload the firmware files to the CyberPi.

1. Download and install **mLink2** (Makeblock) and keep it running on this computer.
2. Connect the mBot2/CyberPi via USB-C.
3. In mBot Studio → **Setup** tab:
    - Fill in WiFi + MQTT settings
    - Click **Upload Firmware via mLink**
4. Wait for the robot to reboot.

> **Important**: Upload ALL files together. The firmware won't work with missing files.

## Testing the Connection

1. Upload all firmware files to the mBot2
2. Make sure Mosquitto is running on your computer
3. Power on the mBot2
4. Watch the CyberPi display:
   - "Connecting WiFi..." → "WiFi OK" (with IP address)
   - "Connecting MQTT..." → "Connected! 🤖 Ready"
5. In the web interface, the status bar should show "Connected"

## Button Controls

| Button | Action |
|--------|--------|
| **A** (left) | Emergency Stop — immediately stops all motors |
| **B** (right) | Show Status — displays WiFi/MQTT connection info |

## LED Indicators

| Color | Meaning |
|-------|---------|
| 🔵 Blue | Starting up |
| 🟢 Green | Connected and ready |
| 🔴 Red | Error or emergency stop |

## Troubleshooting

### Robot LEDs stay blue
- WiFi connection is failing
- Check SSID and password in `config.py`
- Move closer to your WiFi router

### WiFi connects but MQTT fails
- Check that Mosquitto is running on your computer
- Verify the `MQTT_BROKER` IP in `config.py` matches your computer
- Make sure both devices are on the same network
- Check if your firewall blocks port 1883

### Robot connects then disconnects
- The MQTT broker might be restarting
- Check the Mosquitto log for errors
- Try increasing `reconnect_interval` in `main.py`

### Motors don't respond
- Check motor connections to the mBot2 shield
- Verify port assignments match `config.py`
- Use button B to confirm the robot is connected

## Port Reference

| Port | Type | Default Use |
|------|------|------------|
| EM1 | Encoder Motor | Left drive wheel |
| EM2 | Encoder Motor | Right drive wheel |
| M1-M4 | DC Motor | Custom motors (claw, arm, etc.) |
| S1-S4 | Servo | Custom servos |
| P1-P4 | mBuild | mBuild sensor chain |
