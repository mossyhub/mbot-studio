import time
import cyberpi


class CyberPiDashboard:
    def __init__(self):
        self.wifi_connected = False
        self.ip = "N/A"
        self.mqtt_connected = False
        self._lock_until = 0
        self._dirty = True

    def lock(self, seconds):
        self._lock_until = time.time() + seconds

    def unlock(self):
        self._lock_until = 0

    def set_wifi(self, connected, ip=None):
        self.wifi_connected = bool(connected)
        if ip:
            self.ip = str(ip)
        if not connected:
            self.ip = "N/A"
        self._dirty = True

    def set_mqtt(self, connected):
        self.mqtt_connected = bool(connected)
        self._dirty = True

    def note_rx(self, label):
        self._dirty = True

    def note_tx(self, label):
        self._dirty = True

    def render(self, force=False):
        now = time.time()
        if not force:
            if now < self._lock_until:
                return
            if not self._dirty:
                return
        w = "OK" if self.wifi_connected else "--"
        m = "OK" if self.mqtt_connected else "--"
        cyberpi.display.show_label(
            "W:" + w + " M:" + m + "\n" + str(self.ip),
            10, "center", index=0
        )
        self._dirty = False
