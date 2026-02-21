import mbot2
import cyberpi
import mbuild


class SensorReader:
    def __init__(self):
        pass

    def read_all(self):
        data = {}
        try:
            data["distance"] = self.get_distance()
        except:
            data["distance"] = -1
        try:
            data["line_status"] = mbuild.dual_rgb_sensor.get_line_sta()
        except:
            pass
        try:
            data["battery"] = cyberpi.get_battery()
        except:
            pass
        try:
            data["loudness"] = cyberpi.get_loudness()
        except:
            pass
        try:
            data["brightness"] = cyberpi.get_brightness()
        except:
            pass
        try:
            data["yaw"] = cyberpi.get_yaw()
        except:
            pass
        return data

    def get_distance(self):
        try:
            d = mbuild.ultrasonic2.get()
            return round(d, 1) if d else 999
        except:
            return -1

    def is_obstacle(self, threshold=20):
        d = self.get_distance()
        return 0 < d < threshold

    def get_line_status(self):
        try:
            return mbuild.dual_rgb_sensor.get_line_sta()
        except:
            return -1

    def is_line(self, sensor="left"):
        try:
            return mbuild.dual_rgb_sensor.is_line()
        except:
            return False

    def is_background(self):
        try:
            return mbuild.dual_rgb_sensor.is_background()
        except:
            return False

    def get_line_offset(self):
        try:
            return mbuild.dual_rgb_sensor.get_offset_track()
        except:
            return 0

    def get_color(self, port="L1"):
        try:
            return mbuild.quad_rgb_sensor.get_color(port)
        except:
            try:
                return mbuild.dual_rgb_sensor.get_color()
            except:
                return "unknown"

    def is_color(self, color, port="L1"):
        try:
            return mbuild.quad_rgb_sensor.is_color(color, port)
        except:
            try:
                return mbuild.dual_rgb_sensor.is_color(color)
            except:
                return False

    def get_brightness(self):
        try:
            return cyberpi.get_brightness()
        except:
            return 0

    def get_loudness(self):
        try:
            return cyberpi.get_loudness()
        except:
            return 0

    def get_yaw(self):
        try:
            return cyberpi.get_yaw()
        except:
            return 0

    def get_pitch(self):
        try:
            return cyberpi.get_pitch()
        except:
            return 0

    def get_roll(self):
        try:
            return cyberpi.get_roll()
        except:
            return 0
