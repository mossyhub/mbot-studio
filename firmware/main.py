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
diag_running = False
_repl_pending = None
_diag_pending = False
_cmd_pending = None
_program_pending = None
_estop = False
sensor = SensorReader()
motor = MotorController(sensor_reader=sensor)
mqtt = None
handler = None
dashboard = CyberPiDashboard()
repl_enabled = True


def on_emergency():
    global program_running, _estop
    program_running = False
    _estop = True  # Just set the flag - main loop and motor sleep will handle it
    print("ESTOP")


def on_command(data):
    """Queue ALL commands for execution in the main loop (shallow call stack)."""
    global _diag_pending, _repl_pending, _cmd_pending
    try:
        cmd_t = data.get("type", "")
    except Exception:
        cmd_t = ""
    if cmd_t == "run_diagnostic":
        _diag_pending = True
    elif cmd_t == "repl_exec":
        _repl_pending = data
    else:
        _cmd_pending = data


def on_program(blocks):
    """Queue program for execution in the main loop."""
    global _program_pending
    _program_pending = blocks


def on_repl(data):
    """Queue REPL code for execution in the main loop (shallow call stack)."""
    global _repl_pending
    _repl_pending = data


def run_repl():
    """Execute pending REPL code from the main loop. Called with minimal call stack."""
    global _repl_pending
    data = _repl_pending
    _repl_pending = None
    code = data.get("code", "")
    req_id = data.get("id", "")
    if not code:
        return
    result = {"id": req_id, "ok": False, "output": "", "error": ""}
    try:
        exec(code, globals())
        result["ok"] = True
    except Exception as e:
        result["error"] = str(e)
        print("REPL err:", e)
    if mqtt:
        mqtt.publish("robot/repl/result", result)


def show_ready_screen():
    dashboard.render(force=True)
    cyberpi.led.show("green green green green green")

def rprint(*args):
    """Print that captures output for REPL. Call via exec(code, globals())."""
    text = " ".join(str(a) for a in args)
    print(text)
    if mqtt:
        mqtt.publish("robot/repl/result", {"id": "", "ok": True, "output": text, "error": ""})


def show_error_screen(msg):
    cyberpi.display.show_label("ERR:\n" + msg, 12, "center", index=0)
    cyberpi.led.show("red red red red red")


# Main Program
def main():
    global mqtt, handler, running, program_running, diag_running, _diag_pending, _cmd_pending, _estop, _program_pending

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

    # Wire estop check so motor sleep can be interrupted
    motor._estop_check = lambda: _estop

    # Wire motor logging through MQTT so we can see diagnostics remotely
    def motor_log(msg):
        if mqtt and mqtt.connected:
            try:
                mqtt.publish_log("[motor] " + msg)
            except:
                pass
    motor.set_logger(motor_log)

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
                if not diag_running and not program_running:
                    diag_running = True
                    dashboard.unlock()
                    dashboard.lock(30)
                    try:
                        motor.run_diagnostic()
                    except Exception as e:
                        print("Diag btn err:", e)
                    diag_running = False
                    dashboard.unlock()
                    show_ready_screen()
                time.sleep(0.5)

            if _estop:
                _estop = False
                motor.emergency_stop()

            if _cmd_pending and handler:
                cmd = _cmd_pending
                _cmd_pending = None
                try:
                    cmd_t = cmd.get("type", "")
                    if cmd_t in ("display_text", "display_image", "say"):
                        dashboard.lock(8)
                    handler.handle_command(cmd)
                except Exception as e:
                    print("Cmd err:", e)

            if _repl_pending:
                run_repl()

            if _diag_pending and not diag_running:
                _diag_pending = False
                diag_running = True
                dashboard.lock(30)
                try:
                    motor.run_diagnostic()
                except Exception as e:
                    print("Diag err:", e)
                diag_running = False
                dashboard.unlock()
                show_ready_screen()

            if _program_pending and handler and not program_running:
                blocks = _program_pending
                _program_pending = None
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
