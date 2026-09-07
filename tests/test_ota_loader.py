"""Host-only contracts; NOT CyberPi, WDT, socket or power-cut validation.

Load pure loader definitions without the separately developed engine import.
Adapters are explicit: no fake cyberpi and no uploaded candidate is executed.
"""
import ast
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]


def definitions(filename):
    path = ROOT / "firmware" / filename
    assert path.exists(), "runtime implementation missing: " + filename
    tree = ast.parse(path.read_text(), filename=str(path))
    tree.body = [node for node in tree.body
                 if not (isinstance(node, ast.ImportFrom) and node.module == "ota_core")
                 and not isinstance(node, ast.If)]
    namespace = {"__name__": "host_contract_test"}
    exec(compile(tree, str(path), "exec"), namespace)
    return namespace


class ReportTests(unittest.TestCase):
    def test_startup_codes_are_displayed_and_failure_is_nonfatal(self):
        api = definitions("ota_loader.py")
        self.assertIn("report_status", api)
        messages = []
        api["report_status"]("bootstrap_starting", messages.append)
        self.assertEqual(messages, ["OTA: bootstrap_starting"])
        def broken(message):
            raise OSError("screen failed")
        api["report_status"]("bootstrap_failed", broken)


class MailboxTests(unittest.TestCase):
    def test_callback_only_queues_exact_topic_bounded_bytes(self):
        api = definitions("ota_loader.py")
        box = api["Mailbox"](b"p/ota/dev/request", capacity=2, max_payload=8)
        self.assertFalse(box.put(b"p/robot/repl", b"{}"))
        self.assertFalse(box.put(b"p/ota/dev/request", b"123456789"))
        self.assertFalse(box.put(b"p/ota/dev/request", {"op": "activate"}))
        self.assertTrue(box.put(b"p/ota/dev/request", b"not json"))
        self.assertTrue(box.put(b"p/ota/dev/request", b"{}"))
        self.assertFalse(box.put(b"p/ota/dev/request", b"[]"))
        self.assertEqual(box.pop(), b"not json")
        self.assertEqual(box.pop(), b"{}")
        self.assertIsNone(box.pop())


class IntegrityTests(unittest.TestCase):
    def test_only_verified_bounded_source_can_reach_executor(self):
        import hashlib
        import io
        api = definitions("ota_loader.py")
        self.assertIn("read_verified_source", api)
        source = b"OTA_APP_PROTOCOL = 1\n" * 100
        desc = {"slot": "a", "size": len(source),
                "sha256": hashlib.sha256(source).hexdigest()}
        opened = []

        def open_file(path, mode):
            opened.append((path, mode))
            return io.BytesIO(source)

        read = api["read_verified_source"]
        self.assertEqual(read("/flash/mbot_ota", desc, open_file, hashlib.sha256), source)
        self.assertEqual(opened, [("/flash/mbot_ota/app_a.py", "rb")])
        for change in ({"size": len(source) - 1}, {"size": len(source) + 1},
                       {"sha256": "0" * 64}, {"slot": "../bad"},
                       {"size": 131073}, {"size": True}):
            invalid = dict(desc, **change)
            with self.assertRaises(ValueError):
                read("/flash/mbot_ota", invalid, open_file, hashlib.sha256)


    def test_loader_verifies_before_exec_and_rejects_legacy_interface(self):
        api = definitions("ota_loader.py")
        self.assertTrue("load_application" in api)
        events = []
        selected = {"slot": "a"}
        def reader(root, desc):
            events.append("verify")
            self.assertIs(desc, selected)
            return b"verified source"
        def executor(source, scope):
            events.append("exec")
            self.assertEqual(source, b"verified source")
            self.assertNotEqual(scope["__name__"], "__main__")
            scope.update(OTA_APP_PROTOCOL=1, ota_init=lambda c: None,
                         ota_step=lambda c: None)
        app = api["load_application"]("root", selected, reader, executor)
        self.assertEqual(events, ["verify", "exec"])
        self.assertTrue(callable(app["ota_step"]))
        with self.assertRaises(ValueError):
            api["load_application"]("root", selected, reader, lambda s, ns: None)
        def rejected_reader(root, desc):
            raise ValueError("bad_hash")
        events[:] = []
        with self.assertRaises(ValueError):
            api["load_application"]("root", selected, rejected_reader, executor)
        self.assertEqual(events, [])


