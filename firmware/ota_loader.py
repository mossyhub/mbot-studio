"""Commissioning-only cooperative OTA runtime; never a robot command bridge.

Provisioning constants are inlined by the USB bootstrap builder. This module
has no hardware side effects on import. Uploaded apps are trusted, not sandboxed.
"""
from ota_core import OtaEngine
import hashlib
import binascii
import json
import os
from collections import namedtuple

# Named tuple offers immutable public identity, never engine/WDT handles.
AppContext = namedtuple("AppContext", ("device", "boot", "sha256", "loader", "protocol", "disarmed"))


def read_verified_source(root, selected, open_file=open, sha_factory=hashlib.sha256):
    """Hash the exact bounded bytes later executed, not a second file open."""
    slot, size, expected = selected.get("slot"), selected.get("size"), selected.get("sha256")
    if slot not in ("a", "b") or type(size) is not int or not 1 <= size <= 131072:
        raise ValueError("invalid_descriptor")
    if not isinstance(expected, str) or len(expected) != 64:
        raise ValueError("invalid_descriptor")
    try:
        if binascii.hexlify(binascii.unhexlify(expected)).decode() != expected:
            raise ValueError("invalid_descriptor")
    except (ValueError, TypeError):
        raise ValueError("invalid_descriptor")
    digest = sha_factory()
    parts, count = [], 0
    with open_file(root + "/app_" + slot + ".py", "rb") as source:
        while True:
            block = source.read(min(1024, size + 1 - count))
            if not block:
                break
            count += len(block)
            if count > size:
                raise ValueError("size_mismatch")
            digest.update(block)
            parts.append(block)
    if count != size or binascii.hexlify(digest.digest()).decode() != expected:
        raise ValueError("integrity_mismatch")
    return b"".join(parts)


def load_application(root, selected, reader=read_verified_source, executor=exec):
    """Caller MUST arm native watchdog before this function, including exec."""
    source = reader(root, selected)
    namespace = {"__name__": "ota_application"}
    executor(source, namespace)
    if type(namespace.get("OTA_APP_PROTOCOL")) is not int or namespace["OTA_APP_PROTOCOL"] != 1:
        raise ValueError("app_protocol")
    if not callable(namespace.get("ota_init")) or not callable(namespace.get("ota_step")):
        raise ValueError("app_interface")
    return namespace


class Mailbox:
    """Callback does no JSON, filesystem work or execution."""
    def __init__(self, topic, capacity=2, max_payload=8192):
        self.topic = topic
        self.capacity = capacity
        self.max_payload = max_payload
        self.items = []

    def put(self, topic, payload):
        if topic != self.topic or not isinstance(payload, bytes):
            return False
        if len(payload) > self.max_payload or len(self.items) >= self.capacity:
            return False
        self.items.append(payload)
        return True

    def pop(self):
        if self.items:
            return self.items.pop(0)
        return None


class MqttTransport:
    """Scheduled simple_mqtt/umqtt adapter, never a cloud fallback.

    Each service does at most one connect and one check_msg. Native vendor Wi-Fi,
    DNS and MQTT internals may block; native WDT is the final runtime bound,
    not evidence that these libraries or physical power-cut recovery work.
    Library packet allocation precedes callback limits (broker must be trusted).
    """
    def __init__(self, wifi, client_factory, mailbox, ssid, password, broker,
                 port, base_topic, client_id, ticks_diff, report):
        self.wifi, self.client_factory, self.mailbox = wifi, client_factory, mailbox
        self.ssid, self.password, self.broker, self.port = ssid, password, broker, port
        self.base_topic, self.client_id = base_topic, client_id
        self.ticks_diff, self.report = ticks_diff, report
        self.client, self.connected = None, False
        self.last_wifi, self.last_attempt, self.now = None, None, 0

    def drop(self):
        self.connected = False
        self.last_attempt = self.now
        if self.client:
            try:
                self.client.sock.close()
            except Exception:
                pass
        self.client = None

    def service(self, now):
        self.now = now
        try:
            if not self.wifi.is_connect():
                if self.client:
                    self.drop()
                if self.last_wifi is None or self.ticks_diff(now, self.last_wifi) >= 10000:
                    self.last_wifi = now
                    self.wifi.connect(self.ssid, self.password)
                return False
            if not self.connected:
                if self.last_attempt is not None and self.ticks_diff(now, self.last_attempt) < 2000:
                    return False
                self.last_attempt = now
                self.client = self.client_factory(self.client_id.encode(), self.broker,
                                                  port=self.port, keepalive=30)
                self.client.set_callback(self.mailbox.put)
                self.client.connect(clean_session=True)
                self.client.sock.settimeout(1)
                self.client.subscribe(self.mailbox.topic, qos=0)
                self.connected = True
                self.report("mqtt_connected")
            self.client.check_msg()
            return True
        except Exception:
            self.drop()
            self.report("network_retry")
            return False

    def publish(self, suffix, envelope):
        if not self.connected or suffix not in ("hello", "response"):
            return False
        try:
            # check_msg may restore blocking mode internally; restore our bound.
            self.client.sock.settimeout(1)
            self.client.publish((self.base_topic + "/" + suffix).encode(),
                                json.dumps(envelope).encode(), retain=False, qos=0)
            return True
        except Exception:
            self.drop()
            self.report("network_retry")
            return False


