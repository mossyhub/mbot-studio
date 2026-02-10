# =============================================================================
# mBot Studio - Sensor Reader
# =============================================================================
# Reads data from all mBot2 sensors and returns structured data

import mbot2
import cyberpi


class SensorReader:
    """Reads all available sensors on the mBot2"""

    def __init__(self):
        self._servo_angles = {}  # Cache last-set servo angles (no readback on mBot2)
        self._motor_speeds = {}  # Cache last-set motor speeds

    def read_all(self):
        """Read all sensors and return a dictionary"""
        data = {}

        # == Distance / Ultrasonic ==
        try:
            data["distance"] = self.get_distance()
        except:
            data["distance"] = -1

        # == Line Follower ==
        try:
            data["line_left"] = self.get_line_left()
            data["line_right"] = self.get_line_right()
        except:
            data["line_left"] = -1
            data["line_right"] = -1

        # == Color Sensor ==
        try:
            data["color"] = self.get_color()
        except:
            data["color"] = "unknown"

        # == Gyroscope / IMU ==
        try:
            data["gyro_x"] = round(cyberpi.get_rotation("x"), 1)
            data["gyro_y"] = round(cyberpi.get_rotation("y"), 1)
            data["gyro_z"] = round(cyberpi.get_rotation("z"), 1)
        except:
            data["gyro_x"] = 0
            data["gyro_y"] = 0
            data["gyro_z"] = 0

        # == Accelerometer ==
        try:
            data["accel_x"] = round(cyberpi.get_acceleration("x"), 2)
            data["accel_y"] = round(cyberpi.get_acceleration("y"), 2)
            data["accel_z"] = round(cyberpi.get_acceleration("z"), 2)
        except:
            pass

        # == Tilt / Shake ==
        try:
            data["is_shaking"] = cyberpi.get_shakeval() > 20
            data["shake_strength"] = cyberpi.get_shakeval()
        except:
            data["is_shaking"] = False
            data["shake_strength"] = 0

        try:
            data["tilt_left"] = cyberpi.is_tiltleft()
            data["tilt_right"] = cyberpi.is_tiltright()
            data["tilt_forward"] = cyberpi.is_tiltforward()
            data["tilt_backward"] = cyberpi.is_tiltbackward()
            data["face_up"] = cyberpi.is_faceup()
        except:
            pass

        # == Loudness / Microphone ==
        try:
            data["loudness"] = cyberpi.get_loudness()
        except:
            data["loudness"] = 0

        # == Light / Brightness ==
        try:
            data["brightness"] = cyberpi.get_bri()
        except:
            data["brightness"] = 0

        # == Battery ==
        try:
            data["battery"] = cyberpi.get_battery()
        except:
            data["battery"] = -1

        # == Timer ==
        try:
            data["timer"] = round(cyberpi.get_timer(), 1)
        except:
            pass

        # == Buttons ==
        try:
            data["button_a"] = cyberpi.controller.is_press("a")
            data["button_b"] = cyberpi.controller.is_press("b")
        except:
            pass

        # == Cached actuator states (what we last commanded) ==
        if self._servo_angles:
            data["servos"] = dict(self._servo_angles)
        if self._motor_speeds:
            data["motors"] = dict(self._motor_speeds)

        return data

    def get_distance(self):
        """Get ultrasonic distance in cm"""
        try:
            dist = mbot2.ultrasonic2.get_distance()
            return round(dist, 1) if dist else 999
        except:
            return -1

    def get_line_left(self):
        """Get left line sensor value (0-100)"""
        try:
            return mbot2.line_follower.get_line(1)
        except:
            return -1

    def get_line_right(self):
        """Get right line sensor value (0-100)"""
        try:
            return mbot2.line_follower.get_line(2)
        except:
            return -1

    def get_color(self):
        """Get detected color name"""
        try:
            return mbot2.color_sensor.get_color()
        except:
            return "unknown"

    def is_obstacle(self, threshold=20):
        """Check if obstacle is within threshold cm"""
        dist = self.get_distance()
        return 0 < dist < threshold

    def is_line(self, sensor="left", color="black"):
        """Check if line sensor detects specified color"""
        value = self.get_line_left() if sensor == "left" else self.get_line_right()
        if color == "black":
            return value < 50
        else:
            return value > 50

    # === Actuator state tracking ===
    def set_servo_angle(self, port, angle):
        """Cache the last-commanded servo angle for telemetry"""
        self._servo_angles[port] = angle

    def set_motor_speed(self, port, speed):
        """Cache the last-commanded motor speed for telemetry"""
        self._motor_speeds[port] = speed

    def clear_motor_speed(self, port):
        """Clear a motor speed when stopped"""
        self._motor_speeds.pop(port, None)