class EngineAdapter:
    """Scripted documented API, not a test of core parsing/storage."""
    def __init__(self, events, selected):
        self.events, self.selected = events, selected
        self.response = None
        self.trial = dict(selected, attempted=True) if selected else None
        self.healthy = False
    def boot_selection(self):
        self.events.append("select")
        return self.selected
    def mark_healthy(self):
        self.events.append("healthy")
    def hello(self):
        self.events.append("hello")
        return {"op": "hello", "body": "{}"}
    def handle(self, request):
        self.events.append(("handle", request))
        return self.response


class TransportAdapter:
    def __init__(self, events):
        self.events, self.connected = events, True
        self.fail_publish = False
    def service(self, now):
        self.events.append("service")
        return self.connected
    def publish(self, suffix, envelope):
        self.events.append(("publish", suffix, envelope))
        return not self.fail_publish


class ControllerTests(unittest.TestCase):
    def fixture(self, selected=True):
        api = definitions("ota_loader.py")
        self.assertTrue("Controller" in api)
        events = []
        desc = {"slot": "a", "size": 10, "sha256": "a" * 64} if selected else None
        engine, transport = EngineAdapter(events, desc), TransportAdapter(events)
        mailbox = api["Mailbox"](b"request")
        def watchdog_factory(timeout):
            events.append(("wdt", timeout))
            class Watchdog:
                def feed(self):
                    events.append("feed")
            return Watchdog()
        app = {"ota_init": lambda context: events.append("init"),
               "ota_step": lambda context: events.append("step")}
        def prepare(root, descriptor):
            events.append("prepare")
            return app
        controller = api["Controller"](
            engine, transport, mailbox, "root", {"device": "dev", "boot": "b" * 32},
            watchdog_factory, lambda: events.append("reset"), prepare,
            lambda now, then: now - then, lambda code: events.append(("report", code)))
        return controller, events, engine, transport, mailbox, app

    def test_native_watchdog_precedes_app_and_feed_follows_service_step(self):
        controller, events, engine, transport, mailbox, app = self.fixture()
        controller.start()
        self.assertEqual(events, ["select", ("wdt", 8000), "prepare", "init"])
        controller.cycle(0)
        self.assertLess(events.index("service"), events.index("feed"))
        self.assertLess(events.index("step"), events.index("healthy"))
        self.assertLess(events.index("healthy"), events.index("feed"))
        self.assertEqual(events.count("hello"), 1)
        controller.cycle(10)
        self.assertEqual(events.count("healthy"), 1)
        self.assertEqual(events.count("hello"), 1)
        controller.cycle(5000)
        self.assertEqual(events.count("hello"), 2)
        with self.assertRaises(RuntimeError):
            controller.start()
        self.assertEqual(events.count("select"), 1)


    def test_app_failures_reset_without_health_feed_or_reselection(self):
        for phase in ("prepare", "ota_init", "ota_step"):
            with self.subTest(phase=phase):
                controller, events, engine, transport, mailbox, app = self.fixture()
                def fail(*args):
                    raise RuntimeError("private-details-must-not-be-logged")
                if phase == "prepare":
                    controller.prepare_app = fail
                else:
                    app[phase] = fail
                try:
                    controller.start()
                    controller.cycle(0)
                    controller.cycle(10)
                except RuntimeError:
                    self.fail("application failure must be contained and reset")
                self.assertEqual(events.count("reset"), 1)
                self.assertEqual(events.count("select"), 1)
                self.assertNotIn("healthy", events)
                self.assertNotIn("feed", events)
                self.assertNotIn("private-details", str(events))


    def test_confirmed_app_exceptions_keep_updater_serviced(self):
        for phase in ("prepare", "ota_init", "ota_step"):
            with self.subTest(phase=phase):
                controller, events, engine, transport, mailbox, app = self.fixture()
                engine.trial = None
                def fail(*args):
                    raise RuntimeError("private details")
                if phase == "prepare":
                    controller.prepare_app = fail
                else:
                    app[phase] = fail
                controller.start()
                controller.cycle(0)
                engine.response = {"op": "status", "body": '{"ok":true,"result":{}}'}
                mailbox.put(b"request", b'{"op":"status"}')
                controller.cycle(10)
                self.assertNotIn("reset", events)
                self.assertFalse(controller.failed)
                self.assertFalse(controller.healthy)
                self.assertFalse(engine.healthy)
                self.assertIsNone(controller.app)
                self.assertIn("feed", events)
                self.assertIn(("handle", b'{"op":"status"}'), events)
                self.assertIn(("publish", "response", engine.response), events)
                self.assertIn("hello", events)

    def test_confirmed_step_failure_clears_previously_advertised_health(self):
        controller, events, engine, transport, mailbox, app = self.fixture()
        engine.trial = None
        controller.start()
        controller.cycle(0)
        self.assertTrue(controller.healthy)
        engine.healthy = True
        def fail(context):
            raise ValueError("step failed after healthy")
        app["ota_step"] = fail
        controller.cycle(1)
        controller.cycle(5000)
        self.assertFalse(controller.healthy)
        self.assertFalse(engine.healthy)
        self.assertIsNone(controller.app)
        self.assertNotIn("reset", events)
        self.assertEqual(events.count("hello"), 2)
        self.assertEqual(events.count("feed"), 2)

    def test_main_loop_parsing_and_restart_only_after_ack(self):
        import json
        controller, events, engine, transport, mailbox, app = self.fixture()
        controller.start()
        request = json.dumps({"op": "activate", "body": "{}"}).encode()
        mailbox.put(b"request", request)
        self.assertFalse(any(isinstance(e, tuple) and e[0] == "handle" for e in events))
        engine.response = {"op": "activate", "body": json.dumps(
            {"ok": True, "result": {"restart": True}})}
        transport.fail_publish = True
        controller.cycle(0)
        self.assertIn(("handle", request), events)
        self.assertNotIn("reset", events)
        transport.fail_publish = False
        controller.cycle(1)
        self.assertEqual(events.count("reset"), 1)
        self.assertEqual(events[-2][0:2], ("publish", "response"))
        self.assertEqual(events[-1], "reset")
        self.assertEqual(events.count(("handle", request)), 1)


    def test_watchdog_unavailable_stays_connected_recovery_without_exec(self):
        controller, events, engine, transport, mailbox, app = self.fixture()
        def unavailable(timeout):
            raise OSError("unsupported")
        controller.watchdog_factory = unavailable
        controller.start()
        transport.connected = False
        controller.cycle(0)
        transport.connected = True
        controller.cycle(5000)
        self.assertIn("hello", events)
        self.assertEqual(events.count("service"), 2)
        self.assertNotIn("prepare", events)
        self.assertNotIn("healthy", events)
        self.assertNotIn("reset", events)
        self.assertNotIn("feed", events)


    def test_app_context_is_read_only_identity_without_watchdog(self):
        controller, events, engine, transport, mailbox, app = self.fixture()
        contexts = []
        app["ota_init"] = lambda context: contexts.append(context)
        controller.start()
        self.assertEqual(contexts[0].device if hasattr(contexts[0], "device") else None, "dev")
        self.assertEqual(contexts[0].boot, "b" * 32)
        self.assertEqual(contexts[0].sha256, "a" * 64)
        self.assertTrue(contexts[0].disarmed)
        self.assertFalse(hasattr(contexts[0], "watchdog"))
        with self.assertRaises(AttributeError):
            contexts[0].device = "changed"


    def test_wire_parser_is_owned_by_engine_in_main_loop(self):
        controller, events, engine, transport, mailbox, app = self.fixture(selected=False)
        controller.start()
        raw = b'{"op":"status","op":"activate"}'
        mailbox.put(b"request", raw)
        engine.response = {"op": "activate", "body": '{"ok":false,"error":"envelope"}'}
        controller.cycle(0)
        self.assertIn(("handle", raw), events)
        self.assertNotIn("reset", events)


    def test_engine_health_refusal_never_feeds_or_advertises_success(self):
        controller, events, engine, transport, mailbox, app = self.fixture()
        engine.mark_healthy = lambda: False
        controller.start()
        controller.cycle(0)
        self.assertEqual(events.count("reset"), 1)
        self.assertNotIn("feed", events)
        self.assertFalse(controller.healthy)