class Controller:
    """One service attempt and one app step per cycle; no callback execution."""
    def __init__(self, engine, transport, mailbox, root, identity,
                 watchdog_factory, reset, prepare_app, ticks_diff, report):
        self.engine, self.transport, self.mailbox = engine, transport, mailbox
        self.root, self.context = root, identity
        self.watchdog_factory, self.reset = watchdog_factory, reset
        self.prepare_app, self.ticks_diff, self.report = prepare_app, ticks_diff, report
        self.started, self.healthy, self.failed = False, False, False
        self.watchdog, self.app, self.last_hello = None, None, None
        self.pending_response = None

    def fail(self, code):
        # Trial exceptions reset for persisted rollback. Confirmed-app exceptions
        # stay in recovery so a replacement can arrive instead of a reboot loop.
        # Native hangs still rely on WDT; confirmed native-hang loops are not solved.
        self.app = None
        self.healthy = False
        self.engine.healthy = False
        self.report(code)
        if self.engine.trial and self.engine.trial.get("attempted"):
            self.failed = True
            self.reset()

    def start(self):
        if self.started:
            raise RuntimeError("already_started")
        self.started = True
        try:
            selected = self.engine.boot_selection()
            try:
                self.watchdog = self.watchdog_factory(timeout=8000)
                if not callable(getattr(self.watchdog, "feed", None)):
                    raise ValueError("watchdog_unavailable")
            except Exception:
                self.watchdog = None
                self.report("watchdog_unavailable_recovery")
                return
            if selected:
                self.context = AppContext(self.context["device"], self.context["boot"],
                                          selected["sha256"], "1", 1, True)
                self.app = self.prepare_app(self.root, selected)
                self.app["ota_init"](self.context)
        except Exception:
            self.fail("app_start_failed")

    def cycle(self, now):
        if self.failed:
            return
        try:
            self._cycle(now)
        except Exception:
            self.fail("runtime_failed")

    def _cycle(self, now):
        connected = self.transport.service(now)
        if self.app:
            self.app["ota_step"](self.context)
            if not self.healthy:
                if self.engine.mark_healthy() is False:
                    raise ValueError("health_refused")
                self.healthy = True
        if connected:
            if self.pending_response is None:
                payload = self.mailbox.pop()
                if payload is not None:
                    # Engine owns bounded native parsing in the main loop;
                    # callback only queues bytes.
                    self.pending_response = self.engine.handle(payload)
            if self.pending_response is not None:
                response = self.pending_response
                if self.transport.publish("response", response):
                    self.pending_response = None
                    body = json.loads(response["body"])
                    if (response.get("op") in ("activate", "rollback")
                            and body.get("ok") is True
                            and body.get("result", {}).get("restart") is True):
                        self.failed = True
                        self.reset()
                        return
        if connected and (self.last_hello is None or self.ticks_diff(now, self.last_hello) >= 5000):
            if self.transport.publish("hello", self.engine.hello()):
                self.last_hello = now
        if self.watchdog:
            self.watchdog.feed()


def best_effort_stop(stop_wheels, stop_dc, report):
    """Two independent stop-only attempts; NOT proof of actuator safety."""
    for stop, error in ((stop_wheels, "wheel_stop_failed"), (stop_dc, "dc_stop_failed")):
        try:
            stop()
        except Exception:
            report(error)


