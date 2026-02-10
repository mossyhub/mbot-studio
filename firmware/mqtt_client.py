# =============================================================================
# mBot Studio - MQTT Client for mBot2
# =============================================================================
# Handles WiFi connection and MQTT communication with the server

import cyberpi
import time
import json

# Note: On CyberPi, we use the built-in mqtt module
# If using standard MicroPython, use umqtt.simple instead
try:
    from umqtt.simple import MQTTClient
    USING_UMQTT = True
except ImportError:
    USING_UMQTT = False

from config import (
    WIFI_SSID, WIFI_PASSWORD,
    MQTT_BROKER, MQTT_PORT,
    MQTT_TOPIC_PREFIX, MQTT_CLIENT_ID
)


class MqttHandler:
    """Manages MQTT connection for mBot Studio"""

    def __init__(self, on_command=None, on_program=None, on_emergency=None):
        self.on_command = on_command
        self.on_program = on_program
        self.on_emergency = on_emergency
        self.client = None
        self.connected = False

    def connect_wifi(self):
        """Connect to WiFi network"""
        cyberpi.display.show_label("Connecting\nWiFi...", 14, "center", index=0)
        print("Connecting to WiFi:", WIFI_SSID)

        try:
            cyberpi.wifi.connect(WIFI_SSID, WIFI_PASSWORD)

            # Wait for connection (up to 15 seconds)
            for i in range(30):
                if cyberpi.wifi.is_connect():
                    ip = cyberpi.wifi.get_ip()
                    print("WiFi connected! IP:", ip)
                    cyberpi.display.show_label("WiFi OK\n" + str(ip), 12, "center", index=0)
                    time.sleep(1)
                    return True
                time.sleep(0.5)

            print("WiFi connection timeout")
            cyberpi.display.show_label("WiFi\nFailed!", 14, "center", index=0)
            return False

        except Exception as e:
            print("WiFi error:", e)
            cyberpi.display.show_label("WiFi\nError!", 14, "center", index=0)
            return False

    def connect_mqtt(self):
        """Connect to MQTT broker"""
        cyberpi.display.show_label("Connecting\nMQTT...", 14, "center", index=0)
        print("Connecting to MQTT:", MQTT_BROKER)

        try:
            if USING_UMQTT:
                self.client = MQTTClient(
                    MQTT_CLIENT_ID,
                    MQTT_BROKER,
                    port=MQTT_PORT
                )
                self.client.set_callback(self._on_message)
                self.client.connect()
            else:
                # Use CyberPi's built-in MQTT if available
                cyberpi.cloud.mqtt_connect(MQTT_BROKER, MQTT_PORT, MQTT_CLIENT_ID)
                time.sleep(2)

            # Subscribe to command topics
            topics = [
                MQTT_TOPIC_PREFIX + "/robot/command",
                MQTT_TOPIC_PREFIX + "/robot/program",
                MQTT_TOPIC_PREFIX + "/robot/emergency",
                MQTT_TOPIC_PREFIX + "/robot/config",
            ]

            for topic in topics:
                if USING_UMQTT:
                    self.client.subscribe(topic)
                else:
                    cyberpi.cloud.mqtt_subscribe(topic)
                print("Subscribed:", topic)

            self.connected = True
            print("MQTT connected!")
            cyberpi.display.show_label("Connected!\n🤖 Ready", 14, "center", index=0)
            time.sleep(1)
            return True

        except Exception as e:
            print("MQTT error:", e)
            cyberpi.display.show_label("MQTT\nFailed!", 14, "center", index=0)
            self.connected = False
            return False

    def _on_message(self, topic, msg):
        """Handle incoming MQTT messages"""
        try:
            topic = topic.decode() if isinstance(topic, bytes) else topic
            payload = msg.decode() if isinstance(msg, bytes) else msg
            data = json.loads(payload)

            short_topic = topic.replace(MQTT_TOPIC_PREFIX + "/", "")
            print("MQTT recv:", short_topic)

            if short_topic == "robot/emergency":
                if self.on_emergency:
                    self.on_emergency()

            elif short_topic == "robot/command":
                if data.get("type") == "emergency_stop":
                    if self.on_emergency:
                        self.on_emergency()
                elif self.on_command:
                    self.on_command(data)

            elif short_topic == "robot/program":
                program = data.get("program", [])
                if program and self.on_program:
                    self.on_program(program)

        except Exception as e:
            print("Message handler error:", e)

    def check_messages(self):
        """Check for new MQTT messages (non-blocking)"""
        if not self.connected:
            return

        try:
            if USING_UMQTT and self.client:
                self.client.check_msg()
        except Exception as e:
            print("MQTT check error:", e)
            self.connected = False

    def publish(self, subtopic, data):
        """Publish data to an MQTT topic"""
        if not self.connected:
            return False

        topic = MQTT_TOPIC_PREFIX + "/" + subtopic
        payload = json.dumps(data) if isinstance(data, (dict, list)) else str(data)

        try:
            if USING_UMQTT and self.client:
                self.client.publish(topic, payload)
            else:
                cyberpi.cloud.mqtt_publish(topic, payload)
            return True
        except Exception as e:
            print("MQTT publish error:", e)
            return False

    def publish_status(self, status):
        """Publish robot status"""
        return self.publish("robot/status", {"status": status, "time": time.time()})

    def publish_sensors(self, sensor_data):
        """Publish sensor readings"""
        return self.publish("robot/sensors", sensor_data)

    def publish_log(self, message):
        """Publish log message"""
        return self.publish("robot/log", {"message": message, "time": time.time()})

    def disconnect(self):
        """Disconnect from MQTT"""
        try:
            if USING_UMQTT and self.client:
                self.client.disconnect()
            self.connected = False
        except:
            pass