class CoreRuntimeIntegrationTests(unittest.TestCase):
    """Real core/files with runtime adapters; no hardware or uploaded app exec."""
    def test_confirmed_exception_accepts_replacement_and_trial_resets_to_rollback(self):
        import hashlib
        import importlib.util
        import json
        import tempfile
        spec = importlib.util.spec_from_file_location("ota_core", ROOT / "firmware/ota_core.py")
        core = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(core)
        api = definitions("ota_loader.py")
        with tempfile.TemporaryDirectory() as tmp:
            root = str(pathlib.Path(tmp) / "fresh_ota")
            api["ensure_root"](root)
            engine = core.OtaEngine(root, "dev", "b" * 32)
            def send(engine, op, body):
                reply = engine.handle(dict(v=1, device=engine.device, boot=engine.boot,
                    seq=engine.next_seq, op=op, body=json.dumps(body)))
                result = json.loads(reply["body"])
                self.assertTrue(result["ok"], result)
                return result["result"]
            def upload(engine, data):
                digest = hashlib.sha256(data).hexdigest()
                send(engine, "begin", dict(transfer="c" * 32, size=len(data), sha256=digest))
                send(engine, "chunk", dict(transfer="c" * 32, offset=0, data=data.hex()))
                send(engine, "finish", dict(transfer="c" * 32))
                return digest
            digest = upload(engine, b"# confirmed\n")
            send(engine, "activate", dict(sha256=digest))
            engine = core.OtaEngine(root, "dev", "d" * 32)
            engine.boot_selection()
            self.assertTrue(engine.mark_healthy())
            send(engine, "confirm", dict(sha256=digest))
            confirmed = engine.confirmed
            engine = core.OtaEngine(root, "dev", "e" * 32)
            events = []
            transport = TransportAdapter(events)
            mailbox = api["Mailbox"](b"request")
            class Watchdog:
                def feed(self): events.append("feed")
            def fail(*args):
                raise ValueError("app startup failure")
            def controller_for(engine):
                return api["Controller"](engine, transport, mailbox, root,
                    {"device": engine.device, "boot": engine.boot},
                    lambda timeout: Watchdog(), lambda: events.append("reset"), fail,
                    lambda a, b: a - b, lambda code: events.append(code))
            controller = controller_for(engine)
            controller.start()
            request = dict(v=1, device=engine.device, boot=engine.boot,
                seq=engine.next_seq, op="status", body="{}")
            mailbox.put(b"request", json.dumps(request).encode())
            controller.cycle(0)
            replies = [e[2] for e in events if isinstance(e, tuple) and e[:2] == ("publish", "response")]
            self.assertTrue(json.loads(replies[-1]["body"])["ok"])
            self.assertNotIn("reset", events)
            self.assertIn("feed", events)
            replacement = upload(engine, b"# replacement\n")
            self.assertEqual(engine.candidate["slot"], "b")
            send(engine, "activate", dict(sha256=replacement))
            engine = core.OtaEngine(root, "dev", "f" * 32)
            trial_controller = controller_for(engine)
            trial_controller.start()
            trial_controller.cycle(1)
            self.assertEqual(events.count("reset"), 1)
            self.assertTrue(trial_controller.failed)
            rollback = core.OtaEngine(root, "dev", "a" * 32)
            self.assertEqual(rollback.boot_selection(), confirmed)
            self.assertIsNone(rollback.trial)


