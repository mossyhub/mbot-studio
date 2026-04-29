import mbot2
import time
from mbot_config import DEFAULT_SPEED, MAX_SPEED


class MotorController:
    def __init__(self, sensor_reader=None):
        self.is_moving = False
        self.current_speed = 0
        self.sensor = sensor_reader
        self._log_fn = None
        self._estop_check = None

    def set_logger(self, log_fn):
        self._log_fn = log_fn

    def _log(self, msg):
        print(msg)
        if self._log_fn:
            try:
                self._log_fn(msg)
            except:
                pass

    def _clamp(self, v):
        v = int(v) if v else 0
        if v > MAX_SPEED:
            return MAX_SPEED
        if v < -MAX_SPEED:
            return -MAX_SPEED
        return v

    def _dur(self, d):
        try:
            d = float(d)
        except:
            d = 1.0
        if d < 0:
            d = 0.0
        if d > 60:
            d = 60.0
        return d

    def forward(self, speed=DEFAULT_SPEED, duration=1):
        speed = abs(self._clamp(speed))
        duration = self._dur(duration)
        self.is_moving = True
        self._log("FWD s=" + str(speed) + " d=" + str(duration))
        try:
            self._drive(speed, speed, duration)
        except Exception as e:
            self._log("Fwd err: " + str(e))
            try:
                mbot2.EM_stop()
            except:
                pass
        self.is_moving = False

    def backward(self, speed=DEFAULT_SPEED, duration=1):
        speed = abs(self._clamp(speed))
        duration = self._dur(duration)
        self.is_moving = True
        self._log("BWD s=" + str(speed) + " d=" + str(duration))
        try:
            self._drive(-speed, -speed, duration)
        except Exception as e:
            self._log("Bwd err: " + str(e))
            try:
                mbot2.EM_stop()
            except:
                pass
        self.is_moving = False

    def turn_left(self, speed=DEFAULT_SPEED, angle=90):
        self.is_moving = True
        speed = abs(self._clamp(speed)) or DEFAULT_SPEED
        angle = abs(int(angle))
        self._log("LEFT a=" + str(angle) + " s=" + str(speed))
        try:
            self._turn(-1, speed, angle)
        except Exception as e:
            self._log("Left err: " + str(e))
            self.stop()
        self.is_moving = False

    def turn_right(self, speed=DEFAULT_SPEED, angle=90):
        self.is_moving = True
        speed = abs(self._clamp(speed)) or DEFAULT_SPEED
        angle = abs(int(angle))
        self._log("RIGHT a=" + str(angle) + " s=" + str(speed))
        try:
            self._turn(1, speed, angle)
        except Exception as e:
            self._log("Right err: " + str(e))
            self.stop()
        self.is_moving = False

    def _turn(self, direction, speed, angle):
        """Turn using mbot2.turn() built-in. direction: 1=right, -1=left.
        Estimates duration from angle for estop polling."""
        degrees_per_sec = speed * 1.8  # rough calibration factor
        duration = angle / max(degrees_per_sec, 1)
        duration = min(duration, 30)  # safety cap at 30 seconds
        try:
            mbot2.turn(angle * direction)
        except Exception as e:
            self._log("Turn err: " + str(e))
            self.stop()
            return
        end = time.time() + duration
        while time.time() < end:
            if self._estop_check and self._estop_check():
                self.stop()
                break
            time.sleep(0.05)

    def set_speed(self, left, right):
        left = self._clamp(left)
        right = self._clamp(right)
        self._log("SPD l=" + str(left) + " r=" + str(right))
        try:
            self._drive_continuous(left, right)
        except Exception as e:
            self._log("Spd err: " + str(e))

    def stop(self):
        self.is_moving = False
        self.current_speed = 0
        try:
            mbot2.EM_stop()
        except:
            pass
        try:
            mbot2.starter_shield.dc_motor_stop()
        except:
            pass

    def dc_motor_run(self, port, speed=DEFAULT_SPEED, duration=1):
        speed = self._clamp(speed)
        duration = self._dur(duration)
        port_map = {"M1": 1, "M2": 2, "M3": 3, "M4": 4}
        pn = port_map.get(str(port).upper(), 1)
        self._log("DC p=" + str(pn) + " s=" + str(speed) + " d=" + str(duration))
        try:
            mbot2.starter_shield.dc_motor_set_power(pn, speed)
            if duration > 0:
                end = time.time() + duration
                while time.time() < end:
                    if self._estop_check and self._estop_check():
                        break
                    time.sleep(0.05)
                mbot2.starter_shield.dc_motor_set_power(pn, 0)
        except Exception as e:
            self._log("DC err: " + str(e))
            try:
                mbot2.starter_shield.dc_motor_set_power(pn, 0)
            except:
                pass

    def servo_set(self, port, angle=90):
        port_map = {"S1": 1, "S2": 2, "S3": 3, "S4": 4}
        pn = port_map.get(str(port).upper(), 1)
        angle = max(0, min(180, int(angle)))
        self._log("SERVO p=" + str(pn) + " a=" + str(angle))
        try:
            mbot2.starter_shield.servo_set_angle(pn, angle)
        except Exception as e:
            self._log("Servo err: " + str(e))

    def emergency_stop(self):
        self.is_moving = False
        self.current_speed = 0
        try:
            mbot2.EM_stop()
        except:
            pass
        try:
            mbot2.starter_shield.dc_motor_stop()
        except:
            pass
        for pn in [1, 2, 3, 4]:
            try:
                mbot2.starter_shield.dc_motor_set_power(pn, 0)
            except:
                pass

    # ---- Core drive methods: try multiple mbot2 APIs ----

    def _drive(self, left_speed, right_speed, duration):
        """Drive both wheels. Uses mbot2.forward/backward (known working on CyberPi)."""
        self.current_speed = (abs(left_speed) + abs(right_speed)) // 2
        avg = (left_speed + right_speed) // 2
        try:
            if avg >= 0:
                mbot2.forward(abs(avg))
            else:
                mbot2.backward(abs(avg))
        except Exception as e:
            self._log("Drive err: " + str(e))
            return

        # Poll-wait for duration, checking estop callback every 50ms
        if duration > 0:
            end = time.time() + duration
            while time.time() < end:
                if self._estop_check and self._estop_check():
                    break
                time.sleep(0.05)
            self.stop()

    def _drive_continuous(self, left_speed, right_speed):
        """Start driving without stopping (for set_speed)."""
        if left_speed == 0 and right_speed == 0:
            self.stop()
            return
        avg = (left_speed + right_speed) // 2
        try:
            if avg >= 0:
                mbot2.forward(abs(avg))
            else:
                mbot2.backward(abs(avg))
        except:
            pass

    def run_diagnostic(self):
        """Run a motor diagnostic sequence, logging results via MQTT.
        Returns a list of test results."""
        import cyberpi
        results = []

        cyberpi.display.show_label("MOTOR\nDIAG...", 16, "center", index=0)
        self._log("=== Motor Diagnostic Start ===")

        # Test 1: mbot2.forward() high-level API
        self._log("Test 1: mbot2.forward(30)")
        try:
            mbot2.forward(30)
            time.sleep(0.5)
            mbot2.EM_stop()
            results.append("forward(30): OK")
            self._log("Test 1: OK")
        except Exception as e:
            results.append("forward(30): FAIL " + str(e))
            self._log("Test 1: FAIL " + str(e))
        time.sleep(0.3)

        # Test 2: mbot2.drive_speed()
        self._log("Test 2: mbot2.drive_speed(30, 30)")
        try:
            mbot2.drive_speed(30, 30)
            time.sleep(0.5)
            mbot2.EM_stop()
            results.append("drive_speed(30,30): OK")
            self._log("Test 2: OK")
        except Exception as e:
            results.append("drive_speed: FAIL " + str(e))
            self._log("Test 2: FAIL " + str(e))
        time.sleep(0.3)

        # Test 3: mbot2.EM_set_speed()
        self._log("Test 3: mbot2.EM_set_speed(30, 30)")
        try:
            mbot2.EM_set_speed(30, 30)
            time.sleep(0.5)
            mbot2.EM_stop()
            results.append("EM_set_speed(30,30): OK")
            self._log("Test 3: OK")
        except Exception as e:
            results.append("EM_set_speed: FAIL " + str(e))
            self._log("Test 3: FAIL " + str(e))
        time.sleep(0.3)

        # Test 4: mbot2.backward()
        self._log("Test 4: mbot2.backward(30)")
        try:
            mbot2.backward(30)
            time.sleep(0.5)
            mbot2.EM_stop()
            results.append("backward(30): OK")
            self._log("Test 4: OK")
        except Exception as e:
            results.append("backward: FAIL " + str(e))
            self._log("Test 4: FAIL " + str(e))
        time.sleep(0.3)

        # Test 5: mbot2.turn()
        self._log("Test 5: mbot2.turn(45)")
        try:
            mbot2.turn(45)
            time.sleep(0.5)
            mbot2.EM_stop()
            results.append("turn(45): OK")
            self._log("Test 5: OK")
        except Exception as e:
            results.append("turn: FAIL " + str(e))
            self._log("Test 5: FAIL " + str(e))

        self.stop()
        summary = " | ".join(results)
        self._log("=== Diagnostic Done: " + summary + " ===")
        cyberpi.display.show_label("DIAG DONE\nSee log", 12, "center", index=0)
        return results
