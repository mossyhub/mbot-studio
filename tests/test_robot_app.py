"""Host-only runtime tests: injected software adapters, not hardware proof."""
import importlib.util
import json
from pathlib import Path
import sys
import types

import pytest

ROOT = Path(__file__).resolve().parents[1]


class Clock:
    def __init__(self):
        self.now = 0

    def ticks_ms(self):
        return self.now

    def ticks_diff(self, a, b):
        return a - b


class IO:
    sensor_names = ("distance", "battery")

    def __init__(self):
        self.stops = 0
        self.calls = []
        self.reads = []

    def stop(self):
        self.stops += 1

    def execute(self, kind, params):
        self.calls.append((kind, params))

    def read(self, name):
        self.reads.append(name)
        return 0


class Client:
    def __init__(self, *args, **kwargs):
        self.args, self.kwargs = args, kwargs
        self.subscriptions = []
        self.messages = []
        self.published = []
        self.checks = 0
        self.sock = self
        self.timeout = None
        self.disconnected = False

    def set_callback(self, callback):
        self.callback = callback

    def connect(self, clean_session):
        assert clean_session is True

    def settimeout(self, timeout):
        self.timeout = timeout

    def subscribe(self, topic, qos=0):
        self.subscriptions.append((topic, qos))

    def check_msg(self):
        self.checks += 1
        if self.messages:
            topic, payload = self.messages.pop(0)
            self.callback(topic, payload)

    def publish(self, topic, payload, retain=False, qos=0):
        self.published.append((topic.decode(), json.loads(payload)))

    def ping(self):
        pass

    def disconnect(self):
        self.disconnected = True


class Engine:
    supported_types = ("wait", "display_text", "stop")

    def __init__(self, io, clock, motion_enabled=False):
        self.io, self.clock = io, clock
        self.motion_enabled = motion_enabled
        self.armed = False
        self.running = False
        self.events = []
        self.submissions = []
        self.steps = 0

    def submit(self, program, run_id):
        if any(b["type"] not in self.supported_types for b in program):
            raise ValueError("unsupported_type")
        self.submissions.append((program, run_id))
        self.running = True
        self.events.append(dict(run_id=run_id, event="accepted", block_path=[], type=None, details={}))
        return {"accepted": True}

    def step(self):
        self.steps += 1

    def stop(self, reason="stop"):
        if self.running:
            self.events.append(dict(run_id=self.submissions[-1][1], event="canceled", block_path=[], type=None, details={"reason": reason}))
        self.running = self.armed = False
        self.io.stop()

    def drain_events(self):
        events, self.events = self.events, []
        return events