class TransportTests(unittest.TestCase):
    def test_offline_retries_are_scheduled_and_only_ota_is_subscribed(self):
        api = definitions("ota_loader.py")
        self.assertTrue("MqttTransport" in api)
        events = []
        class Wifi:
            connected = False
            def is_connect(self): return self.connected
            def connect(self, ssid, password): events.append("wifi_attempt")
        class Socket:
            def settimeout(self, seconds): events.append(("timeout", seconds))
            def close(self): events.append("close")
        class Client:
            def __init__(self, client_id, broker, port, keepalive):
                self.sock = Socket()
                self.fail = False
                events.append(("client", client_id, broker, port, keepalive))
            def set_callback(self, cb): self.callback = cb
            def connect(self, clean_session): events.append(("connect", clean_session))
            def subscribe(self, topic, qos): events.append(("subscribe", topic, qos))
            def check_msg(self):
                events.append("poll")
                if self.fail: raise OSError("offline")
                self.callback(b"p/ota/dev/request", b"opaque bytes")
            def publish(self, topic, payload, retain, qos):
                events.append(("publish", topic, payload, retain, qos))
        wifi = Wifi()
        mailbox = api["Mailbox"](b"p/ota/dev/request")
        transport = api["MqttTransport"](
            wifi, Client, mailbox, "ssid", "secret", "broker", 1883,
            "p/ota/dev", "dev-boot", lambda now, then: now - then,
            lambda code: events.append(("report", code)))
        self.assertFalse(transport.service(0))
        self.assertFalse(transport.service(1))
        self.assertEqual(events.count("wifi_attempt"), 1)
        wifi.connected = True
        self.assertTrue(transport.service(2))
        self.assertIn(("subscribe", b"p/ota/dev/request", 0), events)
        self.assertEqual(mailbox.pop(), b"opaque bytes")
        self.assertTrue(transport.publish("hello", {"op": "hello", "body": "{}"}))
        self.assertEqual(events[-1][-2:], (False, 0))
        self.assertFalse(transport.publish("robot/repl", {}))
        transport.client.fail = True
        self.assertFalse(transport.service(3))
        self.assertIn("close", events)
        self.assertFalse(transport.service(4))
        self.assertTrue(transport.service(2003))
        self.assertEqual(sum(e[0] == "client" for e in events if isinstance(e, tuple)), 2)


