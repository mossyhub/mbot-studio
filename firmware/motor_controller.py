# =============================================================================
# mBot Studio - Motor Controller
# =============================================================================
# Handles all motor and servo operations for the mBot2
# Supports built-in encoder motors + custom DC motors and servos

import mbot2
import time
from config import DEFAULT_SPEED, MAX_SPEED, OBSTACLE_MIN_DIST


class MotorController:
    """Controls all motors and servos on the mBot2"""

    def __init__(self, sensor_reader=None):
        self.is_moving = False
        self.current_speed = 0
        self.sensor = sensor_reader  # For tracking actuator states in telemetry

    def _clamp_speed(self, speed):
        """Limit speed to safe range"""
        if speed > 0:
            return min(speed, MAX_SPEED)
        elif speed < 0:
            return max(speed, -MAX_SPEED)
        return 0

    # === Drive Motors (built-in encoder motors) ===

    def forward(self, speed=DEFAULT_SPEED, duration=1):
        """Move forward at given speed for duration seconds"""
        speed = self._clamp_speed(speed)
        self.is_moving = True
        self.current_speed = speed
        if self.sensor:
            self.sensor.set_motor_speed("drive", speed)
        mbot2.forward(speed)
        time.sleep(duration)
        self.stop()

    def backward(self, speed=DEFAULT_SPEED, duration=1):
        """Move backward at given speed for duration seconds"""
        speed = self._clamp_speed(speed)
        self.is_moving = True
        self.current_speed = -speed
        if self.sensor:
            self.sensor.set_motor_speed("drive", -speed)
        mbot2.backward(speed)
        time.sleep(duration)
        self.stop()

    def turn_left(self, speed=DEFAULT_SPEED, angle=90):
        """Turn left by given angle at given speed"""
        speed = self._clamp_speed(speed)
        self.is_moving = True
        # Approximate duration based on angle (calibrate for your robot)
        duration = angle / 90.0 * 0.8  # ~0.8s for 90 degrees at default speed
        mbot2.turn_left(speed)
        time.sleep(duration)
        self.stop()

    def turn_right(self, speed=DEFAULT_SPEED, angle=90):
        """Turn right by given angle at given speed"""
        speed = self._clamp_speed(speed)
        self.is_moving = True
        duration = angle / 90.0 * 0.8
        mbot2.turn_right(speed)
        time.sleep(duration)
        self.stop()

    def set_speed(self, left, right):
        """Set individual motor speeds (-100 to 100)"""
        left = self._clamp_speed(left)
        right = self._clamp_speed(right)
        self.is_moving = left != 0 or right != 0
        mbot2.drive_speed(left, right)

    def stop(self):
        """Stop all drive motors"""
        self.is_moving = False
        self.current_speed = 0
        if self.sensor:
            self.sensor.clear_motor_speed("drive")
        mbot2.motor_stop("all")

    # === DC Motors (custom additions) ===

    def dc_motor_run(self, port, speed=DEFAULT_SPEED, duration=1):
        """Run a DC motor on the specified port"""
        speed = self._clamp_speed(speed)
        # Port mapping: M1-M4
        port_map = {"M1": 1, "M2": 2, "M3": 3, "M4": 4}
        port_num = port_map.get(port.upper(), 1)

        try:
            if self.sensor:
                self.sensor.set_motor_speed(port.upper(), speed)
            mbot2.dc_motor_set(port_num, speed)
            if duration > 0:
                time.sleep(duration)
                mbot2.dc_motor_set(port_num, 0)
                if self.sensor:
                    self.sensor.clear_motor_speed(port.upper())
        except Exception as e:
            print("DC motor error:", e)
            mbot2.dc_motor_set(port_num, 0)
            if self.sensor:
                self.sensor.clear_motor_speed(port.upper())

    def dc_motor_stop(self, port):
        """Stop a DC motor"""
        port_map = {"M1": 1, "M2": 2, "M3": 3, "M4": 4}
        port_num = port_map.get(port.upper(), 1)
        mbot2.dc_motor_set(port_num, 0)

    # === Servos ===

    def servo_set(self, port, angle=90):
        """Set servo angle (0-180)"""
        # Port mapping: S1-S4
        port_map = {"S1": 1, "S2": 2, "S3": 3, "S4": 4}
        port_num = port_map.get(port.upper(), 1)
        angle = max(0, min(180, angle))

        try:
            mbot2.servo_set(port_num, angle)
            if self.sensor:
                self.sensor.set_servo_angle(port.upper(), angle)
        except Exception as e:
            print("Servo error:", e)

    # === Emergency ===

    def emergency_stop(self):
        """Stop EVERYTHING immediately"""
        self.is_moving = False
        self.current_speed = 0

        # Stop drive motors
        mbot2.motor_stop("all")

        # Stop all DC motor ports
        for port_num in [1, 2, 3, 4]:
            try:
                mbot2.dc_motor_set(port_num, 0)
            except:
                pass
