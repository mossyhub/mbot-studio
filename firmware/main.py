# =============================================================================
# mBot Studio - Main Entry Point for mBot2
# =============================================================================
# Connects to WiFi/MQTT and runs the main command handling loop

import cyberpi
import mbot2
import time

from config import DEFAULT_SPEED, SENSOR_INTERVAL
from mqtt_client import MqttHandler
from motor_controller import MotorController
from sensor_reader import SensorReader
from command_handler import CommandHandler

# -----------------------------------------------------------------------------
# Global State
# -----------------------------------------------------------------------------
running = True
program_running = False
sensor = SensorReader()
motor = MotorController(sensor_reader=sensor)
mqtt = None
handler = None


def on_emergency():
    """Emergency stop callback"""
    global program_running
    program_running = False
    motor.emergency_stop()
    cyberpi.display.show_label("⛔ STOP!", 18, "center", index=0)
    cyberpi.audio.play("wrong")
    if mqtt:
        mqtt.publish_log("Emergency stop activated")
        mqtt.publish_status("stopped")
    print("EMERGENCY STOP")


def on_command(data):
    """Handle single live command"""
    global handler
    if handler:
        result = handler.handle_command(data)
        if mqtt:
            mqtt.publish_log("Command: " + data.get("type", "unknown"))


def on_program(blocks):
    """Handle full program execution"""
    global program_running, handler
    if handler:
        program_running = True
        if mqtt:
            mqtt.publish_status("running")
            mqtt.publish_log("Program started (" + str(len(blocks)) + " blocks)")

        cyberpi.display.show_label("▶ Running\nProgram", 14, "center", index=0)

        try:
            handler.run_program(blocks)
        except Exception as e:
            print("Program error:", e)
            if mqtt:
                mqtt.publish_log("Error: " + str(e))

        program_running = False
        motor.stop()

        if mqtt:
            mqtt.publish_status("idle")
            mqtt.publish_log("Program finished")

        cyberpi.display.show_label("✅ Done!\n🤖 Ready", 14, "center", index=0)


def show_startup_screen():
    """Display startup splash screen"""
    cyberpi.display.show_label("mBot\nStudio", 20, "center", index=0)
    cyberpi.led.show("blue blue blue blue blue")
    cyberpi.audio.play("start")
    time.sleep(2)


def show_ready_screen():
    """Display ready state"""
    cyberpi.display.show_label("🤖 Ready!\nWaiting for\ncommands...", 12, "center", index=0)
    cyberpi.led.show("green green green green green")


def show_error_screen(msg):
    """Display error state"""
    cyberpi.display.show_label("❌ Error\n" + msg, 12, "center", index=0)
    cyberpi.led.show("red red red red red")


# -----------------------------------------------------------------------------
# Main Program
# -----------------------------------------------------------------------------
def main():
    global mqtt, handler, running

    show_startup_screen()

    # Initialize MQTT handler
    mqtt = MqttHandler(
        on_command=on_command,
        on_program=on_program,
        on_emergency=on_emergency
    )

    # Connect to WiFi
    if not mqtt.connect_wifi():
        show_error_screen("No WiFi")
        time.sleep(3)
        # Continue anyway - allows offline button control
        print("Running in offline mode")

    # Connect to MQTT
    mqtt_ok = False
    if cyberpi.wifi.is_connect():
        mqtt_ok = mqtt.connect_mqtt()
        if not mqtt_ok:
            show_error_screen("No MQTT")
            time.sleep(2)

    # Initialize command handler
    handler = CommandHandler(motor, sensor)

    # Publish initial status
    if mqtt_ok:
        mqtt.publish_status("ready")

    show_ready_screen()

    # -------------------------------------------------------------------------
    # Main Loop
    # -------------------------------------------------------------------------
    last_sensor_time = time.time()
    last_heartbeat_time = time.time()
    heartbeat_interval = 5  # Send heartbeat every 5 seconds
    reconnect_interval = 10
    last_reconnect_time = 0

    print("Entering main loop...")

    while running:
        try:
            # Check for MQTT messages
            if mqtt.connected:
                mqtt.check_messages()

            # Auto-reconnect MQTT if disconnected
            elif cyberpi.wifi.is_connect():
                now = time.time()
                if now - last_reconnect_time > reconnect_interval:
                    last_reconnect_time = now
                    print("Attempting MQTT reconnect...")
                    mqtt.connect_mqtt()

            # Periodic heartbeat so the server knows we're alive
            now = time.time()
            if mqtt.connected and (now - last_heartbeat_time) > heartbeat_interval:
                last_heartbeat_time = now
                status = "running" if program_running else "ready"
                mqtt.publish_status(status)

            # Periodically send sensor data
            now = time.time()
            if mqtt.connected and (now - last_sensor_time) > SENSOR_INTERVAL:
                last_sensor_time = now
                try:
                    sensor_data = sensor.read_all()
                    mqtt.publish_sensors(sensor_data)
                except:
                    pass

            # Handle CyberPi button A = emergency stop
            if cyberpi.controller.is_press("a"):
                on_emergency()
                time.sleep(0.5)  # Debounce

            # Handle CyberPi button B = show status
            if cyberpi.controller.is_press("b"):
                status = "Connected" if mqtt.connected else "Offline"
                ip = cyberpi.wifi.get_ip() if cyberpi.wifi.is_connect() else "N/A"
                cyberpi.display.show_label(
                    "Status: " + status + "\nIP: " + str(ip),
                    10, "center", index=0
                )
                time.sleep(2)
                show_ready_screen()

            # Small delay to prevent CPU hogging
            time.sleep(0.05)

        except KeyboardInterrupt:
            print("Shutting down...")
            running = False

        except Exception as e:
            print("Main loop error:", e)
            time.sleep(1)

    # Cleanup
    motor.emergency_stop()
    if mqtt:
        mqtt.publish_status("offline")
        mqtt.disconnect()

    cyberpi.display.show_label("Goodbye!", 18, "center", index=0)
    cyberpi.led.show("black black black black black")


# Run!
main()
