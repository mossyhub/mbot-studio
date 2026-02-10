# =============================================================================
# mBot Studio - Command Handler
# =============================================================================
# Interprets and executes commands received from the server via MQTT
# Commands are JSON objects with a "type" field

import time
import cyberpi
import json
from motor_controller import MotorController
from sensor_reader import SensorReader
from config import COMMAND_TIMEOUT


class CommandHandler:
    """Processes commands from mBot Studio server"""

    def __init__(self, motors, sensors, mqtt_client=None):
        self.motors = motors
        self.sensors = sensors
        self.mqtt = mqtt_client
        self.running_program = False
        self.stop_requested = False

    def log(self, message):
        """Send log message back to server"""
        print(message)
        if self.mqtt:
            try:
                self.mqtt.publish_log(message)
            except:
                pass

    def execute(self, command):
        """Execute a single command"""
        if isinstance(command, str):
            try:
                command = json.loads(command)
            except:
                self.log("Invalid command format")
                return

        cmd_type = command.get("type", "")
        self.log("Executing: " + cmd_type)

        try:
            self._dispatch(command)
        except Exception as e:
            self.log("Error: " + str(e))
            self.motors.emergency_stop()

    def _dispatch(self, cmd):
        """Route command to the right handler"""
        t = cmd.get("type", "")
        params = cmd.get("params", cmd)  # Support both {type, params} and flat format

        # === Movement ===
        if t == "move_forward":
            self.motors.forward(
                speed=params.get("speed", 50),
                duration=params.get("duration", 1)
            )

        elif t == "move_backward":
            self.motors.backward(
                speed=params.get("speed", 50),
                duration=params.get("duration", 1)
            )

        elif t == "turn_left":
            self.motors.turn_left(
                speed=params.get("speed", 50),
                angle=params.get("angle", 90)
            )

        elif t == "turn_right":
            self.motors.turn_right(
                speed=params.get("speed", 50),
                angle=params.get("angle", 90)
            )

        elif t == "stop":
            self.motors.stop()

        elif t == "set_speed":
            self.motors.set_speed(
                left=params.get("left", 0),
                right=params.get("right", 0)
            )

        # === Sensors ===
        elif t == "read_sensors":
            data = self.sensors.read_all()
            if self.mqtt:
                self.mqtt.publish_sensors(data)
            return data

        elif t == "get_distance":
            return self.sensors.get_distance()

        # === Sound & Display ===
        elif t == "play_tone":
            cyberpi.audio.play_tone(
                params.get("frequency", 440),
                params.get("duration", 0.5)
            )

        elif t == "play_melody":
            melody = params.get("melody", "happy")
            melodies = {
                "happy": "birthday",
                "excited": "power_up",
                "alert": "alert",
            }
            cyberpi.audio.play_melody(melodies.get(melody, "birthday"))

        elif t == "display_text":
            text = params.get("text", "")
            size = params.get("size", 16)
            cyberpi.display.show_label(text, size, "center", index=0)

        elif t == "display_image":
            image = params.get("image", "happy")
            emojis = {
                "happy": "😊", "sad": "😢", "heart": "❤️",
                "star": "⭐", "arrow_up": "⬆️", "arrow_down": "⬇️",
                "excited": "🤩", "sleepy": "😴", "alert": "😮",
                "cool": "😎", "love": "😍", "thinking": "🤔",
                "laugh": "😄", "surprise": "😲", "wink": "😉",
                "party": "🥳", "robot": "🤖", "fire": "🔥",
            }
            cyberpi.display.show_label(
                emojis.get(image, "🤖"), 32, "center", index=0
            )

        elif t == "robot_expression":
            # Animated expression: show emoji + play matching tone
            expression = params.get("expression", "happy")
            expr_map = {
                "happy":    ("😊", 523),
                "excited":  ("🤩", 784),
                "sad":      ("😢", 262),
                "alert":    ("😮", 880),
                "sleepy":   ("😴", 196),
                "cool":     ("😎", 659),
                "love":     ("😍", 698),
                "thinking": ("🤔", 440),
                "party":    ("🥳", 1047),
            }
            emoji, tone = expr_map.get(expression, ("🤖", 440))
            cyberpi.display.show_label(emoji, 40, "center", index=0)
            cyberpi.audio.play_tone(tone, 0.2)

        elif t == "say":
            cyberpi.display.show_label(params.get("text", ""), 14, "center", index=0)

        # === Control Flow ===
        elif t == "wait":
            time.sleep(params.get("duration", 1))

        elif t == "repeat":
            times = params.get("times", 1)
            do_blocks = params.get("do", [])
            for _ in range(times):
                if self.stop_requested:
                    break
                for block in do_blocks:
                    if self.stop_requested:
                        break
                    self._dispatch(block)

        elif t == "repeat_forever":
            do_blocks = params.get("do", [])
            while not self.stop_requested:
                for block in do_blocks:
                    if self.stop_requested:
                        break
                    self._dispatch(block)

        # === Conditionals ===
        elif t == "if_obstacle":
            dist = params.get("distance", 20)
            if self.sensors.is_obstacle(dist):
                for block in params.get("then", []):
                    if self.stop_requested:
                        break
                    self._dispatch(block)
            else:
                for block in params.get("else", []):
                    if self.stop_requested:
                        break
                    self._dispatch(block)

        elif t == "if_line":
            sensor = params.get("sensor", "left")
            color = params.get("color", "black")
            if self.sensors.is_line(sensor, color):
                for block in params.get("then", []):
                    if self.stop_requested:
                        break
                    self._dispatch(block)
            else:
                for block in params.get("else", []):
                    if self.stop_requested:
                        break
                    self._dispatch(block)

        elif t == "if_color":
            detected = self.sensors.get_color()
            target = params.get("color", "red")
            if detected == target:
                for block in params.get("then", []):
                    if self.stop_requested:
                        break
                    self._dispatch(block)
            else:
                for block in params.get("else", []):
                    if self.stop_requested:
                        break
                    self._dispatch(block)

        elif t == "if_button":
            button = params.get("button", "a")
            if cyberpi.controller.is_press(button):
                for block in params.get("then", []):
                    if self.stop_requested:
                        break
                    self._dispatch(block)

        # === Custom Hardware ===
        elif t == "dc_motor":
            self.motors.dc_motor_run(
                port=params.get("port", "M3"),
                speed=params.get("speed", 50),
                duration=params.get("duration", 1)
            )

        elif t == "servo":
            self.motors.servo_set(
                port=params.get("port", "S1"),
                angle=params.get("angle", 90)
            )

        # === Emergency ===
        elif t == "emergency_stop":
            self.stop_requested = True
            self.motors.emergency_stop()
            cyberpi.display.show_label("STOPPED!", 20, "center", index=0)
            self.log("Emergency stop executed")

        else:
            self.log("Unknown command: " + t)

    def run_program(self, program):
        """Execute a full program (list of commands)"""
        self.running_program = True
        self.stop_requested = False

        # Show excited expression when starting
        cyberpi.display.show_label("🤩", 40, "center", index=0)
        cyberpi.audio.play_tone(784, 0.15)
        time.sleep(0.3)
        cyberpi.display.show_label("Running...", 16, "center", index=0)
        self.log("Program started ({} blocks)".format(len(program)))

        try:
            for i, block in enumerate(program):
                if self.stop_requested:
                    self.log("Program stopped at block " + str(i))
                    break
                self._dispatch(block)
        except Exception as e:
            self.log("Program error: " + str(e))
            self.motors.emergency_stop()
            # Show sad face on error
            cyberpi.display.show_label("😢", 40, "center", index=0)
            time.sleep(0.5)
        finally:
            self.running_program = False
            self.motors.stop()
            if not self.stop_requested:
                # Happy celebration on success!
                cyberpi.display.show_label("🥳", 40, "center", index=0)
                cyberpi.audio.play_tone(523, 0.15)
                time.sleep(0.15)
                cyberpi.audio.play_tone(659, 0.15)
                time.sleep(0.15)
                cyberpi.audio.play_tone(784, 0.25)
                time.sleep(0.4)
            cyberpi.display.show_label("Done! ✓", 16, "center", index=0)
            self.log("Program complete")

    def request_stop(self):
        """Request program to stop"""
        self.stop_requested = True
        self.motors.emergency_stop()
