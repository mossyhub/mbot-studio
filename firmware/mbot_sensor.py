import mbot2
import cyberpi


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
            data["line_left"] = mbot2.line_follower.get_line(1)
            data["line_right"] = mbot2.line_follower.get_line(2)
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
        return data

    def get_distance(self):
        try:
            d = mbot2.ultrasonic2.get_distance()
            return round(d, 1) if d else 999
        except:
            return -1

    def is_obstacle(self, threshold=20):
        d = self.get_distance()
        return 0 < d < threshold

    def is_line(self, sensor="left", color="black"):
        try:
            v = mbot2.line_follower.get_line(1 if sensor == "left" else 2)
        except:
            v = -1
        return v < 50 if color == "black" else v > 50