class DiagnosticTests(unittest.TestCase):
    def test_diagnostic_is_cooperative_nonmoving_and_identifies_boot_build(self):
        api = definitions("ota_diagnostic_app.py")
        loader = definitions("ota_loader.py")
        context = loader["AppContext"]("dev", "b" * 32, "a" * 64, "1", 1, True)
        self.assertEqual(api["OTA_APP_PROTOCOL"], 1)
        api["ota_init"](context)
        first = api["ota_step"](context)
        second = api["ota_step"](context)
        self.assertEqual(first["boot"], context.boot)
        self.assertEqual(first["sha256"], context.sha256)
        self.assertEqual(first["build"], api["OTA_BUILD_ID"])
        self.assertEqual(first["steps"], 1)
        self.assertEqual(second["steps"], 2)
        self.assertTrue(first["disarmed"])
        tree = ast.parse((ROOT / "firmware/ota_diagnostic_app.py").read_text())
        forbidden = (ast.Import, ast.ImportFrom, ast.While, ast.For)
        self.assertFalse(any(isinstance(n, forbidden) for n in ast.walk(tree)))
        calls = [n.func.id for n in ast.walk(tree)
                 if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)]
        self.assertFalse(set(calls) & {"exec", "eval", "compile", "__import__", "open"})


class StartupTests(unittest.TestCase):
    def test_directory_created_preserved_and_file_rejected(self):
        import tempfile
        api = definitions("ota_loader.py")
        self.assertIn("ensure_root", api)
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp) / "mbot_ota"
            api["ensure_root"](str(root))
            self.assertTrue(root.is_dir())
            marker = root / "existing"
            marker.write_text("keep")
            api["ensure_root"](str(root))
            self.assertEqual(marker.read_text(), "keep")
            with self.assertRaises(ValueError):
                api["ensure_root"](str(marker))

    def test_inlined_bootstrap_stops_then_services_recovery_with_fresh_nonce(self):
        api = definitions("ota_loader.py")
        self.assertTrue("main" in api)
        events = []
        api.update(OTA_DEVICE="dev", WIFI_SSID="ssid",
                   WIFI_PASSWORD="secret", MQTT_BROKER="broker", MQTT_PORT=1883,
                   MQTT_TOPIC_PREFIX="p")
        def stop_wheels():
            events.append("stop_wheels")
            raise OSError("stop failed")
        def engine_factory(root, device, boot):
            events.append(("engine", root, device, boot))
            self.assertIn(("ensure_root", root), events)
            return EngineAdapter(events, None)
        def transport_factory(*args):
            events.append("transport")
            return TransportAdapter(events)
        class Watchdog:
            def feed(self): events.append("feed")
        adapters = {"stop_wheels": stop_wheels,
                    "stop_dc": lambda: events.append("stop_dc"),
                    "report": lambda code: events.append(("report", code)),
                    "urandom": lambda size: b"\x12" * size,
                    "engine_factory": engine_factory,
                    "ensure_root": lambda root: events.append(("ensure_root", root)),
                    "transport_factory": transport_factory,
                    "wifi": object(), "mqtt_factory": object(),
                    "watchdog_factory": lambda timeout: Watchdog(),
                    "reset": lambda: events.append("reset"),
                    "ticks_ms": lambda: 10,
                    "ticks_diff": lambda now, then: now - then,
                    "sleep_ms": lambda ms: events.append(("sleep", ms))}
        controller = api["main"](adapters, cycles=2)
        self.assertEqual(events[:3], ["stop_wheels", ("report", "wheel_stop_failed"), "stop_dc"])
        self.assertIn(("engine", "/flash/mbot_ota", "dev", "12" * 16), events)
        self.assertEqual(events.count("select"), 1)
        self.assertEqual(events.count("service"), 2)
        self.assertEqual(events.count("feed"), 2)
        self.assertEqual(events.count("hello"), 1)
        self.assertIsNone(controller.app)
        self.assertNotIn("reset", events)
        source = (ROOT / "firmware/ota_loader.py").read_text()
        self.assertIn("from ota_core import OtaEngine", source)
        self.assertIn('if __name__ == "__main__":', source)
        self.assertNotIn("cyberpi.cloud", source)
        self.assertNotIn("mbot_config", source)


if __name__ == "__main__":
    unittest.main()