@pytest.fixture
def app_module(monkeypatch):
    # Sibling engine is developed independently. Stub only its import here;
    # Runtime's orchestration receives an explicit engine factory below.
    engine_module = types.ModuleType("robot_engine")
    engine_module.RobotEngine = Engine
    monkeypatch.setitem(sys.modules, "robot_engine", engine_module)
    path = ROOT / "firmware" / "robot_app.py"
    assert path.exists(), "cooperative runtime is not implemented"
    spec = importlib.util.spec_from_file_location("robot_app_under_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.ROBOT_MQTT_BROKER = "broker.invalid"
    module.ROBOT_MQTT_PORT = 1883
    module.ROBOT_TOPIC_PREFIX = "mbot/test"
    module.ROBOT_DEVICE = "robot-test"
    return module


def context():
    return types.SimpleNamespace(device="robot-test", boot="boot1", sha256="a" * 64,
                                 loader="loader-v1", protocol=1, disarmed=True)


def setup_runtime(module):
    clock, io, client = Clock(), IO(), Client()
    adapters = {"clock": clock, "io": io, "mqtt_factory": lambda *a, **kw: client,
                "engine_factory": Engine}
    module.ota_init(context(), adapters)
    return module._app, clock, io, client


def test_import_is_inert_and_init_uses_identity_only(app_module):
    assert app_module.OTA_APP_PROTOCOL == 1
    assert app_module.MOTION_ENABLED is False
    assert app_module._app is None
    app, clock, io, client = setup_runtime(app_module)
    assert io.stops == 1
    assert io.calls == []
    assert not client.subscriptions  # Network work is deferred to service steps.
    result = app_module.ota_step(context())
    assert result["healthy"] is True
    assert client.timeout == 1
    assert set(client.subscriptions) == {(b"mbot/test/robot/" + name, 0)
                                         for name in (b"program", b"command", b"emergency", b"config")}
    assert client.checks == 1
    assert app.engine.steps == 1
    status = next(data for topic, data in client.published if topic.endswith("/status"))
    assert status["status"] == "ready"
    assert status["armed"] is False and status["motion_enabled"] is False
    assert status["capabilities"] == list(Engine.supported_types)
    assert status["self_managed_homing"] is True
    assert status["boot"] == "boot1" and status["sha256"] == "a" * 64


def send(app, suffix, data):
    app.receive((app.prefix + suffix).encode(), json.dumps(data).encode())


def execution(client, run_id):
    return [data for topic, data in client.published
            if topic.endswith("/execution") and data["run_id"] == run_id]


def test_mailbox_is_bounded_and_emergency_preempts_program(app_module):
    app, clock, io, client = setup_runtime(app_module)
    for i in range(app_module.MAILBOX_LIMIT + 3):
        send(app, "program", {"program": [{"type": "wait", "params": {"seconds": 30}}], "run_id": "run" + str(i)})
    assert len(app.mailbox) == app_module.MAILBOX_LIMIT
    send(app, "emergency", {"run_id": "panic"})
    app.step()
    assert not app.engine.submissions
    assert not app.mailbox
    assert io.stops >= 2
    for _ in range(30):
        app.step()
    assert execution(client, "panic")[-1]["event"] == "completed"
    assert app.dropped_requests == 3
    assert len(app.outgoing) <= app_module.OUTGOING_LIMIT


def test_legacy_wrappers_status_during_wait_and_stop_correlation(app_module):
    app, clock, io, client = setup_runtime(app_module)
    send(app, "program", {"program": [{"type": "wait", "params": {"seconds": 30}}], "run_id": "long"})
    app.step()
    assert app.engine.submissions[-1][1] == "long"
    send(app, "command", {"command": {"type": "status"}, "run_id": "query"})
    app.step()
    assert app.engine.running
    send(app, "command", {"type": "stop", "run_id": "halt"})
    app.step()
    assert not app.engine.running
    send(app, "command", {"command": {"type": "display_text", "params": {"text": "ok"}}})
    app.step()
    assert app.engine.submissions[-1][1].startswith("boot1-")
    for _ in range(20):
        app.step()
    assert execution(client, "long")[-1]["event"] == "canceled"
    assert execution(client, "query")[-1]["event"] == "completed"
    assert execution(client, "halt")[-1]["event"] == "completed"
    assert client.checks == app.engine.steps


def test_bad_requests_and_arbitrary_code_get_explicit_failure(app_module):
    app, clock, io, client = setup_runtime(app_module)
    for suffix, data in [("command", {"type": "upload_code", "code": "danger", "run_id": "code"}),
                         ("config", {"motion_enabled": True, "run_id": "cfg"}),
                         ("command", {"type": "move_forward", "run_id": "motor"})]:
        send(app, suffix, data)
        app.step()
    app.receive((app.prefix + "command").encode(), b"not-json")
    app.step()
    for _ in range(20):
        app.step()
    for run_id in ("code", "cfg", "motor"):
        assert execution(client, run_id)[-1]["event"] == "failed"
    assert io.calls == []
    assert io.stops >= 4
    assert app.engine.motion_enabled is False


def test_disconnect_stops_cancels_and_reconnect_is_scheduled(app_module):
    app, clock, io, client = setup_runtime(app_module)
    send(app, "program", {"program": [{"type": "wait"}], "run_id": "network-run"})
    app.step()
    original_check = client.check_msg
    def broken_check():
        raise OSError("link lost")
    client.check_msg = broken_check
    result = app.step()
    assert result["connected"] is False
    assert not app.engine.running and not app.engine.armed
    assert client.disconnected
    assert io.stops == 2
    client.check_msg = original_check
    clock.now = 1999
    assert app.step()["connected"] is False
    clock.now = 2000
    assert app.step()["connected"] is True
    for _ in range(10):
        app.step()
    assert execution(client, "network-run")[-1]["event"] == "canceled"
    failures = [data for topic, data in client.published if topic.endswith("/execution") and data["event"] == "failed"]
    assert any("link lost" in str(data["details"]) for data in failures)


def test_heartbeat_and_publish_work_are_bounded(app_module):
    app, clock, io, client = setup_runtime(app_module)
    app.step()
    for i in range(app_module.OUTGOING_LIMIT * 2):
        app.event(str(i), "failed", {"error": "test"})
    assert len(app.outgoing) == app_module.OUTGOING_LIMIT
    assert app.dropped_outgoing > 0
    before = len(client.published)
    app.step()
    assert len(client.published) - before <= app_module.PUBLISH_PER_STEP
    for _ in range(40):
        app.step()
    clock.now = 2000
    app.step()
    for _ in range(3):
        app.step()
    statuses = [d for t, d in client.published if t.endswith("/status")]
    assert len(statuses) >= 2
    assert statuses[-1]["dropped_outgoing"] > 0


def real_engine():
    spec = importlib.util.spec_from_file_location("runtime_real_engine", ROOT / "firmware" / "robot_engine.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.RobotEngine


def test_real_engine_wait_stop_and_motion_rejection(app_module):
    io, clock, client = IO(), Clock(), Client()
    app_module.ota_init(context(), {"io": io, "clock": clock, "mqtt_factory": lambda *a, **k: client,
                                     "engine_factory": real_engine()})
    app = app_module._app
    send(app, "command", {"type": "wait", "params": {"duration": 30}, "run_id": "real-wait"})
    app.step()
    assert app.engine.running
    for _ in range(10):
        clock.now += 20
        app.step()
    send(app, "command", {"type": "status", "run_id": "live-status"})
    app.step()
    assert app.engine.running and client.checks == 12
    send(app, "command", {"type": "stop", "run_id": "real-stop"})
    app.step()
    assert not app.engine.running
    send(app, "program", {"program": [{"type": "display_text", "params": {"text": "must not show"}},
                                        {"type": "move_forward"}], "run_id": "real-motion"})
    app.step()
    assert io.calls == []
    send(app, "command", {"type": "display_text", "params": {"text": "next"}, "run_id": "next"})
    for _ in range(20):
        app.step()
    assert io.calls == [("display_text", {"text": "next", "size": 14})]
    assert any(e["event"] == "canceled" for e in execution(client, "real-wait"))
    assert execution(client, "real-motion")[-1]["event"] == "failed"
    assert execution(client, "next")[-1]["event"] == "completed"
    status = next(d for t, d in client.published if t.endswith("/status"))
    assert status["capabilities"] == list(app.engine.capabilities)


def test_telemetry_preserves_zero_and_errors_with_one_read_per_step(app_module):
    app, clock, io, client = setup_runtime(app_module)
    def read(name):
        io.reads.append(name)
        if name == "battery":
            raise OSError("battery unavailable")
        return 0
    io.read = read
    for _ in range(15):
        before = len(io.reads)
        app.step()
        assert len(io.reads) - before <= 1
        clock.now += 100
    samples = [d for t, d in client.published if t.endswith("/sensors")]
    assert samples
    sample = samples[-1]
    assert sample["distance"] == 0
    assert sample["validity"]["distance"] is True
    assert sample["validity"]["battery"] is False
    assert "battery" not in sample
    assert "battery unavailable" in sample["errors"]["battery"]
    send(app, "command", {"type": "read_sensors", "run_id": "sensors"})
    for _ in range(5):
        app.step()
    assert execution(client, "sensors")[-1]["event"] == "completed"


def test_sensor_budget_caches_repeated_engine_reads(app_module):
    io, clock = IO(), Clock()
    guarded = app_module.BoundedIO(io, clock)
    guarded.begin_step()
    assert guarded.read("distance") == 0
    assert guarded.read("distance") == 0
    with pytest.raises(ValueError, match="sensor_budget"):
        guarded.read("battery")
    assert io.reads == ["distance"]
    guarded.begin_step()
    assert guarded.read("battery") == 0


def test_native_function_adapter_rejects_motion_before_any_call(app_module):
    calls = []
    functions = {"display_text": lambda text, size: calls.append((text, size)),
                 "set_led": lambda color: calls.append(color),
                 "stop_wheels": lambda: calls.append("stop_wheels"),
                 "stop_dc": lambda: calls.append("stop_dc"),
                 "distance": lambda: 0}
    io = app_module.NativeIO(functions)
    for kind in ("move_forward", "turn_left", "servo", "dc_motor", "play_melody", "upload_code"):
        with pytest.raises(ValueError, match="unsupported_hardware_operation"):
            io.execute(kind, {})
    assert not calls
    io.execute("display_text", {"text": "hello", "size": 14})
    io.execute("say", {"text": "screen only"})
    io.execute("set_led", {"color": "off"})
    assert calls == [("hello", 14), ("screen only", 14), "off"]
    assert io.read("distance") == 0
    with pytest.raises(ValueError, match="unsupported_sensor"):
        io.read("made_up")
    io.stop()
    assert calls[-2:] == ["stop_wheels", "stop_dc"]


def test_native_stop_attempts_both_and_reports_failure(app_module):
    calls = []
    def bad_stop():
        raise OSError("wheel stop failed")
    io = app_module.NativeIO({"stop_wheels": bad_stop, "stop_dc": lambda: calls.append("dc")})
    with pytest.raises(OSError, match="wheel stop failed"):
        io.stop()
    assert calls == ["dc"]


def test_native_bindings_defer_calls_and_prefer_simple_mqtt(app_module, monkeypatch):
    """Dependency binding test only; objects are not robot emulation."""
    calls = []
    def record(name, result=None):
        def callback(*args, **kwargs):
            calls.append((name, args, kwargs))
            return result
        return callback
    cp = types.SimpleNamespace(display=types.SimpleNamespace(show_label=record("display")),
                               led=types.SimpleNamespace(show=record("led"), off=record("off")),
                               get_battery=record("battery", 72), get_loudness=record("loudness", 1),
                               get_brightness=record("brightness", 2), get_yaw=record("yaw", -5))
    mb = types.SimpleNamespace(EM_stop=record("wheels"),
                               starter_shield=types.SimpleNamespace(dc_motor_stop=record("dc")))
    build = types.SimpleNamespace(ultrasonic2=types.SimpleNamespace(get=record("distance", 0)),
                                 dual_rgb_sensor=types.SimpleNamespace(get_line_sta=record("line_status", 1)))
    for name, module in (("cyberpi", cp), ("mbot2", mb), ("mbuild", build),
                         ("simple_mqtt", types.SimpleNamespace(MQTTClient=Client))):
        monkeypatch.setitem(sys.modules, name, module)
    adapters = app_module._native_adapters()
    assert calls == []
    assert adapters["mqtt_factory"] is Client
    io = adapters["io"]
    io.execute("display_text", {"text": "text", "size": 16})
    io.execute("set_led", {"color": "blue"})
    io.execute("set_led", {"color": "off"})
    assert io.read("distance") == 0
    assert io.read("battery") == 72
    io.stop()
    assert calls[0] == ("display", ("text", 16, "center"), {"index": 0})
    assert calls[1] == ("led", ("blue blue blue blue blue",), {})
    assert calls[-2:] == [("wheels", (), {}), ("dc", (), {})]
    monkeypatch.setitem(sys.modules, "simple_mqtt", None)
    monkeypatch.setitem(sys.modules, "umqtt", types.ModuleType("umqtt"))
    monkeypatch.setitem(sys.modules, "umqtt.simple", types.SimpleNamespace(MQTTClient=Client))
    assert app_module._native_adapters()["mqtt_factory"] is Client


def test_unexpected_engine_error_is_stopped_and_reported(app_module):
    app, clock, io, client = setup_runtime(app_module)
    send(app, "program", {"program": [{"type": "wait"}], "run_id": "engine-fault"})
    def crash():
        raise RuntimeError("scheduler adapter failed")
    app.engine.step = crash
    app.step()
    assert not app.engine.running
    for _ in range(5):
        app.step()
    assert any("scheduler adapter failed" in str(event["details"])
               for event in execution(client, "engine-fault"))
    assert io.stops >= 2


@pytest.mark.parametrize("bad", [None, -1, float("nan"), float("inf"), "bad"])
def test_invalid_sensor_samples_are_never_fabricated(app_module, bad):
    io, clock = IO(), Clock()
    io.read = lambda name: bad
    guarded = app_module.BoundedIO(io, clock)
    with pytest.raises(ValueError):
        guarded.read("distance")
    data = guarded.snapshot()
    assert data["validity"]["distance"] is False
    assert "distance" in data["errors"]
    if bad == -1:
        assert data["distance"] == -1
    else:
        assert "distance" not in data
    json.dumps(data, allow_nan=False)


def test_stale_sensor_samples_are_marked_invalid(app_module):
    clock, io = Clock(), IO()
    guarded = app_module.BoundedIO(io, clock)
    guarded.read("distance")
    clock.now = 3001
    data = guarded.snapshot()
    assert data["distance"] == 0
    assert not data["validity"]["distance"]
    assert data["errors"]["distance"] == "stale_sample"


def test_identity_provisioning_and_retained_message_guards(app_module):
    with pytest.raises(ValueError, match="not_initialized"):
        app_module.ota_step(context())
    bad = context()
    bad.disarmed = False
    with pytest.raises(ValueError, match="application_context"):
        app_module.ota_init(bad, {})
    bad = context()
    bad.device = "other"
    with pytest.raises(ValueError, match="provisioning"):
        app_module.ota_init(bad, {})
    app, clock, io, client = setup_runtime(app_module)
    bad = context()
    bad.boot = "other"
    with pytest.raises(ValueError, match="identity"):
        app_module.ota_step(bad)
    app.receive((app.prefix + "command").encode(), b'{"type":"display_text"}', True)
    app.step()
    assert not app.engine.submissions
    app.receive((app.prefix + "emergency").encode(), b"x" * (app_module.MAX_PAYLOAD + 1))
    app.step()
    assert io.stops == 2


def test_publish_failure_disconnects_without_unbounded_retry(app_module):
    app, clock, io, client = setup_runtime(app_module)
    def fail(*args, **kwargs):
        raise OSError("publish failed")
    client.publish = fail
    app.step()
    assert app.client is None and client.disconnected
    assert not app.engine.armed
    assert len(app.outgoing) <= app_module.OUTGOING_LIMIT
    for _ in range(10):
        app.step()
    assert io.stops == 2


def test_client_identity_and_clean_session(app_module):
    app_module.ota_init(context(), {"clock": Clock(), "io": IO(), "mqtt_factory": Client,
                                     "engine_factory": Engine})
    app = app_module._app
    app.step()
    assert app.client.args == (b"robot-test-app-boot1", "broker.invalid")
    assert app.client.kwargs == {"port": 1883, "keepalive": 15}
