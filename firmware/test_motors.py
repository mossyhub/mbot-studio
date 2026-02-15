# Minimal motor test firmware - modeled after reference:
# https://github.com/deemkeen/mbotmcp/blob/main/assets/mbot-mqtt.py
#
# This is a STANDALONE test file. Flash it as main.py to test
# whether motor control works at all through our upload pipeline.
# It does NOT use any of our classes/modules.

import cyberpi
import mbot2
import time
from simple_mqtt import MQTTClient

# --- Config (will be substituted by bundler) ---
WIFI_SSID = "YOUR_WIFI_NAME"
WIFI_PASSWORD = "YOUR_WIFI_PASSWORD"
MQTT_BROKER = "YOUR_COMPUTER_IP"
MQTT_PORT = 1883
MQTT_TOPIC_PREFIX = "mbot-studio"

# --- WiFi (using cyberpi.wifi to avoid timeout) ---
cyberpi.display.show_label("Connecting\nWiFi...", 14, "center", index=0)

cyberpi.wifi.connect(WIFI_SSID, WIFI_PASSWORD)

retries = 0
wifi_connected = False
while retries < 20:
    if cyberpi.wifi.is_connect():
        wifi_connected = True
        break
    cyberpi.console.println("Waiting WiFi...")
    time.sleep(1)
    retries += 1

if wifi_connected:
    ip = cyberpi.wifi.get_ip()
    cyberpi.display.show_label("WiFi OK\n" + str(ip), 12, "center", index=0)
    print("WiFi connected:", ip)
    time.sleep(1)
else:
    cyberpi.display.show_label("WiFi\nFAILED", 16, "center", index=0)
    print("WiFi connection failed")
    time.sleep(3)

# --- MQTT ---
def on_message(topic, msg):
    command = msg.decode("utf-8").strip().upper()
    cyberpi.console.println("CMD: " + command)
    print("Got:", command)

    if command == "FORWARD":
        mbot2.forward(50, 1)
    elif command == "BACKWARD":
        mbot2.backward(50, 1)
    elif command == "LEFT":
        mbot2.turn(-90)
    elif command == "RIGHT":
        mbot2.turn(90)
    elif command == "STOP":
        mbot2.EM_stop()
    elif command == "BEEP":
        cyberpi.audio.play("score")
    else:
        cyberpi.console.println("Unknown: " + command)

client = None
mqtt_ok = False

if wifi_connected:
    try:
        cyberpi.display.show_label("MQTT\n" + MQTT_BROKER, 12, "center", index=0)
        client = MQTTClient(
            client_id="mbot2-test",
            server=MQTT_BROKER,
            port=MQTT_PORT
        )
        client.set_callback(on_message)
        client.connect()
        client.subscribe(MQTT_TOPIC_PREFIX + "/robot/command")
        mqtt_ok = True
        cyberpi.display.show_label("MQTT OK!\nReady", 14, "center", index=0)
        print("MQTT connected, subscribed to", MQTT_TOPIC_PREFIX + "/robot/command")
        time.sleep(1)
    except Exception as e:
        cyberpi.display.show_label("MQTT ERR\n" + str(e)[:30], 10, "center", index=0)
        print("MQTT error:", e)
        time.sleep(3)

# --- Status display ---
cyberpi.display.show_label("MOTOR TEST\nReady!\nPress controls", 12, "center", index=0)
cyberpi.led.show("green green green green green")

# --- Button controls (no MQTT needed) ---
# Press A = forward, B = backward
# These test motors WITHOUT needing MQTT at all

print("Motor test ready. Button A=fwd, B=bwd")
print("MQTT commands: FORWARD, BACKWARD, LEFT, RIGHT, STOP, BEEP")

while True:
    # Check MQTT
    if mqtt_ok and client:
        try:
            client.check_msg()
        except:
            pass

    # Button A = test forward
    if cyberpi.controller.is_press("a"):
        cyberpi.display.show_label("FWD!", 20, "center", index=0)
        cyberpi.led.show("blue blue blue blue blue")
        print("Button A: forward")
        mbot2.forward(50, 1)
        cyberpi.display.show_label("MOTOR TEST\nReady!", 14, "center", index=0)
        cyberpi.led.show("green green green green green")
        time.sleep(0.3)

    # Button B = test backward
    if cyberpi.controller.is_press("b"):
        cyberpi.display.show_label("BWD!", 20, "center", index=0)
        cyberpi.led.show("red red red red red")
        print("Button B: backward")
        mbot2.backward(50, 1)
        cyberpi.display.show_label("MOTOR TEST\nReady!", 14, "center", index=0)
        cyberpi.led.show("green green green green green")
        time.sleep(0.3)

    time.sleep(0.05)
