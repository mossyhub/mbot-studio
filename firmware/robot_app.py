"""Cooperative OTA application. Hardware is imported only by ota_init.

The builder prepends broker/port/prefix/device and optionally MOTION_ENABLED.
No credentials, WiFi setup, REPL, or motor-start implementations live here.
Injected adapters support host software tests; they are not hardware evidence.
"""
try:
    import ujson as json
except ImportError:
    import json
from robot_engine import RobotEngine

OTA_APP_PROTOCOL = 1
OTA_BUILD_ID = globals().get("OTA_BUILD_ID", "mbot-cooperative-v1")
MOTION_ENABLED = globals().get("MOTION_ENABLED", False)
ROBOT_MQTT_BROKER = globals().get("ROBOT_MQTT_BROKER", None)
ROBOT_MQTT_PORT = globals().get("ROBOT_MQTT_PORT", 1883)
ROBOT_TOPIC_PREFIX = globals().get("ROBOT_TOPIC_PREFIX", None)
ROBOT_DEVICE = globals().get("ROBOT_DEVICE", None)
MAILBOX_LIMIT = 4
OUTGOING_LIMIT = 32
MAX_PAYLOAD = 32768
PUBLISH_PER_STEP = 2
_app = None


class NativeIO:
    """Allowlisted native function bindings; no motor-start implementation."""
    sensor_names = ("distance", "line_status", "battery", "loudness", "brightness", "yaw")

    def __init__(self, functions):
        self.functions = functions

    def execute(self, kind, params):
        if kind in ("display_text", "say"):
            return self.functions["display_text"](params.get("text", ""), params.get("size", 14))
        if kind == "set_led":
            return self.functions["set_led"](params.get("color", "green"))
        # This guard is unconditional, even if a future provision enables motion.
        raise ValueError("unsupported_hardware_operation: " + str(kind))

    def read(self, name):
        if name not in self.sensor_names:
            raise ValueError("unsupported_sensor: " + str(name))
        return self.functions[name]()

    def stop(self):
        errors = []
        for name in ("stop_wheels", "stop_dc"):
            try:
                self.functions[name]()
            except Exception as error:
                errors.append(name + ": " + str(error)[:160])
        if errors:
            raise OSError("; ".join(errors))


class BoundedIO:
    """Share one native sensor read budget across engine and telemetry per step."""
    def __init__(self, io, clock):
        self.io, self.clock = io, clock
        self.sensor_names = tuple(io.sensor_names)
        self.samples = {}
        self.begin_step()

    def begin_step(self):
        self.read_name = None

    def execute(self, kind, params):
        return self.io.execute(kind, params)

    def stop(self):
        return self.io.stop()

    def read(self, name):
        if name not in self.sensor_names:
            raise ValueError("unsupported_sensor: " + str(name))
        if self.read_name is not None and self.read_name != name:
            raise ValueError("sensor_budget")
        if self.read_name is None:
            self.read_name = name
            value, error = None, None
            try:
                value = self.io.read(name)
                if type(value) not in (int, float) or value != value or value in (float("inf"), -float("inf")):
                    raise ValueError("invalid_sensor_value")
                # Preserve the raw sentinel, but do not certify it as valid.
                if name != "yaw" and value < 0:
                    raise ValueError("negative_sensor_value")
            except Exception as exc:
                error = str(exc)[:160]
            self.samples[name] = (value, error, self.clock.ticks_ms())
        value, error, _ = self.samples[name]
        if error is not None:
            raise ValueError(error)
        return value

    def snapshot(self):
        data = {"validity": {}, "errors": {}, "age_ms": {}}
        now = self.clock.ticks_ms()
        for name in self.sensor_names:
            sample = self.samples.get(name)
            if sample is None:
                data["validity"][name] = False
                data["errors"][name] = "not_sampled"
                continue
            value, error, at = sample
            age = self.clock.ticks_diff(now, at)
            if type(value) in (int, float) and value == value and value not in (float("inf"), -float("inf")):
                data[name] = value
            if age > 3000 and error is None:
                error = "stale_sample"
            data["validity"][name] = error is None
            data["age_ms"][name] = age
            if error is not None:
                data["errors"][name] = error
        return data


