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
        cmd_type = command.get("type", "")
        try:
            self._dispatch(command)
        except Exception as e:
            print("Cmd err:", e)
            try:
                self.motors.stop()
            except:
                pass

    def _dispatch(self, cmd):
        t = cmd.get("type", "")
        p = cmd.get("params", cmd)

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
        elif t == "read_sensors":
            data = self.sensors.read_all()
            if self.mqtt:
                self.mqtt.publish_sensors(data)
        elif t == "play_tone":
            cyberpi.audio.play_tone(p.get("frequency", 440), p.get("duration", 0.5))
        elif t == "display_text" or t == "say":
            cyberpi.display.show_label(p.get("text", ""), p.get("size", 14), "center", index=0)
        elif t == "display_image":
            cyberpi.display.show_label(p.get("image", "?"), 32, "center", index=0)
        elif t == "wait":
            time.sleep(p.get("duration", 1))
        elif t == "repeat":
            for _ in range(p.get("times", 1)):
                if self.stop_requested:
                    break
                for block in p.get("do", []):
                    if self.stop_requested:
                        break
                    self._dispatch(block)
        elif t == "repeat_forever":
            while not self.stop_requested:
                for block in p.get("do", []):
                    if self.stop_requested:
                        break
                    self._dispatch(block)
        elif t == "if_obstacle":
            blocks = p.get("then", []) if self.sensors.is_obstacle(p.get("distance", 20)) else p.get("else", [])
            for block in blocks:
                if self.stop_requested:
                    break
                self._dispatch(block)
        elif t == "if_button":
            if cyberpi.controller.is_press(p.get("button", "a")):
                for block in p.get("then", []):
                    if self.stop_requested:
                        break
                    self._dispatch(block)
        elif t == "dc_motor":
            self.motors.dc_motor_run(p.get("port", "M3"), p.get("speed", 50), p.get("duration", 1))
        elif t == "servo":
            self.motors.servo_set(p.get("port", "S1"), p.get("angle", 90))
        elif t == "emergency_stop":
            self.stop_requested = True
            self.motors.emergency_stop()

    def run_program(self, program):
        self.running_program = True
        self.stop_requested = False
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
