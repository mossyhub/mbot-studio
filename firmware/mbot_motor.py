import mbot2
import time
from mbot_config import DEFAULT_SPEED, MAX_SPEED


class MotorController:
    def __init__(self, sensor_reader=None):
        self.is_moving = False
        self.current_speed = 0
        self.sensor = sensor_reader

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
        print("FWD s=", speed, "d=", duration)
        try:
            if duration <= 0:
                mbot2.forward(speed)
            else:
                int_d = int(duration)
                if abs(duration - int_d) < 0.01 and int_d > 0:
                    mbot2.forward(speed, int_d)
                else:
                    mbot2.forward(speed)
                    time.sleep(duration)
                    mbot2.EM_stop()
            print("FWD OK")
        except Exception as e:
            print("Fwd err:", e)
            try:
                import cyberpi
                cyberpi.display.show_label("FWD ERR:\n" + str(e)[:40], 10, "center", index=0)
            except:
                pass
            try:
                mbot2.EM_stop()
            except:
                pass
        self.is_moving = False

    def backward(self, speed=DEFAULT_SPEED, duration=1):
        speed = abs(self._clamp(speed))
        duration = self._dur(duration)
        self.is_moving = True
        print("BWD s=", speed, "d=", duration)
        try:
            if duration <= 0:
                mbot2.backward(speed)
            else:
                int_d = int(duration)
                if abs(duration - int_d) < 0.01 and int_d > 0:
                    mbot2.backward(speed, int_d)
                else:
                    mbot2.backward(speed)
                    time.sleep(duration)
                    mbot2.EM_stop()
            print("BWD OK")
        except Exception as e:
            print("Bwd err:", e)
            try:
                import cyberpi
                cyberpi.display.show_label("BWD ERR:\n" + str(e)[:40], 10, "center", index=0)
            except:
                pass
            try:
                mbot2.EM_stop()
            except:
                pass
        self.is_moving = False

    def turn_left(self, speed=DEFAULT_SPEED, angle=90):
        self.is_moving = True
        print("LEFT a=", angle)
        try:
            mbot2.turn(-int(angle))
            print("LEFT OK")
        except Exception as e:
            print("Left err:", e)
            try:
                import cyberpi
                cyberpi.display.show_label("LEFT ERR:\n" + str(e)[:40], 10, "center", index=0)
            except:
                pass
        self.is_moving = False

    def turn_right(self, speed=DEFAULT_SPEED, angle=90):
        self.is_moving = True
        print("RIGHT a=", angle)
        try:
            mbot2.turn(int(angle))
            print("RIGHT OK")
        except Exception as e:
            print("Right err:", e)
            try:
                import cyberpi
                cyberpi.display.show_label("RIGHT ERR:\n" + str(e)[:40], 10, "center", index=0)
            except:
                pass
        self.is_moving = False

    def set_speed(self, left, right):
        left = self._clamp(left)
        right = self._clamp(right)
        avg = (left + right) // 2
        try:
            if avg > 0:
                mbot2.forward(abs(avg))
            elif avg < 0:
                mbot2.backward(abs(avg))
            else:
                mbot2.EM_stop()
        except Exception as e:
            print("Spd err:", e)

    def stop(self):
        self.is_moving = False
        self.current_speed = 0
        try:
            mbot2.EM_stop()
        except Exception as e:
            print("Stop err:", e)

    def dc_motor_run(self, port, speed=DEFAULT_SPEED, duration=1):
        speed = self._clamp(speed)
        duration = self._dur(duration)
        port_map = {"M1": 1, "M2": 2, "M3": 3, "M4": 4}
        pn = port_map.get(port.upper(), 1)
        try:
            mbot2.dc_motor_set(pn, speed)
            if duration > 0:
                time.sleep(duration)
                mbot2.dc_motor_set(pn, 0)
        except Exception as e:
            print("DC err:", e)
            try:
                mbot2.dc_motor_set(pn, 0)
            except:
                pass

    def servo_set(self, port, angle=90):
        port_map = {"S1": 1, "S2": 2, "S3": 3, "S4": 4}
        pn = port_map.get(port.upper(), 1)
        angle = max(0, min(180, int(angle)))
        try:
            mbot2.servo_set(pn, angle)
        except Exception as e:
            print("Servo err:", e)

    def emergency_stop(self):
        self.is_moving = False
        self.current_speed = 0
        try:
            mbot2.EM_stop()
        except Exception as e:
            print("Estop err:", e)
        for pn in [1, 2, 3, 4]:
            try:
                mbot2.dc_motor_set(pn, 0)
            except:
                pass