class RobotApp:
    def __init__(self, context, adapters):
        self.context = context
        self.clock = adapters["clock"]
        self.io = BoundedIO(adapters["io"], self.clock)
        self.factory = adapters["mqtt_factory"]
        self.engine = adapters.get("engine_factory", RobotEngine)(
            self.io, self.clock, motion_enabled=MOTION_ENABLED)
        self.client = None
        self.prefix = ROBOT_TOPIC_PREFIX + "/robot/"
        self.mailbox = []
        self.outgoing = []
        self.emergency = None
        self.request_error = False
        self.sequence = 0
        self.active_run_id = None
        self.dropped_requests = 0
        self.dropped_outgoing = 0
        self.last_connect_attempt = None
        self.last_heartbeat = self.clock.ticks_ms()
        self.last_ping = self.last_heartbeat
        self.last_error = None
        self.last_sensor = None
        self.sensor_index = 0
        self.last_telemetry = self.last_heartbeat
        self.io.stop()

    def status(self):
        return {"status": "running" if self.engine.running else "ready",
                "application": "cooperative-v1", "build": OTA_BUILD_ID,
                "device": self.context.device, "boot": self.context.boot,
                "sha256": self.context.sha256, "motion_enabled": MOTION_ENABLED,
                "armed": self.engine.armed,
                "dropped_requests": self.dropped_requests,
                "dropped_outgoing": self.dropped_outgoing, "last_error": self.last_error,
                "capabilities": list(getattr(self.engine, "supported_types", getattr(self.engine, "capabilities", ()))),
                "self_managed_homing": True}

    def queue(self, suffix, data):
        # Latest status/telemetry replaces stale samples, never execution events.
        if suffix != "execution":
            for index in range(len(self.outgoing)):
                if self.outgoing[index][0] == suffix:
                    self.outgoing[index] = (suffix, data)
                    return
        if len(self.outgoing) >= OUTGOING_LIMIT:
            self.dropped_outgoing += 1
            self.request_error = True
            return
        self.outgoing.append((suffix, data))

    def event(self, run_id, event, details):
        self.queue("execution", {"run_id": run_id, "event": event,
                                 "block_path": [], "type": None, "details": details,
                                 "boot": self.context.boot, "build": OTA_BUILD_ID})

    def receive(self, topic, payload, retained=False):
        # The classic callback provides no retained bit. Only reject retained
        # messages when the client actually supplies it; do not claim otherwise.
        if retained:
            return
        self.sequence += 1
        run_id = self.context.boot + "-" + str(self.sequence)
        emergency_topic = topic == (self.prefix + "emergency").encode()
        try:
            if len(payload) > MAX_PAYLOAD:
                raise ValueError("payload_too_large")
            data = json.loads(payload)
            if not isinstance(data, dict):
                raise ValueError("request_object_required")
            if "run_id" in data:
                candidate = data["run_id"]
                if not isinstance(candidate, str) or not candidate or len(candidate) > 128:
                    raise ValueError("invalid_run_id")
                run_id = candidate
            command = data.get("command", data)
            kind = command.get("type") if isinstance(command, dict) else command
            if emergency_topic or (topic == (self.prefix + "command").encode()
                                   and kind in ("stop", "emergency_stop")):
                if self.emergency is not None:
                    self.event(self.emergency, "canceled", {"reason": "superseded_stop"})
                self.emergency = run_id
                return
            if topic not in tuple((self.prefix + name).encode()
                                  for name in ("program", "command", "config")):
                raise ValueError("unsupported_topic")
            if len(self.mailbox) >= MAILBOX_LIMIT:
                self.dropped_requests += 1
                self.event(run_id, "failed", {"error": "mailbox_full"})
                return
            self.mailbox.append((topic, data, run_id))
        except Exception as error:
            self.request_error = True
            if emergency_topic:
                self.emergency = run_id
            self.event(run_id, "failed", {"error": str(error)[:160]})

    def cancel_mailbox(self, reason):
        for _, _, run_id in self.mailbox:
            self.event(run_id, "canceled", {"reason": reason})
        self.mailbox = []

    def request(self, topic, data, run_id):
        try:
            if topic == (self.prefix + "config").encode():
                raise ValueError("remote_config_unsupported")
            if topic == (self.prefix + "program").encode():
                program = data.get("program")
            else:
                command = data.get("command", data)
                if isinstance(command, str):
                    command = {"type": command, "params": data.get("params", {})}
                if not isinstance(command, dict):
                    raise ValueError("command_object_required")
                if command.get("type") in ("status", "get_status"):
                    self.queue("status", self.status())
                    self.event(run_id, "completed", {"operation": "status"})
                    return
                if command.get("type") == "read_sensors":
                    self.queue("sensors", self.io.snapshot())
                    self.event(run_id, "completed", {"operation": "cached_sensor_snapshot"})
                    return
                command = dict(command)
                command.pop("run_id", None)
                program = [command]
            self.engine.submit(program, run_id)
            self.active_run_id = run_id
        except Exception as error:
            self.engine.stop("request_failed")
            self.event(run_id, "failed", {"error": str(error)[:160]})

    def telemetry(self, now):
        names = self.io.sensor_names
        interval = max(100, 1000 // max(1, len(names)))
        if names and self.io.read_name is None and (self.last_sensor is None or self.clock.ticks_diff(now, self.last_sensor) >= interval):
            name = names[self.sensor_index]
            self.sensor_index = (self.sensor_index + 1) % len(names)
            self.last_sensor = now
            try:
                self.io.read(name)
            except Exception:
                # BoundedIO records the exact error with validity, not a fake
                # fallback reading. Telemetry-only failure cannot drive motion.
                pass
        if self.clock.ticks_diff(now, self.last_telemetry) >= 1000:
            self.last_telemetry = now
            data = self.io.snapshot()
            data["boot"] = self.context.boot
            self.queue("sensors", data)

    def network_error(self, error):
        self.last_error = str(error)[:160]
        self.engine.stop("network_disconnected")
        self.cancel_mailbox("network_disconnected")
        self.last_connect_attempt = self.clock.ticks_ms()
        client, self.client = self.client, None
        if client is not None:
            try:
                client.disconnect()
            except Exception as close_error:
                self.last_error += "; close: " + str(close_error)[:80]
        self.sequence += 1
        self.event(self.context.boot + "-network-" + str(self.sequence), "failed",
                   {"error": self.last_error})

    def connect(self, now):
        if self.last_connect_attempt is not None and self.clock.ticks_diff(now, self.last_connect_attempt) < 2000:
            return
        self.last_connect_attempt = now
        self.client = self.factory(
            (ROBOT_DEVICE + "-app-" + self.context.boot).encode(),
            ROBOT_MQTT_BROKER, port=ROBOT_MQTT_PORT, keepalive=15)
        self.client.set_callback(self.receive)
        # Native DNS/connect can still block before sock exists. The installed
        # loader WDT remains the ultimate bound; no retry/sleep loop here.
        self.client.connect(clean_session=True)
        self.client.sock.settimeout(1)
        for name in ("program", "command", "emergency", "config"):
            self.client.subscribe((self.prefix + name).encode(), qos=0)
        self.last_ping = now
        self.queue("status", self.status())

    def step(self):
        now = self.clock.ticks_ms()
        self.io.begin_step()
        try:
            if self.client is None:
                self.connect(now)
            if self.client is not None:
                self.client.check_msg()
        except Exception as error:
            self.network_error(error)
        if self.emergency is not None:
            run_id, self.emergency = self.emergency, None
            self.engine.stop("emergency_stop")
            self.cancel_mailbox("emergency_stop")
            self.event(run_id, "completed", {"operation": "stop_requested"})
            self.request_error = False
        elif self.request_error:
            self.request_error = False
            self.engine.stop("request_error")
            self.cancel_mailbox("request_error")
        elif self.client is not None and self.mailbox:
            self.request(*self.mailbox.pop(0))
        step_error = None
        try:
            self.engine.step()
        except Exception as error:
            step_error = str(error)[:160]
            self.last_error = step_error
            self.engine.stop("engine_error")
            self.cancel_mailbox("engine_error")
        for event in self.engine.drain_events():
            event["boot"] = self.context.boot
            event["build"] = OTA_BUILD_ID
            self.queue("execution", event)
        if step_error is not None:
            self.event(self.active_run_id or self.context.boot + "-engine", "failed", {"error": step_error})
        self.telemetry(now)
        if self.clock.ticks_diff(now, self.last_heartbeat) >= 2000:
            self.last_heartbeat = now
            self.queue("status", self.status())
        if self.client is not None:
            try:
                if self.clock.ticks_diff(now, self.last_ping) >= 5000:
                    self.client.ping()
                    self.last_ping = now
                for _ in range(PUBLISH_PER_STEP):
                    if not self.outgoing:
                        break
                    suffix, data = self.outgoing[0]
                    self.client.publish((self.prefix + suffix).encode(),
                                        json.dumps(data).encode(), retain=False, qos=0)
                    self.outgoing.pop(0)
            except Exception as error:
                self.network_error(error)
        return {"healthy": True, "build": OTA_BUILD_ID,
                "connected": self.client is not None,
                "disarmed": not self.engine.armed}


def _native_adapters():
    # Reached only by ota_init. Function bindings remain lazy: no sensor reads,
    # display calls, network connects, or motor starts during module import.
    import time
    import cyberpi
    import mbot2
    import mbuild
    try:
        from simple_mqtt import MQTTClient
    except ImportError:
        from umqtt.simple import MQTTClient

    def display_text(text, size):
        return cyberpi.display.show_label(text, size, "center", index=0)

    def set_led(color):
        if color == "off":
            return cyberpi.led.off()
        return cyberpi.led.show(" ".join([color] * 5))

    functions = {
        "display_text": display_text, "set_led": set_led,
        "stop_wheels": lambda: mbot2.EM_stop(),
        "stop_dc": lambda: mbot2.starter_shield.dc_motor_stop(),
        "distance": lambda: mbuild.ultrasonic2.get(),
        "line_status": lambda: mbuild.dual_rgb_sensor.get_line_sta(),
        "battery": lambda: cyberpi.get_battery(),
        "loudness": lambda: cyberpi.get_loudness(),
        "brightness": lambda: cyberpi.get_brightness(),
        "yaw": lambda: cyberpi.get_yaw()}
    return {"clock": time, "io": NativeIO(functions), "mqtt_factory": MQTTClient}


def ota_init(context, adapters=None):
    global _app
    if context.protocol != 1 or context.disarmed is not True:
        raise ValueError("application_context")
    if not ROBOT_MQTT_BROKER or not ROBOT_TOPIC_PREFIX or ROBOT_DEVICE != context.device:
        raise ValueError("application_provisioning")
    if adapters is None:
        adapters = _native_adapters()
    _app = RobotApp(context, adapters)


def ota_step(context):
    if _app is None:
        raise ValueError("application_not_initialized")
    original = _app.context
    if (context.device, context.boot, context.sha256) != (original.device, original.boot, original.sha256):
        raise ValueError("application_identity")
    return _app.step()