def _stop_wheels():
    import mbot2
    mbot2.EM_stop()


def _stop_dc():
    import mbot2
    mbot2.starter_shield.dc_motor_stop()


def report_status(code, display):
    print("OTA:", code)
    try:
        display("OTA: " + code)
    except Exception:
        pass


def _native_report(code):
    import cyberpi
    report_status(code, lambda text: cyberpi.display.show_label(text, 12, "center", index=0))


def _native_adapters():
    # Only main reaches native imports; no tests emulate cyberpi or import apps
    # with pretend hardware. Native call bounds still require commissioning.
    import cyberpi
    import machine
    import time
    import os
    try:
        from simple_mqtt import MQTTClient
    except ImportError:
        from umqtt.simple import MQTTClient
    try:
        import socket
        socket.setdefaulttimeout(2)
    except (ImportError, AttributeError):
        # MicroPython variants lack the global timeout setter. Native WDT
        # bounds connect/DNS/check_msg, not just candidate code, when available.
        pass
    return {"wifi": cyberpi.wifi, "mqtt_factory": MQTTClient,
            "engine_factory": OtaEngine, "transport_factory": MqttTransport,
            "watchdog_factory": getattr(machine, "WDT", None), "reset": machine.reset,
            "urandom": os.urandom, "ticks_ms": time.ticks_ms,
            "ticks_diff": time.ticks_diff, "sleep_ms": time.sleep_ms, "report": _native_report}


def ensure_root(root):
    """Create only an absent directory; preserve existing files and metadata."""
    try:
        mode = os.stat(root)[0]
    except OSError as error:
        if not error.args or error.args[0] != 2:
            raise
        os.mkdir(root)
        mode = os.stat(root)[0]
    if mode & 0xf000 != 0x4000:
        raise ValueError("ota_root_not_directory")


def main(adapters=None, cycles=None):
    """Native entrypoint; optional injected adapters/cycle bound are host-only.

    Bootstrap constants MUST be supplied inline; no credentials or broker
    defaults, provisioning imports, remote config, or legacy subscriptions.
    The only infinite loop belongs to the loader, never to the diagnostic app.
    """
    if adapters is None:
        _native_report("bootstrap_starting")
        best_effort_stop(_stop_wheels, _stop_dc, _native_report)
        try:
            adapters = _native_adapters()
        except Exception:
            _native_report("native_adapters_unavailable")
            return None
    else:
        best_effort_stop(adapters["stop_wheels"], adapters["stop_dc"], adapters["report"])
    report = adapters["report"]
    try:
        nonce = adapters["urandom"](16)
        if not isinstance(nonce, bytes) or len(nonce) != 16:
            raise ValueError("boot_entropy")
        boot = binascii.hexlify(nonce).decode()
        root = "/flash/mbot_ota"
        adapters.get("ensure_root", ensure_root)(root)
        engine = adapters["engine_factory"](root, OTA_DEVICE, boot)
        base = MQTT_TOPIC_PREFIX + "/ota/" + OTA_DEVICE
        mailbox = Mailbox((base + "/request").encode())
        transport = adapters["transport_factory"](
            adapters["wifi"], adapters["mqtt_factory"], mailbox, WIFI_SSID,
            WIFI_PASSWORD, MQTT_BROKER, MQTT_PORT, base, OTA_DEVICE + "-" + boot,
            adapters["ticks_diff"], report)
        controller = Controller(engine, transport, mailbox, root,
                                {"device": OTA_DEVICE, "boot": boot},
                                adapters["watchdog_factory"], adapters["reset"],
                                load_application, adapters["ticks_diff"], report)
        controller.start()
        report("application_loaded" if controller.app else "recovery_waiting_wifi")
    except Exception:
        # Invalid provisioning, entropy or corrupt metadata: never execute app,
        # never silently initialize/erase metadata, never leak exception text.
        report("bootstrap_failed")
        return None
    count = 0
    while cycles is None or count < cycles:
        controller.cycle(adapters["ticks_ms"]())
        adapters["sleep_ms"](20)
        if cycles is not None:
            count += 1
    return controller


if __name__ == "__main__":
    main()
