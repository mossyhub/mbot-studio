import cyberpi
import mbot2
import time

from mbot_config import DEFAULT_SPEED, SENSOR_INTERVAL
from mbot_mqtt import MqttHandler
from mbot_dashboard import CyberPiDashboard
from mbot_motor import MotorController
from mbot_sensor import SensorReader
from mbot_commands import CommandHandler

running = True
program_running = False
sensor = SensorReader()
motor = MotorController(sensor_reader=sensor)
mqtt = None
handler = None
dashboard = CyberPiDashboard()


def on_emergency():
    global program_running
    program_running = False
    motor.emergency_stop()
    cyberpi.display.show_label("STOP!", 16, "center", index=0)
    dashboard.lock(10)
    if mqtt:
        mqtt.publish_status("stopped")
    print("ESTOP")


def on_command(data):
    global handler
    if handler:
        try:
            cmd_t = data.get("type", "")
        except Exception:
            cmd_t = ""
        if cmd_t in ("display_text", "display_image", "say"):
            dashboard.lock(8)
        handler.handle_command(data)


def on_program(blocks):
    global program_running, handler
    if handler:
        dashboard.lock(3600)
        program_running = True
        if mqtt:
            mqtt.publish_status("running")
        cyberpi.display.show_label("Running...", 14, "center", index=0)
        try:
            handler.run_program(blocks)
        except Exception as e:
            print("Prog err:", e)
        program_running = False
        motor.stop()
        if mqtt:
            mqtt.publish_status("idle")
        dashboard.unlock()
        time.sleep(1)
        show_ready_screen()


def show_ready_screen():
    dashboard.render(force=True)
    cyberpi.led.show("green green green green green")

def show_error_screen(msg):
    cyberpi.display.show_label("ERR:\n" + msg, 12, "center", index=0)
    cyberpi.led.show("red red red red red")


# Main Program
def main():
    global mqtt, handler, running

    cyberpi.display.show_label("mBot\nStudio", 18, "center", index=0)
    time.sleep(2)

    mqtt = MqttHandler(
        on_command=on_command,
        on_program=on_program,
        on_emergency=on_emergency,
        dashboard=dashboard
    )

    wifi_ok = mqtt.connect_wifi()
    if not wifi_ok:
        print("WiFi failed, retrying...")
        time.sleep(3)
        wifi_ok = mqtt.connect_wifi()
    if not wifi_ok:
        show_error_screen("No WiFi")
        time.sleep(3)
        print("Running in offline mode")
    else:
        dashboard.set_wifi(True, mqtt.get_wifi_ip())
        time.sleep(2)

    mqtt_ok = False
    if mqtt.is_wifi_connected():
        for attempt in range(3):
            mqtt_ok = mqtt.connect_mqtt()
            if mqtt_ok:
                break
            print("MQTT attempt", attempt + 1, "failed, retrying...")
            time.sleep(3)
        if not mqtt_ok:
            show_error_screen("No MQTT")
            time.sleep(2)
        dashboard.set_mqtt(bool(mqtt_ok))
    else:
        dashboard.set_wifi(False, None)
        dashboard.set_mqtt(False)

    handler = CommandHandler(motor, sensor, mqtt_client=mqtt)
    if mqtt_ok:
        mqtt.publish_status("ready")

    show_ready_screen()

    last_sensor_time = time.time()
    last_heartbeat_time = time.time()
    heartbeat_interval = 5
    reconnect_interval = 10
    last_reconnect_time = 0
    last_wifi_state = mqtt.is_wifi_connected()

    print("Entering main loop...")

    while running:
        try:
            if mqtt.connected:
                mqtt.check_messages()
            elif mqtt.is_wifi_connected():
                now = time.time()
                if now - last_reconnect_time > reconnect_interval:
                    last_reconnect_time = now
                    mqtt.connect_mqtt()

            now = time.time()
            if mqtt.connected and (now - last_heartbeat_time) > heartbeat_interval:
                last_heartbeat_time = now
                mqtt.publish_status("running" if program_running else "ready")

            now = time.time()
            if mqtt.connected and (now - last_sensor_time) > SENSOR_INTERVAL:
                last_sensor_time = now
                try:
                    mqtt.publish_sensors(sensor.read_all())
                except:
                    pass

            if cyberpi.controller.is_press("a"):
                on_emergency()
                time.sleep(0.5)

            if cyberpi.controller.is_press("b"):
                dashboard.unlock()
                dashboard.render(force=True)
                time.sleep(0.3)

            wifi_now = mqtt.is_wifi_connected()
            if wifi_now != last_wifi_state:
                last_wifi_state = wifi_now
                if wifi_now:
                    dashboard.set_wifi(True, mqtt.get_wifi_ip())
                else:
                    dashboard.set_wifi(False, None)
                    dashboard.set_mqtt(False)

            if not program_running:
                dashboard.render()

            time.sleep(0.05)

        except KeyboardInterrupt:
            print("Shutting down...")
            running = False

        except Exception as e:
            print("Main loop error:", e)
            time.sleep(1)

    motor.emergency_stop()
    if mqtt:
        mqtt.publish_status("offline")
        mqtt.disconnect()

    cyberpi.display.show_label("Goodbye!", 18, "center", index=0)
    cyberpi.led.show("black black black black black")


# Run!
try:
    main()
except Exception as e:
    # Show the actual error on CyberPi screen for debugging
    err_msg = str(e)
    print("FATAL:", err_msg)
    try:
        import cyberpi
        cyberpi.display.show_label("ERR:\n" + err_msg[:60], 10, "center", index=0)
        cyberpi.led.show("red red red red red")
    except:
        pass
