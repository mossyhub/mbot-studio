"""Software-only OTA tests: real temporary files, no network or hardware."""
import hashlib
import importlib.util
import json
import os
import tempfile
import unittest

CORE = os.path.join(os.path.dirname(__file__), '..', 'firmware', 'ota_core.py')
BOOT = '02' * 16
TRANSFER = '03' * 16


def load_core():
    if not os.path.exists(CORE):
        return None
    spec = importlib.util.spec_from_file_location('ota_core', CORE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CoreTests(unittest.TestCase):
    def setUp(self):
        self.module = load_core()
        self.assertIsNotNone(self.module, 'OTA core implementation must exist')
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.engine = self.module.OtaEngine(self.tmp.name, 'robot_1', BOOT)

    def request(self, op, body, seq=None):
        if seq is None:
            seq = self.engine.status()['next_seq']
        text = json.dumps(body, separators=(',', ':'))
        return dict(v=1, device='robot_1', boot=BOOT, seq=seq, op=op, body=text)

    def send(self, op, body, seq=None):
        response = self.engine.handle(self.request(op, body, seq))
        self.assertEqual(set(response), {'v', 'device', 'boot', 'seq', 'op', 'body'})
        return json.loads(response['body'])

    def test_no_key_required_status_and_hello(self):
        hello = self.engine.hello()
        self.assertEqual(set(hello), {'v', 'device', 'boot', 'seq', 'op', 'body'})
        self.assertFalse(hasattr(self.engine, 'key'))
        self.assertEqual(json.loads(hello['body'])['protocol'], 1)
        response = self.send('status', {})
        self.assertTrue(response['ok'])
        self.assertIsNone(response['result']['confirmed'])
        self.assertEqual(response['result']['next_seq'], 2)

    def test_schema_sequence_and_exact_retry(self):
        request = self.request('status', {})
        for seq in (0, 2, True, -1, 2147483648):
            bad = dict(request, seq=seq)
            self.assertFalse(json.loads(self.engine.handle(bad)['body'])['ok'])
            self.assertEqual(self.engine.status()['next_seq'], 1)
        first = self.engine.handle(request)
        self.assertEqual(self.engine.handle(request), first)
        self.assertEqual(self.engine.status()['next_seq'], 2)
        changed = self.request('status', {'extra': 1}, seq=1)
        self.assertFalse(json.loads(self.engine.handle(changed)['body'])['ok'])
        self.assertEqual(self.engine.status()['next_seq'], 2)
        self.assertFalse(self.send('status', {'extra': 1})['ok'])
        self.assertEqual(self.engine.status()['next_seq'], 3)
        for field, value in [('v', True), ('seq', True), ('op', 'status\n'),
                             ('device', 'other'), ('boot', '04' * 16), ('body', {})]:
            invalid = dict(self.request('status', {}))
            invalid[field] = value
            self.assertFalse(json.loads(self.engine.handle(invalid)['body'])['ok'])
            self.assertEqual(self.engine.status()['next_seq'], 3)
        self.assertFalse(json.loads(self.engine.handle('x' * 8193)['body'])['ok'])
        self.assertFalse(self.send('unknown', {})['ok'])
        self.assertEqual(self.engine.status()['next_seq'], 4)

    def test_provisioning_is_strict(self):
        for boot, device in [('x' * 32, 'robot'), (BOOT, '../robot'), (BOOT, ''), (True, 'robot')]:
            with self.assertRaises(ValueError):
                self.module.OtaEngine(self.tmp.name, device, boot)

    def upload(self, data=b'OTA_APP_PROTOCOL=1\n'):
        digest = hashlib.sha256(data).hexdigest()
        self.assertTrue(self.send('begin', dict(transfer=TRANSFER, size=len(data), sha256=digest))['ok'])
        for offset in range(0, len(data), 1024):
            self.assertTrue(self.send('chunk', dict(transfer=TRANSFER, offset=offset, data=data[offset:offset+1024].hex()))['ok'])
        self.assertTrue(self.send('finish', dict(transfer=TRANSFER))['ok'])
        return digest

    def reboot(self, boot=BOOT):
        self.engine = self.module.OtaEngine(self.tmp.name, 'robot_1', boot)
        return self.engine

    def test_upload_readback_and_redundant_metadata(self):
        digest = self.upload(b'x' * 2050)
        candidate = self.engine.status()['candidate']
        self.assertEqual(candidate, dict(slot='a', sha256=digest, size=2050))
        self.assertIsNone(self.engine.status()['receiving'])
        for index in (0, 1):
            self.assertTrue(os.path.exists(os.path.join(self.tmp.name, 'meta%d.json' % index)))
        self.assertEqual(self.reboot().status()['candidate'], candidate)
        with open(os.path.join(self.tmp.name, 'meta0.json'), 'w') as stream:
            stream.write('{torn')
        self.assertEqual(self.reboot().status()['candidate'], candidate)
        with open(os.path.join(self.tmp.name, 'meta1.json'), 'w') as stream:
            stream.write('{torn')
        with self.assertRaises(ValueError):
            self.reboot()

    def test_chunk_bounds_retry_digest_and_abort(self):
        data = b'abcdef'
        digest = hashlib.sha256(data).hexdigest()
        self.assertTrue(self.send('begin', dict(transfer=TRANSFER, size=6, sha256=digest))['ok'])
        for offset, payload in [(1, '61'), (0, '00'*1025), (0, ''), (True, '61'), (0, 'AB')]:
            self.assertFalse(self.send('chunk', dict(transfer=TRANSFER, offset=offset, data=payload))['ok'])
        body = dict(transfer=TRANSFER, offset=0, data=data[:3].hex())
        self.assertTrue(self.send('chunk', body)['ok'])
        self.assertTrue(self.send('chunk', body)['ok'])
        self.assertFalse(self.send('chunk', dict(body, data='000000'))['ok'])
        self.assertFalse(self.send('finish', dict(transfer=TRANSFER))['ok'])
        self.assertTrue(self.send('chunk', dict(transfer=TRANSFER, offset=3, data=data[3:].hex()))['ok'])
        with open(os.path.join(self.tmp.name, 'app_a.py'), 'wb') as stream:
            stream.write(b'xxxxxx')
        self.assertFalse(self.send('finish', dict(transfer=TRANSFER))['ok'])
        self.assertIsNone(self.engine.status()['candidate'])
        self.assertTrue(self.send('abort', dict(transfer=TRANSFER))['ok'])
        self.assertIsNone(self.engine.status()['receiving'])
        for size in (0, True, 131073):
            self.assertFalse(self.send('begin', dict(transfer=TRANSFER, size=size, sha256=digest))['ok'])

    def test_begin_clears_old_candidate_before_file_write(self):
        self.upload()
        self.assertTrue(self.send('begin', dict(transfer=TRANSFER, size=1, sha256='00'*32))['ok'])
        self.assertIsNone(self.reboot().status()['candidate'])
        self.assertIsNone(self.engine.status()['receiving'])

    def test_trial_health_confirmation_and_inactive_slot(self):
        digest = self.upload()
        self.assertTrue(self.send('activate', dict(sha256=digest))['ok'])
        self.assertFalse(self.send('confirm', dict(sha256=digest))['ok'])
        self.assertFalse(self.send('begin', dict(transfer=TRANSFER, size=1, sha256=digest))['ok'])
        self.reboot()
        selected = self.engine.boot_selection()
        self.assertEqual(selected['sha256'], digest)
        self.assertEqual(self.engine.boot_selection(), selected)
        self.assertFalse(self.send('confirm', dict(sha256=digest))['ok'])
        self.engine.mark_healthy()
        self.assertFalse(self.send('confirm', dict(sha256='00'*32))['ok'])
        self.assertTrue(self.send('confirm', dict(sha256=digest))['ok'])
        self.assertIsNone(self.engine.status()['trial'])
        with open(os.path.join(self.tmp.name, 'app_a.py'), 'rb') as stream:
            original = stream.read()
        other = self.upload(b'# other\n')
        self.assertEqual(self.engine.status()['candidate']['slot'], 'b')
        with open(os.path.join(self.tmp.name, 'app_a.py'), 'rb') as stream:
            self.assertEqual(stream.read(), original)
        self.assertTrue(self.send('activate', dict(sha256=other))['result']['restart'])
        self.assertEqual(self.reboot().boot_selection()['sha256'], other)
        self.assertEqual(self.reboot().boot_selection()['sha256'], digest)
        self.assertIsNone(self.engine.status()['candidate'])

    def test_failed_first_trial_recovers_even_with_one_corrupt_record(self):
        digest = self.upload()
        self.assertTrue(self.send('activate', dict(sha256=digest))['ok'])
        self.assertEqual(self.reboot().boot_selection()['sha256'], digest)
        with open(os.path.join(self.tmp.name, 'meta0.json'), 'w') as stream:
            stream.write('torn')
        self.assertIsNone(self.reboot().boot_selection())
        self.assertIsNone(self.engine.status()['trial'])
        self.assertFalse(self.engine.mark_healthy())

    def test_rollback_and_preboot_tamper(self):
        digest = self.upload()
        self.assertTrue(self.send('activate', dict(sha256=digest))['ok'])
        self.assertTrue(self.send('rollback', {})['result']['restart'])
        self.assertIsNone(self.reboot().boot_selection())
        digest = self.upload()
        self.assertTrue(self.send('activate', dict(sha256=digest))['ok'])
        with open(os.path.join(self.tmp.name, 'app_a.py'), 'wb') as stream:
            stream.write(b'tampered')
        self.assertIsNone(self.reboot().boot_selection())
        self.assertIsNone(self.engine.status()['trial'])

    def test_native_json_parser_semantics_without_python_scanner(self):
        import ast
        with open(CORE) as stream:
            tree = ast.parse(stream.read())
        parser = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == '_object')
        self.assertFalse(any(isinstance(n, (ast.For, ast.While, ast.ListComp, ast.GeneratorExp))
                             for n in ast.walk(parser)))
        self.assertEqual(self.module._object('{"value":0,"value":1}'), {'value': 1})
        self.assertEqual(self.module._object('{"nested":[[[[[[[[[[0]]]]]]]]]]}'),
                         json.loads('{"nested":[[[[[[[[[[0]]]]]]]]]]}'))
        request = self.request('status', {})
        raw = '{"v":0,' + json.dumps(request)[1:]
        self.assertTrue(json.loads(self.engine.handle(raw)['body'])['ok'])

    def test_malformed_json_and_exact_body_retry(self):
        for raw in ('{', '[]', 'null', b'\xff'):
            self.assertFalse(json.loads(self.engine.handle(raw)['body'])['ok'])
            self.assertEqual(self.engine.next_seq, 1)
        request = self.request('status', {})
        first = self.engine.handle(request)
        changed = dict(request, body=' { } ')
        self.assertEqual(json.loads(self.engine.handle(changed)['body'])['error'], 'sequence')
        self.assertEqual(self.engine.handle(request), first)
        for body in ('{', '[]', 'null'):
            request = dict(self.request('status', {}), body=body)
            response = self.engine.handle(request)
            self.assertEqual(json.loads(response['body'])['error'], 'schema')
            self.assertEqual(self.engine.handle(request), response)

    def test_metadata_is_unkeyed_checksum_of_exact_utf8_body(self):
        self.upload()
        with open(os.path.join(self.tmp.name, 'meta0.json')) as stream:
            record = json.load(stream)
        self.assertEqual(set(record), {'generation', 'body', 'sha256'})
        text = 'mbot-ota-meta-v1\nrobot_1\n' + str(record['generation']) + '\n' + record['body']
        self.assertEqual(record['sha256'], hashlib.sha256(text.encode('utf-8')).hexdigest())

    def test_status_is_detached_snapshot(self):
        digest = self.upload()
        state = self.engine.status()
        state['candidate']['sha256'] = '00'*32
        self.assertEqual(self.engine.status()['candidate']['sha256'], digest)

    def test_metadata_failed_second_write_never_executes_trial(self):
        from unittest.mock import patch
        digest = self.upload()
        self.assertTrue(self.send('activate', dict(sha256=digest))['ok'])
        self.reboot()
        rename = os.rename
        def fail_second(source, destination):
            if destination.endswith('meta1.json'):
                raise OSError('simulated power loss')
            return rename(source, destination)
        with patch.object(self.module.os, 'rename', fail_second):
            with self.assertRaises(self.module.OtaError):
                self.engine.boot_selection()
        self.assertIsNone(self.engine.status()['selected'])
        self.assertFalse(self.engine.mark_healthy())
        self.assertFalse(self.send('activate', dict(sha256=digest))['ok'])
        # Newer attempted record dominates older unattempted record.
        self.assertIsNone(self.reboot().boot_selection())
        # Destroy either synchronized rollback copy: trial still cannot return.
        with open(os.path.join(self.tmp.name, 'meta1.json'), 'w') as stream:
            stream.write('corrupt')
        self.assertIsNone(self.reboot().boot_selection())

    def test_metadata_checksum_and_bounds_fail_closed(self):
        self.upload()
        for index in (0, 1):
            path = os.path.join(self.tmp.name, 'meta%d.json' % index)
            with open(path) as stream:
                record = json.load(stream)
            record['generation'] += 1
            with open(path, 'w') as stream:
                json.dump(record, stream)
        with self.assertRaises(ValueError):
            self.reboot()
        for index in (0, 1):
            with open(os.path.join(self.tmp.name, 'meta%d.json' % index), 'w') as stream:
                stream.write(' ' * 4097)
        with self.assertRaises(ValueError):
            self.reboot()

    def test_error_retry_and_boot_nonce_replay(self):
        request = self.request('status', {'extra': 1})
        first = self.engine.handle(request)
        self.assertFalse(json.loads(first['body'])['ok'])
        self.assertEqual(first, self.engine.handle(request))
        old = self.request('status', {})
        self.reboot('ff' * 16)
        self.assertFalse(json.loads(self.engine.handle(old)['body'])['ok'])
        self.assertEqual(self.engine.status()['next_seq'], 1)

    def test_maximum_image_size_is_streamed(self):
        digest = self.upload(b'z' * 131072)
        self.assertEqual(self.engine.status()['candidate']['size'], 131072)
        self.assertTrue(self.send('activate', dict(sha256=digest))['ok'])
        self.assertEqual(self.reboot().boot_selection()['sha256'], digest)


if __name__ == '__main__':
    unittest.main()
