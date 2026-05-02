import time
import cyberpi
import json
from mbot_motor import MotorController
from mbot_sensor import SensorReader
from mbot_config import COMMAND_TIMEOUT


class CommandHandler:
    def __init__(self, motors, sensors, mqtt_client=None):
        self.motors = motors
        self.sensors = sensors
        self.mqtt = mqtt_client
        self.running_program = False
        self.stop_requested = False
        self._variables = {}

    def log(self, message):
        print(message)
        if self.mqtt:
            try:
                self.mqtt.publish_log(message)
            except:
                pass

    def handle_command(self, data):
        return self.execute(data)

    def execute(self, command):
        if isinstance(command, str):
            try:
                command = json.loads(command)
            except:
                return
        try:
            self._dispatch(command)
        except Exception as e:
            print("Cmd err:", e)
            try:
                cyberpi.display.show_label("EXEC ERR:\n" + str(e)[:40], 10, "center", index=0)
            except:
                pass
            try:
                self.motors.stop()
            except:
                pass

    # --- Variable/sensor helpers ---

    def _resolve(self, val):
        """Resolve a value: if string, look up in variables; else return as number."""
        if isinstance(val, str):
            return self._variables.get(val, 0)
        try:
            return float(val)
        except:
            return 0

    def _sensor_read(self, name):
        """Centralized sensor reading by short name."""
        if name == "distance":
            return self.sensors.get_distance()
        elif name == "line_left" or name == "line":
            return self.sensors.get_line_status()
        elif name == "line_offset":
            return self.sensors.get_line_offset()
        elif name == "brightness" or name == "light":
            return self.sensors.get_brightness()
        elif name == "loudness":
            return self.sensors.get_loudness()
        elif name == "yaw" or name == "angle":
            return self.sensors.get_yaw()
        elif name == "pitch":
            return self.sensors.get_pitch()
        elif name == "roll":
            return self.sensors.get_roll()
        elif name == "timer":
            try:
                return cyberpi.timer.get()
            except:
                return 0
        return 0

    def _compare(self, a, op, b):
        """Compare two values with an operator string."""
        try:
            a, b = float(a), float(b)
        except:
            return False
        if op == ">":
            return a > b
        elif op == "<":
            return a < b
        elif op == ">=":
            return a >= b
        elif op == "<=":
            return a <= b
        elif op == "==":
            return abs(a - b) < 0.5
        elif op == "!=":
            return abs(a - b) >= 0.5
        return False

    # --- Audio helpers ---
    # Valid cyberpi.audio.play() preset sound names (see Makeblock CyberPi docs).
    # Hyphens are required for: level-up, low-energy, prompt-tone, metal-clash,
    # glass-clink, running-water, wood-hit. We accept underscore variants and
    # common aliases and translate them to the canonical hyphenated name.
    _SOUND_ALIASES = {
        # underscore -> hyphen normalization
        "level_up": "level-up",
        "low_energy": "low-energy",
        "prompt_tone": "prompt-tone",
        "metal_clash": "metal-clash",
        "glass_clink": "glass-clink",
        "running_water": "running-water",
        "wood_hit": "wood-hit",
        # common synonyms / what AI tends to emit
        "beep": "beeps",
        "spring": "sprint",
        "scared": "warning",
        "power_up": "level-up",
        "powerup": "level-up",
        "power-up": "level-up",
        "power_down": "low-energy",
        "powerdown": "low-energy",
        "power-down": "low-energy",
        "alert": "warning",
        "happy": "yeah",
        "excited": "yeah",
        "applause": "yeah",
        "fail": "wrong",
        "win": "right",
        "success": "right",
        "error": "wrong",
        "click_sound": "click",
        "siren": "warning",
    }

    # Predefined melodies as (midi_note, beats) sequences. Beat=0 means rest.
    # cyberpi.audio.play_music(midi, beats) plays a single MIDI note.
    _MELODIES = {
        "birthday": [
            (67, 0.375), (67, 0.125), (69, 0.5), (67, 0.5), (72, 0.5), (71, 1.0),
            (67, 0.375), (67, 0.125), (69, 0.5), (67, 0.5), (74, 0.5), (72, 1.0),
            (67, 0.375), (67, 0.125), (79, 0.5), (76, 0.5), (72, 0.5), (71, 0.5), (69, 1.0),
            (77, 0.375), (77, 0.125), (76, 0.5), (72, 0.5), (74, 0.5), (72, 1.0),
        ],
        "twinkle": [
            (60, 0.5), (60, 0.5), (67, 0.5), (67, 0.5), (69, 0.5), (69, 0.5), (67, 1.0),
            (65, 0.5), (65, 0.5), (64, 0.5), (64, 0.5), (62, 0.5), (62, 0.5), (60, 1.0),
        ],
        "jingle": [
            (64, 0.25), (64, 0.25), (64, 0.5),
            (64, 0.25), (64, 0.25), (64, 0.5),
            (64, 0.25), (67, 0.25), (60, 0.375), (62, 0.125), (64, 1.0),
        ],
        "ode": [
            (64, 0.5), (64, 0.5), (65, 0.5), (67, 0.5),
            (67, 0.5), (65, 0.5), (64, 0.5), (62, 0.5),
            (60, 0.5), (60, 0.5), (62, 0.5), (64, 0.5),
            (64, 0.75), (62, 0.25), (62, 1.0),
        ],
        "scale": [(60, 0.25), (62, 0.25), (64, 0.25), (65, 0.25),
                  (67, 0.25), (69, 0.25), (71, 0.25), (72, 0.5)],
        "fanfare": [(60, 0.25), (64, 0.25), (67, 0.25), (72, 0.5), (67, 0.25), (72, 0.75)],
        "alert": [(76, 0.2), (71, 0.2), (76, 0.2), (71, 0.2), (76, 0.4)],
        "win": [(60, 0.15), (64, 0.15), (67, 0.15), (72, 0.4)],
        "lose": [(67, 0.3), (64, 0.3), (60, 0.3), (55, 0.6)],
        "power_up": [(60, 0.1), (64, 0.1), (67, 0.1), (72, 0.1), (76, 0.3)],
        "power_down": [(76, 0.1), (72, 0.1), (67, 0.1), (64, 0.1), (60, 0.3)],
        "level_up": [(60, 0.1), (67, 0.1), (72, 0.1), (76, 0.3), (79, 0.4)],
        "score": [(72, 0.15), (76, 0.15), (79, 0.4)],
    }
    # Aliases for melody names
    _MELODY_ALIASES = {
        "happy": "birthday", "happy_birthday": "birthday",
        "twinkle_twinkle": "twinkle", "star": "twinkle",
        "jingle_bells": "jingle", "christmas": "jingle",
        "ode_to_joy": "ode", "joy": "ode",
        "sad": "lose", "ba": "lose", "fail": "lose",
        "excited": "win", "victory": "win", "yay": "win",
        "powerup": "power_up", "power-up": "power_up",
        "powerdown": "power_down", "power-down": "power_down",
        "levelup": "level_up", "level-up": "level_up",
        "entertainer": "scale", "dadada": "fanfare",
        "erta": "scale", "knock": "fanfare",
        "jump_up": "power_up", "jump_down": "power_down",
    }

    def _play_sound(self, name):
        if not name:
            name = "laugh"
        key = str(name).strip().lower()
        canonical = self._SOUND_ALIASES.get(key, key)
        try:
            cyberpi.audio.play(canonical)
        except:
            # fall back to a reliable default so kids still hear something
            try:
                cyberpi.audio.play("beeps")
            except:
                pass

    def _play_melody(self, name):
        key = str(name or "birthday").strip().lower()
        key = self._MELODY_ALIASES.get(key, key)
        notes = self._MELODIES.get(key)
        if not notes:
            # unknown melody: short cheerful default
            notes = self._MELODIES["fanfare"]
        for midi, beats in notes:
            if self.stop_requested:
                break
            try:
                if midi <= 0 or beats <= 0:
                    time.sleep(max(0.05, beats))
                else:
                    cyberpi.audio.play_music(midi, beats)
            except:
                # if play_music fails for any reason, approximate with a tone
                try:
                    freq = int(440.0 * (2 ** ((midi - 69) / 12.0)))
                    cyberpi.audio.play_tone(freq, beats)
                except:
                    pass

    def _run_blocks(self, blocks):
        """Execute a list of blocks, checking stop flag."""
        for block in blocks:
            if self.stop_requested:
                break
            self._dispatch(block)

    def _interruptible_sleep(self, duration):
        """Sleep that can be interrupted by stop_requested every 50ms."""
        end = time.time() + duration
        while time.time() < end:
            if self.stop_requested:
                break
            time.sleep(0.05)

    # --- Main dispatch ---

    def _dispatch(self, cmd):
        t = cmd.get("type", "")
        p = cmd.get("params", cmd)

        # --- Movement ---
        if t == "move_forward":
            self.motors.forward(p.get("speed", 50), p.get("duration", 1))
        elif t == "move_backward":
            self.motors.backward(p.get("speed", 50), p.get("duration", 1))
        elif t == "turn_left":
            self.motors.turn_left(p.get("speed", 50), p.get("angle", 90))
        elif t == "turn_right":
            self.motors.turn_right(p.get("speed", 50), p.get("angle", 90))
        elif t == "stop":
            self.motors.stop()
        elif t == "set_speed":
            self.motors.set_speed(p.get("left", 0), p.get("right", 0))

        # --- Sensors ---
        elif t == "read_sensors":
            data = self.sensors.read_all()
            if self.mqtt:
                self.mqtt.publish_sensors(data)
        elif t == "if_obstacle":
            blocks = p.get("then", []) if self.sensors.is_obstacle(p.get("distance", 20)) else p.get("else", [])
            self._run_blocks(blocks)
        elif t == "if_line":
            detected = self.sensors.is_line()
            blocks = p.get("then", []) if detected else p.get("else", [])
            self._run_blocks(blocks)
        elif t == "if_color":
            target = p.get("color", "red")
            detected = self.sensors.is_color(target)
            blocks = p.get("then", []) if detected else p.get("else", [])
            self._run_blocks(blocks)
        elif t == "if_sensor_range":
            sensor_name = p.get("sensor", "distance")
            mn = float(p.get("min", 10))
            mx = float(p.get("max", 30))
            sv = self._sensor_read(sensor_name)
            blocks = p.get("then", []) if (mn <= sv <= mx) else p.get("else", [])
            self._run_blocks(blocks)
        elif t == "while_sensor":
            sensor_name = p.get("sensor", "distance")
            op = p.get("operator", ">")
            val = p.get("value", 20)
            mn = p.get("min", 10)
            mx = p.get("max", 30)
            while not self.stop_requested:
                sv = self._sensor_read(sensor_name)
                if op == "between":
                    if not (float(mn) <= sv <= float(mx)):
                        break
                elif not self._compare(sv, op, val):
                    break
                self._run_blocks(p.get("do", []))
                time.sleep(0.05)
        elif t == "move_until":
            direction = p.get("direction", "forward")
            speed = abs(int(p.get("speed", 50)))
            sensor_name = p.get("sensor", "distance")
            op = p.get("operator", "<")
            val = p.get("value", 20)
            mn = p.get("min", 10)
            mx = p.get("max", 30)
            if direction == "backward":
                self.motors._drive_continuous(-speed, -speed)
            else:
                self.motors._drive_continuous(speed, speed)
            while not self.stop_requested:
                sv = self._sensor_read(sensor_name)
                if op == "between":
                    if float(mn) <= sv <= float(mx):
                        break
                elif self._compare(sv, op, val):
                    break
                time.sleep(0.05)
            self.motors.stop()
        elif t == "display_value":
            sensor_name = p.get("sensor", "distance")
            label = p.get("label", sensor_name)
            sv = self._sensor_read(sensor_name)
            cyberpi.display.show_label(str(label) + ": " + str(sv), 16, "center", index=0)

        # --- Sound & Display ---
        elif t == "play_tone":
            cyberpi.audio.play_tone(p.get("frequency", 440), p.get("duration", 0.5))
        elif t == "play_sound":
            self._play_sound(p.get("sound", "laugh"))
        elif t == "play_melody":
            self._play_melody(p.get("melody", "birthday"))
        elif t == "display_text" or t == "say":
            cyberpi.display.show_label(p.get("text", ""), p.get("size", 14), "center", index=0)
        elif t == "display_image":
            image_map = {"happy": "\xf0\x9f\x98\x8a", "sad": "\xf0\x9f\x98\xa2", "heart": "\xe2\x9d\xa4\xef\xb8\x8f", "star": "\xe2\xad\x90", "arrow_up": "\xe2\xac\x86\xef\xb8\x8f", "arrow_down": "\xe2\xac\x87\xef\xb8\x8f"}
            img = p.get("image", "happy")
            cyberpi.display.show_label(image_map.get(img, img), 32, "center", index=0)
        elif t == "set_led":
            color = p.get("color", "green")
            if color == "off":
                cyberpi.led.off()
            else:
                c = color + " " + color + " " + color + " " + color + " " + color
                cyberpi.led.show(c)
        elif t == "led_effect":
            effect = p.get("effect", "rainbow")
            try:
                if effect == "rainbow":
                    cyberpi.led.rainbow_effect()
                elif effect.startswith("breathe_"):
                    cyberpi.led.breathe(effect[8:])
                else:
                    cyberpi.led.rainbow_effect()
            except:
                pass

        # --- Control Flow ---
        elif t == "wait":
            self._interruptible_sleep(p.get("duration", 1))
        elif t == "repeat":
            for _ in range(p.get("times", 1)):
                if self.stop_requested:
                    break
                self._run_blocks(p.get("do", []))
        elif t == "repeat_forever":
            while not self.stop_requested:
                self._run_blocks(p.get("do", []))
        elif t == "if_button":
            if cyberpi.controller.is_press(p.get("button", "a")):
                self._run_blocks(p.get("then", []))

        # --- Variables & Math ---
        elif t == "set_variable":
            name = p.get("name", "my_var")
            source = p.get("source", None)
            if source and source != "number":
                self._variables[name] = self._sensor_read(source)
            else:
                self._variables[name] = self._resolve(p.get("value", 0))
        elif t == "change_variable":
            name = p.get("name", "my_var")
            by = self._resolve(p.get("by", 1))
            self._variables[name] = self._variables.get(name, 0) + by
        elif t == "math_operation":
            result_name = p.get("result", "result")
            a = self._resolve(p.get("a", 0))
            b = self._resolve(p.get("b", 0))
            op = p.get("operator", "+")
            if op == "+":
                r = a + b
            elif op == "-":
                r = a - b
            elif op == "*":
                r = a * b
            elif op == "/":
                r = a / b if b != 0 else 0
            else:
                r = 0
            self._variables[result_name] = r

        # --- Hardware ---
        elif t == "dc_motor":
            self.motors.dc_motor_run(p.get("port", "M3"), p.get("speed", 50), p.get("duration", 1))
        elif t == "servo":
            self.motors.servo_set(p.get("port", "S1"), p.get("angle", 90), p.get("speed", 0))
        elif t == "emergency_stop":
            self.stop_requested = True
            self.motors.emergency_stop()

    def run_program(self, program):
        self.running_program = True
        self.stop_requested = False
        self._variables = {}
        try:
            for i, block in enumerate(program):
                if self.stop_requested:
                    break
                self._dispatch(block)
        except Exception as e:
            print("Prog err:", e)
            self.motors.emergency_stop()
        finally:
            self.running_program = False
            self.motors.stop()

    def request_stop(self):
        self.stop_requested = True
        self.motors.emergency_stop()
