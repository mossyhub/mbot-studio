# =============================================================================
# mBot Studio - mBot2 Firmware Configuration
# =============================================================================
# Edit these settings before uploading to your mBot2
#
# Upload instructions:
#   1. Connect mBot2 via USB
#   2. Open mBlock or Thonny
#   3. Upload all .py files in this folder to the CyberPi
#   4. The robot will auto-connect to WiFi and MQTT on boot

# WiFi Settings
WIFI_SSID = "YOUR_WIFI_NAME"
WIFI_PASSWORD = "YOUR_WIFI_PASSWORD"

# MQTT Settings
MQTT_BROKER = "YOUR_COMPUTER_IP"  # e.g., "192.168.1.100"
MQTT_PORT = 1883
MQTT_TOPIC_PREFIX = "mbot-studio"
MQTT_CLIENT_ID = "mbot2-rover"

# Motor Settings
# Default speed for movements (0-100)
DEFAULT_SPEED = 50

# Sensor / Telemetry Settings
SENSOR_INTERVAL = 1       # Seconds between telemetry broadcasts (lower = more responsive)

# Safety Settings
MAX_SPEED = 80          # Cap maximum speed for safety
OBSTACLE_MIN_DIST = 10  # Minimum distance (cm) before auto-stop
COMMAND_TIMEOUT = 30    # Max seconds for any single command

# Custom Hardware Ports (update to match your setup)
# These are populated from the web app's Robot Setup
CUSTOM_HARDWARE = {
    # Example entries (uncomment and modify as needed):
    # "claw": {"port": "M3", "type": "dc_motor", "default_speed": 70},
    # "arm": {"port": "S1", "type": "servo", "default_angle": 90},
}
