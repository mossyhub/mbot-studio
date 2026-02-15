import cyberpi
import time
import json

try:
    from simple_mqtt import MQTTClient
    USING_UMQTT = True
except ImportError:
    try:
        from umqtt.simple import MQTTClient
        USING_UMQTT = True
    except ImportError:
        USING_UMQTT = False

from mbot_config import (
    WIFI_SSID, WIFI_PASSWORD,
    MQTT_BROKER, MQTT_PORT,
    MQTT_TOPIC_PREFIX, MQTT_CLIENT_ID
)


class MqttHandler:
    def __init__(self, on_command=None, on_program=None, on_emergency=None, dashboard=None):
        self.on_command = on_command
        self.on_program = on_program
        self.on_emergency = on_emergency
        self.dashboard = dashboard
        self.client = None
        self.connected = False
        self.wifi_ip = None

    def is_wifi_connected(self):
        try:
            return cyberpi.wifi.is_connect()
        except:
            return False

    def get_wifi_ip(self):
        try:
            if cyberpi.wifi.is_connect():
                return cyberpi.wifi.get_ip()
        except:
            pass
        return self.wifi_ip or "N/A"

    def connect_wifi(self):
        cyberpi.display.show_label("WiFi...", 12, "center", index=0)
        print("WiFi:", WIFI_SSID)
        try:
            cyberpi.wifi.connect(WIFI_SSID, WIFI_PASSWORD)
            for i in range(60):
                time.sleep(0.5)
                try:
                    if cyberpi.wifi.is_connect():
                        ip = None
                        try:
                            ip = cyberpi.wifi.get_ip()
                        except:
                            ip = "unknown"
                        if ip and ip != "0.0.0.0":
                            self.wifi_ip = ip
                            print("WiFi OK:", ip)
                            cyberpi.display.show_label("WiFi OK\n" + str(ip), 12, "center", index=0)
                            if self.dashboard:
                                self.dashboard.set_wifi(True, ip)
                            time.sleep(1)
                            return True
                except:
                    pass
            print("WiFi timeout")
            cyberpi.display.show_label("WiFi timeout", 10, "center", index=0)
            if self.dashboard:
                self.dashboard.set_wifi(False, None)
            time.sleep(2)
            return False
        except Exception as e:
            print("WiFi err:", e)
            cyberpi.display.show_label("WiFi ERR", 10, "center", index=0)
            time.sleep(2)
            return False

    def connect_mqtt(self):
        cyberpi.display.show_label("MQTT...", 12, "center", index=0)
        print("MQTT:", MQTT_BROKER, MQTT_PORT)
        try:
            if USING_UMQTT:
                self.client = MQTTClient(MQTT_CLIENT_ID, MQTT_BROKER, port=MQTT_PORT)
                self.client.set_callback(self._on_message)
                self.client.connect()
            else:
                cyberpi.cloud.mqtt_connect(MQTT_BROKER, MQTT_PORT, MQTT_CLIENT_ID)
                time.sleep(3)
            topics = [
                MQTT_TOPIC_PREFIX + "/robot/command",
                MQTT_TOPIC_PREFIX + "/robot/program",
                MQTT_TOPIC_PREFIX + "/robot/emergency",
            ]
            for topic in topics:
                if USING_UMQTT:
                    self.client.subscribe(topic)
                else:
                    cyberpi.cloud.mqtt_subscribe(topic)
            self.connected = True
            print("MQTT OK")
            cyberpi.display.show_label("Connected!", 14, "center", index=0)
            if self.dashboard:
                self.dashboard.set_mqtt(True)
            time.sleep(1)
            return True
        except Exception as e:
            print("MQTT err:", e)
            self.connected = False
            if self.dashboard:
                self.dashboard.set_mqtt(False)
            return False

    def _on_message(self, topic, msg):
        try:
            topic = topic.decode() if isinstance(topic, bytes) else topic
            payload = msg.decode() if isinstance(msg, bytes) else msg
            data = json.loads(payload)
            short = topic.replace(MQTT_TOPIC_PREFIX + "/", "")
            if short == "robot/emergency":
                if self.on_emergency:
                    try:
                        self.on_emergency()
                    except:
                        pass
            elif short == "robot/command":
                if data.get("type") == "emergency_stop":
                    if self.on_emergency:
                        try:
                            self.on_emergency()
                        except:
                            pass
                elif self.on_command:
                    try:
                        self.on_command(data)
                    except:
                        pass
            elif short == "robot/program":
                program = data.get("program", [])
                if program and self.on_program:
                    try:
                        self.on_program(program)
                    except:
                        pass
        except Exception as e:
            print("Msg err:", e)

    def check_messages(self):
        if not self.connected:
            return
        try:
            if USING_UMQTT and self.client:
                self.client.check_msg()
        except:
            self.connected = False
            if self.dashboard:
                self.dashboard.set_mqtt(False)

    def publish(self, subtopic, data):
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
        except:
            return False

    def publish_status(self, status):
        return self.publish("robot/status", {"status": status})

    def publish_sensors(self, sensor_data):
        return self.publish("robot/sensors", sensor_data)

    def publish_log(self, message):
        return self.publish("robot/log", {"message": message})

    def disconnect(self):
        try:
            if USING_UMQTT and self.client:
                self.client.disconnect()
            self.connected = False
        except:
            pass
