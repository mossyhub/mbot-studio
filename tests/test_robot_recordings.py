"""Host-only recorded-audio protocol, filesystem and native stand-ins."""
import hashlib
import inspect
import json
import sys
from types import SimpleNamespace

import pytest
import test_robot_control as base


def test_asset_chunk_admission_python_work_does_not_scale_with_hex_bytes(tmp_path):
    """Native JSON/find/hex operations, not per-byte interpreted wire scans."""
    counts = []
    for size in (1, 512):
        root = tmp_path / str(size)
        root.mkdir()
        rig = recording_rig(root)
        m, ctx, clock, io, client = rig
        assert request(rig, 'begin', id='a' * 64, sha256='a' * 64,
                       size=512, duration_ms=125)['ok']
        message = dict(op='chunk', transfer_id='transfer', boot=ctx.boot,
                       offset=0, data='ab' * size)
        base.send(client, message, 'asset')
        events = []
        def trace(frame, event, arg):
            if event == 'line' and frame.f_code.co_filename == m.__file__:
                events.append(frame.f_lineno)
            return trace
        previous = sys.gettrace()
        try:
            sys.settrace(trace)
            m.ota_step(ctx)
        finally:
            sys.settrace(previous)
        counts.append(len(events))
        for _ in range(3): m.ota_step(ctx)
        acks = [data for topic, data in client.events
                if topic.endswith(b'/asset_status') and data['op'] == 'chunk']
        assert acks[-1]['ok'] and acks[-1]['offset'] == size
    assert counts[1] <= counts[0] + 150, counts


@pytest.mark.parametrize('token', ['transfer', 'with:colon', 'with"quote',
    'with\\backslash', 'end\\', 'slash\\"quote', 'two\\\\"quote', ':"\\\\:'])
def test_asset_field_scan_preserves_escaped_string_values(tmp_path, token):
    rig = recording_rig(tmp_path)
    m, ctx, clock, io, client = rig
    begin = dict(op='begin', transfer_id=token, boot=ctx.boot, id='a' * 64,
                 sha256='a' * 64, size=1, duration_ms=125)
    base.send(client, begin, 'asset')
    for _ in range(4): m.ota_step(ctx)
    chunk = dict(op='chunk', transfer_id=token, boot=ctx.boot, offset=0, data='aA')
    # JSON-escaped field names and data characters are valid after decoding.
    wire = json.dumps(chunk).encode().replace(b'"data"', b'"\\u0064ata"')
    wire = wire.replace(b'"aA"', b'"a\\u0041"')
    client.callback((m._app.prefix + 'asset').encode(), wire)
    for _ in range(4): m.ota_step(ctx)
    acks = [data for topic, data in client.events if topic.endswith(b'/asset_status')]
    assert len(acks) == 2 and all(ack['ok'] for ack in acks), acks
    assert acks[-1]['offset'] == 1
    assert (tmp_path / 'voice' / 'upload.part').read_bytes() == b'\xaa'


@pytest.mark.parametrize('tail', [
    b'"data":"aa","data":"aa"}',
    b'"data":"aa","\\u0064ata":"aa"}',
    b'"data":"aa","offset":0}',
    b'"data":"aa","\\u006fffset":0}',
    b'"data":{"x":"aa"}}', b'"data":["aa"]}',
    b'"data":null}', b'"data":true}', b'"data":12}',
    b'"data":""}', b'"data":"a"}', b'"data":"ag"}',
    b'"data":"aa bb "}', b'"data":"aa\\nbb "}',
    b'"data":"\\u0100a"}', b'"data":"aa\\"}',
    b'"data":"aa"oops"}', b'"data":"aa\\x00"}',
    b'"data":"aa","extra":1}',
])
def test_asset_native_scan_rejects_duplicates_bad_shapes_and_hex(tmp_path, tail):
    rig = recording_rig(tmp_path)
    m, ctx, clock, io, client = rig
    assert request(rig, 'begin', id='a' * 64, sha256='a' * 64,
                   size=512, duration_ms=125)['ok']
    before = len(client.events)
    wire = b'{"op":"chunk","transfer_id":"transfer","boot":"boot","offset":0,' + tail
    client.callback((m._app.prefix + 'asset').encode(), wire)
    for _ in range(3): m.ota_step(ctx)
    acks = [data for topic, data in client.events[before:]
            if topic.endswith(b'/asset_status')]
    assert len(acks) == 1 and not acks[0]['ok'], acks
    assert (tmp_path / 'voice' / 'upload.part').read_bytes() == b''
    assert m._app.recordings.transfer['offset'] == 0
    assert m._app.recordings.request is None
    assert m._app.recordings.job is None


def test_recording_primitive_strict_and_indexed_hold_accounting():
    m = base.load()
    command = {'type': 'play_recording', 'recording': 'a' * 64, 'duration': 0.125}
    assert m.validate([command]) == [command]
    assert m.validate_indexed({'format': 'indexed-v1', 'commands': [command], 'order': '00'})[0] == [command]
    for changes in ({'recording': '../x'}, {'recording': 'A' * 64}, {'duration': True},
                    {'duration': 0}, {'duration': 3.001}, {'duration': float('nan')},
                    {'duration_ms': 125}, {'duration': None}):
        with pytest.raises(ValueError): m.validate([dict(command, **changes)])
    with pytest.raises(ValueError): m.validate([{'type': 'play_recording', 'recording': 'a' * 64}])
    with pytest.raises(ValueError):
        m.validate_indexed({'format': 'indexed-v1', 'commands': [dict(command, duration=3)], 'order': '00' * 41})


def recording_rig(tmp_path):
    m, ctx, clock, io, client = base.setup()
    io.recording_available = True
    m._app.recordings = m.Recordings(str(tmp_path / 'voice'))
    for _ in range(100): m.ota_step(ctx)
    return m, ctx, clock, io, client


def request(rig, op, **fields):
    m, ctx, clock, io, client = rig
    before = len(client.events)
    message = dict(op=op, transfer_id='transfer', boot=ctx.boot, **fields)
    base.send(client, message, 'asset')
    for _ in range(200):
        m.ota_step(ctx)
        acks = [e for t, e in client.events[before:] if t.endswith(b'/asset_status') and e['op'] == op]
        if acks: return acks[-1]
    pytest.fail('asset ACK missing: ' + op)


def upload(rig, data=b'host MP3 fixture', duration=125):
    ident = hashlib.sha256(data).hexdigest()
    ack = request(rig, 'begin', id=ident, sha256=ident, size=len(data), duration_ms=duration)
    assert ack['ok'], ack
    for offset in range(0, len(data), 512):
        ack = request(rig, 'chunk', offset=offset, data=data[offset:offset + 512].hex())
        assert ack['ok'], ack
    ack = request(rig, 'finish')
    assert ack['ok'], ack
    return ident


def test_transfer_callback_has_no_disk_or_native_effect_and_commits_atomically(tmp_path):
    rig = recording_rig(tmp_path)
    m, ctx, clock, io, client = rig
    root = tmp_path / 'voice'
    data = b'encoded stand-in' * 80
    ident = hashlib.sha256(data).hexdigest()
    message = dict(op='begin', transfer_id='transfer', boot=ctx.boot, id=ident,
                   sha256=ident, size=len(data), duration_ms=125)
    before = sorted(p.name for p in root.iterdir()), list(io.calls)
    base.send(client, message, 'asset')
    assert (sorted(p.name for p in root.iterdir()), io.calls) == before
    for _ in range(20): m.ota_step(ctx)
    assert request(rig, 'chunk', offset=0, data=data[:512].hex())['offset'] == 512
    assert not (root / (ident + '.mp3')).exists()
    assert request(rig, 'chunk', offset=0, data=data[:512].hex())['offset'] == 512
    for offset in range(512, len(data), 512):
        assert request(rig, 'chunk', offset=offset, data=data[offset:offset + 512].hex())['ok']
    assert request(rig, 'finish')['offset'] == len(data)
    assert (root / (ident + '.mp3')).read_bytes() == data
    assert json.loads((root / (ident + '.json')).read_text()) == {
        'id': ident, 'sha256': ident, 'size': len(data), 'duration_ms': 125}
    assert request(rig, 'status', id=ident)['offset'] == len(data)
    assert request(rig, 'finish')['ok'], 'lost finish ACK must be safely retryable'
    assert request(rig, 'delete', id=ident)['ok']
    assert not list(root.iterdir())
    assert request(rig, 'status', id=ident)['error'] == 'missing'
    assert all(call == ('stop',) for call in io.calls)


def native_rig(tmp_path, monkeypatch, broken=None):
    rig = recording_rig(tmp_path)
    m, ctx, clock, _, client = rig
    calls, faults = [], set()
    def call(name):
        def invoked(*args):
            frame = inspect.currentframe().f_back
            assert frame.f_code.co_name in ('execute', 'stop')
            assert frame.f_back.f_code.co_name == 'ota_step'
            calls.append((name, args))
            if name in faults: raise RuntimeError(name + ' failure')
        return invoked
    speaker = SimpleNamespace(play_speed=100)
    setattr(speaker, '__play_mp3', call('mp3'))
    modules = {
        'driver.speaker': SimpleNamespace(speaker_obj=speaker, SOUNDS_TYPE_MP3_SOURCE=5),
        'global_objects': SimpleNamespace(mp3_music_o=SimpleNamespace(PLAYER_MODE_MP3=1, play=call('unused'), stop=call('unused'))),
        'cyberpi': SimpleNamespace(wifi=SimpleNamespace(is_connect=lambda: True), audio=SimpleNamespace(stop=call('audio_stop'))),
        'mbot2': SimpleNamespace(EM_stop=call('motor_stop'), starter_shield=SimpleNamespace(dc_motor_stop=call('dc_stop'))),
        'mbuild': SimpleNamespace(), 'simple_mqtt': SimpleNamespace(MQTTClient=base.Client),
    }
    for name, module in modules.items(): monkeypatch.setitem(sys.modules, name, module)
    if broken == 'absent': monkeypatch.delitem(sys.modules, 'driver.speaker')
    elif broken == 'speed': speaker.play_speed = 99
    elif broken == 'source': modules['driver.speaker'].SOUNDS_TYPE_MP3_SOURCE = 3
    elif broken == 'mode': modules['global_objects'].mp3_music_o.PLAYER_MODE_MP3 = 2
    elif broken == 'call': setattr(speaker, '__play_mp3', None)
    io = m.native()['io']
    assert calls == [], 'native constructor must not start/stop audio or other hardware'
    io.recording_root = str(tmp_path / 'voice')
    m._app.io = io
    return (m, ctx, clock, io, client), calls, faults


@pytest.mark.parametrize('indexed', [False, True])
def test_native_recording_exact_source_bytes_stop_before_completion_and_next(tmp_path, monkeypatch, indexed):
    rig, calls, faults = native_rig(tmp_path, monkeypatch)
    m, ctx, clock, io, client = rig
    data = b'encoded MP3 source fixture'
    ident = upload(rig, data)
    m._app.status(); m.ota_step(ctx)
    status = [e for t, e in client.events if t.endswith(b'/status')][-1]
    assert 'recorded_audio_v1' in status['capabilities'] and 'play_recording' in status['capabilities']
    command = {'type': 'play_recording', 'recording': ident, 'duration': 0.125}
    program = {'format': 'indexed-v1', 'commands': [command], 'order': '0000'} if indexed else [command, command]
    base.send(client, {'run_id': 'voice', 'program': program}, 'program')
    m.ota_step(ctx)
    assert calls == []
    m.ota_step(ctx)
    assert calls == [('mp3', (data, 100, 5, False))]
    assert io.recording_buffer == data and m._app.motor_stop_needed
    clock.now = (clock.now + 124) % 65536
    m.ota_step(ctx)
    assert not any(e.get('event') == 'completed' and e.get('run_id') == 'voice' for _, e in client.events)
    clock.now = (clock.now + 1) % 65536
    m.ota_step(ctx)
    assert [name for name, _ in calls] == ['mp3', 'motor_stop', 'dc_stop', 'audio_stop']
    assert io.recording_buffer is None
    m.ota_step(ctx); m.ota_step(ctx)
    assert calls[-1] == ('mp3', (data, 100, 5, False))
    clock.now = (clock.now + 125) % 65536
    m.ota_step(ctx)
    assert io.recording_buffer is None and not m._app.motor_stop_needed
    assert any(e.get('type') == 'program' and e.get('event') == 'completed' and e.get('run_id') == 'voice' for _, e in client.events)


@pytest.mark.parametrize('broken', ['absent', 'speed', 'source', 'mode', 'call'])
def test_capability_fails_closed_without_cached_native_contract(tmp_path, monkeypatch, broken):
    rig, calls, faults = native_rig(tmp_path, monkeypatch, broken)
    m, ctx, clock, io, client = rig
    assert not io.recording_available
    m._app.status(); m.ota_step(ctx)
    status = [e for t, e in client.events if t.endswith(b'/status')][-1]
    assert 'recorded_audio_v1' not in status['capabilities']
    assert calls == []


@pytest.mark.parametrize('duration', [0.124, 0.126, 3])
@pytest.mark.parametrize('indexed', [False, True])
def test_wrong_recording_duration_rejects_whole_program_before_native(tmp_path, monkeypatch, duration, indexed):
    rig, calls, faults = native_rig(tmp_path, monkeypatch)
    m, ctx, clock, io, client = rig
    ident = upload(rig)
    commands = [{'type': 'play_sound', 'sound': 'hello'}, {'type': 'play_recording', 'recording': ident, 'duration': duration}]
    program = {'format': 'indexed-v1', 'commands': commands, 'order': '0001'} if indexed else commands
    base.send(client, {'run_id': 'bad', 'program': program}, 'program')
    m.ota_step(ctx)
    assert not any(e.get('run_id') == 'bad' and e.get('event') == 'started' for _, e in client.events)
    assert m._app.native_pending is None and m._app.blocks is None
    assert any(e.get('error') == 'recording_duration' for _, e in client.events)


@pytest.mark.parametrize('interruption', ['stop', 'emergency', 'ota', 'disconnect', 'identity', 'native', 'timer'])
@pytest.mark.parametrize('stop_fault', ['audio_stop', 'motor_stop', 'dc_stop'])
def test_recording_stop_obligation_buffer_retention_and_recovery(tmp_path, monkeypatch, interruption, stop_fault):
    rig, calls, faults = native_rig(tmp_path, monkeypatch)
    m, ctx, clock, io, client = rig
    ident = upload(rig)
    command = {'type': 'play_recording', 'recording': ident, 'duration': 0.125}
    base.send(client, dict(command, run_id='voice'))
    m.ota_step(ctx)
    if interruption == 'native': faults.add('mp3')
    else: m.ota_step(ctx)
    faults.add(stop_fault)
    if interruption == 'stop': base.send(client, {'type': 'stop'})
    elif interruption == 'emergency': base.send(client, {}, 'emergency')
    elif interruption == 'ota': client.callback(m._app.ota_topic, b'{}')
    elif interruption == 'disconnect': client.fail = True
    elif interruption == 'timer': clock.now = (clock.now + 125) % 65536
    wrong = SimpleNamespace(**vars(ctx)); wrong.sha256 = 'b' * 64
    try: m.ota_step(wrong if interruption == 'identity' else ctx)
    except RuntimeError: pass
    assert m._app.motor_stop_needed and io.recording_buffer is not None
    assert m._app.blocks is None and m._app.timer is None
    before = len(client.events)
    calls.clear()
    base.send(client, {'run_id': 'stale', 'type': 'wait', 'duration': 0})
    m.ota_step(ctx)  # Retry remains inside the application, not loader eviction.
    assert [name for name, _ in calls] == ['motor_stop', 'dc_stop', 'audio_stop']
    assert len(client.events) == before
    faults.clear()
    clock.now = (clock.now + 2001) % 65536
    for _ in range(10): m.ota_step(ctx)
    assert io.recording_buffer is None and not m._app.motor_stop_needed
    client = m._app.client
    assert not any(e.get('run_id') == 'stale' for _, e in client.events)
    base.send(client, dict(command, run_id='fresh'))
    m.ota_step(ctx); m.ota_step(ctx)
    assert io.recording_buffer is not None
    clock.now = (clock.now + 125) % 65536
    m.ota_step(ctx)
    assert io.recording_buffer is None
    assert any(e.get('run_id') == 'fresh' and e.get('type') == 'program' and e.get('event') == 'completed' for _, e in client.events)


@pytest.mark.parametrize('kind', ['move_forward', 'move_backward', 'dc_motor', 'turn_left', 'turn_right', 'start', 'tap'])
def test_real_resident_loader_retains_retry_owner_and_recovers(monkeypatch, kind):
    from test_ota_loader import ControllerTests
    m, ctx, clock, io, client = base.setup()
    active, faults, trace = set(), set(), []
    def start(command):
        active.add('motor')
        if command['type'].startswith('turn'): raise RuntimeError('turn moved then threw')
    def stop():
        trace.append('stop')
        if 'stop' in faults: raise RuntimeError('stop unavailable')
        active.clear()
    io.execute, io.stop = start, stop
    io.drive = lambda direction, speed: active.add('motor')
    controller, events, engine, transport, mailbox, app = ControllerTests().fixture()
    engine.trial = None
    controller.start(); controller.context = ctx; app['ota_step'] = m.ota_step
    if kind in ('start', 'tap'):
        base.send(client, dict(op=kind, hold_id='hold', boot=ctx.boot, direction='forward', speed=20), 'drive')
    else:
        command = {'type': kind, 'angle': 30} if kind.startswith('turn') else {'type': kind, 'duration': 0.001}
        if kind == 'dc_motor': command['port'] = 'M1'
        base.send(client, {'run_id': 'active', 'program': [command]}, 'program')
    controller.cycle(clock.now)
    if kind.startswith('turn'): faults.add('stop')
    controller.cycle(clock.now)
    assert active
    faults.add('stop')
    if kind == 'start': base.send(client, dict(op='stop', hold_id='hold', boot=ctx.boot), 'drive')
    elif not kind.startswith('turn'): clock.now = (clock.now + (400 if kind == 'tap' else 1)) % 65536
    for _ in range(4): controller.cycle(clock.now)
    assert controller.app is not None and m._app.motor_stop_needed, events
    before = len(client.events)
    base.send(client, {'run_id': 'stale', 'type': 'wait', 'duration': 0})
    controller.cycle(clock.now)
    assert len(client.events) == before
    faults.clear()
    for _ in range(4): controller.cycle(clock.now)
    assert not active and controller.app is not None and not m._app.motor_stop_needed
    assert not any(e.get('run_id') == 'stale' for _, e in client.events)
    if kind not in ('start', 'tap'):
        terminal = [e for _, e in client.events if e.get('type') == 'program' and e.get('event') == 'failed']
        assert len(terminal) == 1 and terminal[0]['error'] == ('turn moved then threw' if kind.startswith('turn') else 'stop unavailable')
    base.send(client, {'run_id': 'fresh', 'type': 'wait', 'duration': 0})
    controller.cycle(clock.now)
    assert any(e.get('run_id') == 'fresh' and e.get('type') == 'program' and e.get('event') == 'completed' for _, e in client.events)


@pytest.mark.parametrize('kind', ['move_forward', 'move_backward', 'dc_motor'])
def test_overdue_timer_stops_before_app_network(monkeypatch, kind):
    m, ctx, clock, io, client = base.setup()
    active = set()
    io.execute = lambda b: active.add(True)
    io.stop = lambda: active.clear()
    command = dict(type=kind, duration=0.001)
    if kind == 'dc_motor': command['port'] = 'M1'
    base.send(client, command)
    m.ota_step(ctx); m.ota_step(ctx)
    observed = []
    def network():
        observed.append(bool(active))
        clock.now = (clock.now + 1000) % 65536
    client.check_msg = network
    clock.now = (clock.now + 1) % 65536
    m.ota_step(ctx)
    assert not active and not any(observed)


@pytest.mark.parametrize('change', [
    {'id': '../app_a.py'}, {'id': 'A' * 64}, {'sha256': 'b' * 64},
    {'size': 0}, {'size': 24577}, {'size': True}, {'duration_ms': 0},
    {'duration_ms': 3001}, {'duration_ms': 1.5}, {'duration_ms': True},
    {'extra': 'x'}, {'boot': 'stale'}, {'transfer_id': ''}, {'transfer_id': 'x' * 65},
])
def test_malformed_begin_never_writes(tmp_path, change):
    rig = recording_rig(tmp_path)
    m, ctx, clock, io, client = rig
    message = dict(op='begin', transfer_id='transfer', boot=ctx.boot, id='a' * 64,
                   sha256='a' * 64, size=1, duration_ms=1)
    message.update(change)
    base.send(client, message, 'asset'); m.ota_step(ctx)
    assert not [e for t, e in client.events if t.endswith(b'/asset_status')][-1]['ok']
    assert not list((tmp_path / 'voice').iterdir())


@pytest.mark.parametrize('change', [
    {'offset': True}, {'offset': -1}, {'offset': 24577}, {'data': ''}, {'data': 'a'},
    {'data': 'aa' * 513}, {'data': 'gg'}, {'data': ' aa '}, {'data': ['aa']},
    {'data': {'hex': 'aa'}}, {'extra': 1}, {'boot': 'stale'}, {'transfer_id': 'other'},
])
def test_malformed_chunk_rejected_without_modifying_upload(tmp_path, change):
    rig = recording_rig(tmp_path)
    m, ctx, clock, io, client = rig
    assert request(rig, 'begin', id='a' * 64, sha256='a' * 64, size=3, duration_ms=1)['ok']
    message = dict(op='chunk', transfer_id='transfer', boot=ctx.boot, offset=0, data='aa')
    message.update(change)
    base.send(client, message, 'asset')
    for _ in range(4): m.ota_step(ctx)
    assert not [e for t, e in client.events if t.endswith(b'/asset_status')][-1]['ok']
    assert (tmp_path / 'voice' / 'upload.part').read_bytes() == b''
    assert m._app.recordings.transfer['offset'] == 0


@pytest.mark.parametrize('cause', ['stop', 'emergency', 'ota', 'network', 'expiry', 'abort'])
def test_transfer_cancellation_discards_stale_work_and_allows_fresh_upload(tmp_path, cause):
    rig = recording_rig(tmp_path)
    m, ctx, clock, io, client = rig
    assert request(rig, 'begin', id='a' * 64, sha256='a' * 64, size=3, duration_ms=1)['ok']
    assert request(rig, 'chunk', offset=0, data='aa')['ok']
    base.send(client, {'type': 'play_sound', 'sound': 'hello', 'run_id': 'stale'})
    base.send(client, dict(op='tap', hold_id='stale', boot=ctx.boot, direction='forward', speed=20), 'drive')
    if cause == 'stop': base.send(client, {'type': 'stop'})
    elif cause == 'emergency': base.send(client, {}, 'emergency')
    elif cause == 'ota': client.callback(m._app.ota_topic, b'{}')
    elif cause == 'network': client.fail = True
    elif cause == 'expiry': clock.now = (clock.now + 10000) % 65536
    else: assert request(rig, 'abort')['ok']
    m.ota_step(ctx)
    clock.now = (clock.now + 2001) % 65536
    for _ in range(12): m.ota_step(ctx)
    assert m._app.recordings.transfer is None and not m._app.asset_busy()
    assert not list((tmp_path / 'voice').iterdir())
    assert not any(call[0] == 'play_sound' for call in io.calls)
    rig = m, ctx, clock, io, m._app.client
    assert upload(rig)


def test_eight_asset_quota_deletion_replacement_and_restart(tmp_path):
    rig = recording_rig(tmp_path)
    m, ctx, clock, io, client = rig
    ids = [upload(rig, bytes([i]) * 20) for i in range(8)]
    assert request(rig, 'begin', id='a' * 64, sha256='a' * 64, size=3, duration_ms=1)['error'] == 'quota'
    assert upload(rig, bytes([0]) * 20) == ids[0]
    assert request(rig, 'delete', id=ids[1])['ok']
    ninth = upload(rig, b'ninth')
    m._app.recordings = m.Recordings(str(tmp_path / 'voice'))
    for _ in range(100): m.ota_step(ctx)
    assert len(m._app.recordings.assets) == 8 and ninth in m._app.recordings.assets
    assert request(rig, 'status', id=ids[1])['error'] == 'missing'


@pytest.mark.parametrize('failure', ['digest', 'size', 'reserve', 'write'])
def test_storage_failure_never_commits_and_recovers(tmp_path, monkeypatch, failure):
    import os
    rig = recording_rig(tmp_path)
    m, ctx, clock, io, client = rig
    data = b'abc'; ident = hashlib.sha256(data).hexdigest()
    original = os.statvfs
    if failure == 'reserve': monkeypatch.setattr(os, 'statvfs', lambda path: (4096, 4096, 80, 80, 64, 0, 0, 0, 0, 255))
    ack = request(rig, 'begin', id=ident, sha256=ident, size=3, duration_ms=1)
    if failure == 'reserve':
        assert not ack['ok'] and ack['error'] == 'space'
        monkeypatch.setattr(os, 'statvfs', original)
    else:
        assert ack['ok']
        if failure == 'write':
            def fail_open(*args, **kwargs): raise OSError(28, 'disk full')
            monkeypatch.setattr(m, 'open', fail_open, raising=False)
        ack = request(rig, 'chunk', offset=0, data=(b'ab' if failure == 'size' else b'bad' if failure == 'digest' else data).hex())
        if failure == 'write':
            assert not ack['ok']
            monkeypatch.delattr(m, 'open')
        else: assert not request(rig, 'finish')['ok']
    for _ in range(10): m.ota_step(ctx)
    assert not (tmp_path / 'voice' / (ident + '.mp3')).exists()
    assert not m._app.recordings.assets
    assert upload(rig, data) == ident


def test_max_asset_finish_retries_coalesce_and_bounded_reads(tmp_path, monkeypatch):
    import builtins
    rig = recording_rig(tmp_path)
    m, ctx, clock, io, client = rig
    data = b'x' * 24576; ident = hashlib.sha256(data).hexdigest()
    assert request(rig, 'begin', id=ident, sha256=ident, size=len(data), duration_ms=3000)['ok']
    for offset in range(0, len(data), 512): assert request(rig, 'chunk', offset=offset, data=data[offset:offset + 512].hex())['ok']
    reads = []
    class File:
        def __init__(self, stream): self.stream = stream
        def __enter__(self): self.stream.__enter__(); return self
        def __exit__(self, *args): return self.stream.__exit__(*args)
        def __getattr__(self, key): return getattr(self.stream, key)
        def read(self, size=-1):
            reads.append(size); assert 0 < size <= 512
            return self.stream.read(size)
    monkeypatch.setattr(m, 'open', lambda *args, **kwargs: File(builtins.open(*args, **kwargs)), raising=False)
    message = dict(op='finish', transfer_id='transfer', boot=ctx.boot)
    start = len(client.events)
    for _ in range(60):
        before = len(reads)
        base.send(client, message, 'asset')
        m.ota_step(ctx)
        assert len(reads) - before <= 1
    acks = [e for t, e in client.events[start:] if t.endswith(b'/asset_status')]
    assert acks and all(e['ok'] for e in acks), acks
    assert sum(reads) == len(data)
    assert (tmp_path / 'voice' / (ident + '.mp3')).read_bytes() == data


def test_existing_id_cannot_change_duration_metadata(tmp_path):
    rig = recording_rig(tmp_path)
    ident = upload(rig, b'abc', 125)
    ack = request(rig, 'begin', id=ident, sha256=ident, size=3, duration_ms=126)
    assert not ack['ok'] and ack['error'] == 'metadata_conflict'
    assert rig[0]._app.recordings.assets[ident]['duration_ms'] == 125


def test_stop_during_startup_asset_scan_can_recover_capability(tmp_path):
    rig = recording_rig(tmp_path)
    m, ctx, clock, io, client = rig
    ident = upload(rig)
    m._app.recordings = m.Recordings(str(tmp_path / 'voice'))
    m.ota_step(ctx)
    base.send(client, {}, 'emergency')
    for _ in range(30): m.ota_step(ctx)
    assert m._app.recordings.ready and ident in m._app.recordings.assets


@pytest.mark.parametrize('interruption', ['stop', 'emergency'])
def test_stop_at_audio_deadline_cancels_instead_of_completing(tmp_path, monkeypatch, interruption):
    rig, calls, faults = native_rig(tmp_path, monkeypatch)
    m, ctx, clock, io, client = rig
    ident = upload(rig)
    base.send(client, {'run_id': 'voice', 'type': 'play_recording', 'recording': ident, 'duration': 0.125})
    m.ota_step(ctx); m.ota_step(ctx)
    clock.now = (clock.now + 125) % 65536
    base.send(client, {'type': 'stop'}, 'command' if interruption == 'stop' else 'emergency')
    m.ota_step(ctx)
    assert io.recording_buffer is None
    assert not any(e.get('run_id') == 'voice' and e.get('event') == 'completed' for _, e in client.events)
    assert any(e.get('run_id') == 'voice' and e.get('event') == 'canceled' for _, e in client.events)


@pytest.mark.parametrize('milliseconds', [1001, 1003, 2002, 3000])
def test_recording_timer_preserves_exact_metadata_milliseconds(tmp_path, monkeypatch, milliseconds):
    rig, calls, faults = native_rig(tmp_path, monkeypatch)
    m, ctx, clock, io, client = rig
    ident = upload(rig, duration=milliseconds)
    base.send(client, {'type': 'play_recording', 'recording': ident, 'duration': milliseconds / 1000})
    m.ota_step(ctx); m.ota_step(ctx)
    assert m._app.timer[1] == milliseconds


@pytest.mark.parametrize('fault', ['motor_stop', 'dc_stop', 'audio_stop'])
@pytest.mark.parametrize('cause', ['timer', 'native', 'publish', 'emergency'])
def test_real_loader_recording_native_recovery_keeps_buffer_and_original_terminal(tmp_path, monkeypatch, fault, cause):
    from test_ota_loader import ControllerTests
    rig, calls, faults = native_rig(tmp_path, monkeypatch)
    m, ctx, clock, io, client = rig
    ident = upload(rig)
    controller, events, engine, transport, mailbox, app = ControllerTests().fixture()
    engine.trial = None
    controller.start(); controller.context = ctx; app['ota_step'] = m.ota_step
    base.send(client, {'run_id': 'voice', 'type': 'play_recording', 'recording': ident, 'duration': 0.125})
    controller.cycle(clock.now)
    if cause == 'native': faults.update({fault, 'mp3'})
    controller.cycle(clock.now)
    assert io.recording_buffer is not None
    faults.add(fault)
    if cause == 'timer': clock.now = (clock.now + 125) % 65536
    elif cause == 'emergency': base.send(client, {}, 'emergency')
    elif cause == 'publish':
        def failed_publish(*args, **kwargs): raise OSError('publish unavailable')
        client.publish = failed_publish
        m._app.status()
    for _ in range(4): controller.cycle(clock.now)
    assert controller.app is not None and m._app.motor_stop_needed and io.recording_buffer is not None
    faults.clear()
    clock.now = (clock.now + 2001) % 65536
    for _ in range(15): controller.cycle(clock.now)
    assert controller.app is not None and io.recording_buffer is None and not m._app.motor_stop_needed
    client = m._app.client
    terminal = [e for _, e in client.events if e.get('run_id') == 'voice' and e.get('type') == 'program' and e.get('event') in ('failed', 'canceled')]
    assert len(terminal) == 1, terminal
    assert not any(e.get('run_id') == 'voice' and e.get('event') == 'completed' for _, e in client.events)
    base.send(client, {'run_id': 'fresh', 'type': 'wait', 'duration': 0})
    controller.cycle(clock.now)
    assert any(e.get('run_id') == 'fresh' and e.get('event') == 'completed' for _, e in client.events)


@pytest.mark.parametrize('cause', ['stop', 'emergency'])
def test_explicit_stop_failure_without_motor_still_retains_loader_retry(tmp_path, monkeypatch, cause):
    from test_ota_loader import ControllerTests
    rig, calls, faults = native_rig(tmp_path, monkeypatch)
    m, ctx, clock, io, client = rig
    controller, events, engine, transport, mailbox, app = ControllerTests().fixture()
    engine.trial = None
    controller.start(); controller.context = ctx; app['ota_step'] = m.ota_step
    base.send(client, {'run_id': 'wait', 'type': 'wait', 'duration': 5})
    controller.cycle(clock.now)
    faults.add('audio_stop')
    base.send(client, {'type': 'stop'}, 'command' if cause == 'stop' else 'emergency')
    for _ in range(4): controller.cycle(clock.now)
    assert controller.app is not None and m._app.motor_stop_needed
    count = len(client.events)
    base.send(client, {'run_id': 'stale', 'type': 'wait', 'duration': 0})
    controller.cycle(clock.now)
    assert len(client.events) == count
    faults.clear()
    for _ in range(10): controller.cycle(clock.now)
    assert not m._app.motor_stop_needed
    assert not any(e.get('run_id') == 'stale' for _, e in client.events)


def test_dense_staged_target_runs_recording_pipeline_without_extra_native_frame(tmp_path, monkeypatch):
    import pathlib
    import runpy
    import time
    rig, calls, faults = native_rig(tmp_path, monkeypatch)
    original, ctx, clock, _, _ = rig
    monkeypatch.setattr(time, 'ticks_ms', clock.ticks_ms, raising=False)
    monkeypatch.setattr(time, 'ticks_diff', clock.ticks_diff, raising=False)
    builder = runpy.run_path(str(pathlib.Path(__file__).parents[1] / 'tools/build-robot-control.py'))
    source = "ROBOT_DEVICE='test'\nROBOT_MQTT_BROKER='test'\nROBOT_TOPIC_PREFIX='mbot-studio'\n" + base.PATH.read_text()
    dense = builder['dense_source'](source)
    staged = builder['staged_source'](dense)
    ns = {'__name__': 'host_staged_recording_test'}
    exec(compile(staged, 'host_staged_recording_test', 'exec'), ns)
    ns['ota_init'](ctx)
    for _ in range(len(ns['_stage_sections'])): ns['ota_step'](ctx)
    target = ns['_stage_ns']
    Store = target['Recordings']
    class TempStore(Store):
        def __init__(self): super().__init__(str(tmp_path / 'voice'))
    target['Recordings'] = TempStore
    ns['ota_step'](ctx)  # Target init/handoff, no native effects.
    assert calls == []
    target['_app'].io.recording_root = str(tmp_path / 'voice')
    for _ in range(10): ns['ota_step'](ctx)
    calls.clear()
    client = target['_app'].client
    module = SimpleNamespace(ota_step=ns['ota_step'], _app=target['_app'])
    ident = upload((module, ctx, clock, module._app.io, client))
    base.send(client, {'type': 'play_recording', 'recording': ident, 'duration': 0.125})
    ns['ota_step'](ctx); ns['ota_step'](ctx)
    assert calls[0][0] == 'mp3'
    clock.now = (clock.now + 125) % 65536
    ns['ota_step'](ctx)
    assert module._app.io.recording_buffer is None


@pytest.mark.parametrize('enforce_phase', ['startup', 'begin', 'chunk', 'finish', 'status', 'readback', 'delete', 'json', 'metadata'])
def test_staged_loader_filesystem_boundaries_are_shallow(tmp_path, monkeypatch, enforce_phase):
    """Model native stack headroom, not CPython's unrelated recursion limit.

    Every filesystem boundary has at most execute -> ota_step -> _cycle ->
    cycle. A generator suspended by the scheduler must not remain on-stack.
    """
    import builtins
    import os
    import pathlib
    import runpy
    import time
    from test_ota_loader import ControllerTests

    rig, calls, faults = native_rig(tmp_path, monkeypatch)
    _, ctx, clock, _, _ = rig
    monkeypatch.setattr(time, 'ticks_ms', clock.ticks_ms, raising=False)
    monkeypatch.setattr(time, 'ticks_diff', clock.ticks_diff, raising=False)
    builder = runpy.run_path(str(pathlib.Path(__file__).parents[1] / 'tools/build-robot-control.py'))
    source = "ROBOT_DEVICE='test'\nROBOT_MQTT_BROKER='test'\nROBOT_TOPIC_PREFIX='mbot-studio'\n" + base.PATH.read_text()
    staged = builder['staged_source'](builder['dense_source'](source))
    ns = {'__name__': 'host_staged_filesystem_test'}
    exec(compile(staged, 'host_staged_filesystem_test', 'exec'), ns)
    controller, events, engine, transport, mailbox, app = ControllerTests().fixture()
    engine.trial = None
    controller.start()
    controller.context, controller.app = ctx, ns
    ns['ota_init'](ctx)
    for _ in range(len(ns['_stage_sections'])): controller.cycle(clock.now)
    target = ns['_stage_ns']
    Store = target['Recordings']
    root = str(tmp_path / 'shallow')
    class TempStore(Store):
        def __init__(self): super().__init__(root)
    target['Recordings'] = TempStore
    controller.cycle(clock.now)
    assert controller.app['ota_step'] is target['ota_step'], 'staged handoff must not add a wrapper'
    target['_app'].io.recording_root = root

    traces, violations = [], []
    phase = ['startup']
    def boundary(name):
        frame = inspect.currentframe().f_back.f_back
        chain = []
        while frame is not None:
            chain.append(frame.f_code.co_name)
            if frame.f_code.co_name == 'cycle': break
            frame = frame.f_back
        traces.append((phase[0], name, chain))
        if phase[0] == enforce_phase and chain != ['execute', 'ota_step', '_cycle', 'cycle']:
            violations.append((phase[0], name, chain))
            raise RuntimeError('maximum recursion depth exceeded')

    def wrapped(name, function):
        def invoke(*args, **kwargs):
            if str(args[0]).startswith(root): boundary(name)
            return function(*args, **kwargs)
        return invoke

    class File:
        def __init__(self, stream): self.stream = stream
        def __enter__(self): boundary('enter'); self.stream.__enter__(); return self
        def __exit__(self, *args): boundary('close'); return self.stream.__exit__(*args)
        def seek(self, *args): boundary('seek'); return self.stream.seek(*args)
        def read(self, *args): boundary('read'); return self.stream.read(*args)
        def write(self, *args): boundary('write'); return self.stream.write(*args)
    def opened(*args, **kwargs):
        boundary('open')
        return File(builtins.open(*args, **kwargs))
    monkeypatch.setitem(target, 'open', opened)
    for name in ('mkdir', 'listdir', 'statvfs', 'stat', 'remove', 'rename'):
        monkeypatch.setattr(os, name, wrapped(name, getattr(os, name)))

    def tick(context):
        before = len(traces)
        controller.context = context
        controller.cycle(clock.now)
        assert not violations, violations
        assert controller.app is ns, events
        if phase[0] != 'readback':
            phases = [row for row in traces[before:] if row[1] in
                      ('open', 'mkdir', 'stat', 'statvfs', 'listdir', 'remove', 'rename')]
            assert len(phases) <= 1, ('more than one disk phase per tick', phases)
    for _ in range(12): tick(ctx)
    client = target['_app'].client
    incoming = []
    callback = client.callback
    client.callback = lambda topic, payload: incoming.append((topic, payload))
    def mqtt_dispatch(topic, payload): callback(topic, payload)
    def mqtt_wait_msg():
        if incoming: mqtt_dispatch(*incoming.pop(0))
    def mqtt_read_packet(): mqtt_wait_msg()
    def check_msg(): mqtt_read_packet()
    client.check_msg = check_msg  # Model the vendor MQTT's nested callback stack.
    validation_traces = []
    def validation_boundary(name):
        frame = inspect.currentframe().f_back.f_back
        chain = []
        while frame is not None:
            chain.append(frame.f_code.co_name)
            if frame.f_code.co_name == 'cycle': break
            frame = frame.f_back
        validation_traces.append((name, chain))
        if phase[0] == 'begin' and enforce_phase == name and chain != ['ota_step', '_cycle', 'cycle']:
            violations.append((name, chain))
            raise RuntimeError('maximum recursion depth exceeded')
    loads = target['json'].loads
    metadata = Store.metadata
    def parsed(payload):
        validation_boundary('json')
        return loads(payload)
    def validated(store, value):
        validation_boundary('metadata')
        return metadata(store, value)
    monkeypatch.setitem(target, 'json', SimpleNamespace(loads=parsed, dumps=json.dumps))
    monkeypatch.setattr(Store, 'metadata', validated)
    module = SimpleNamespace(ota_step=tick, _app=target['_app'])
    rig = module, ctx, clock, module._app.io, client
    data = b'stack-depth MP3 stand-in' * 30
    ident = hashlib.sha256(data).hexdigest()
    phase[0] = 'begin'
    assert request(rig, 'begin', id=ident, sha256=ident, size=len(data), duration_ms=125)['ok']
    assert {name for name, _ in validation_traces} == {'json', 'metadata'}
    assert all(chain == ['ota_step', '_cycle', 'cycle'] for _, chain in validation_traces), validation_traces
    phase[0] = 'chunk'
    for offset in range(0, len(data), 512):
        assert request(rig, 'chunk', offset=offset, data=data[offset:offset + 512].hex())['ok']
    phase[0] = 'finish'
    assert request(rig, 'finish')['ok']
    phase[0] = 'status'
    assert request(rig, 'status', id=ident)['ok']
    phase[0] = 'readback'
    base.send(client, {'type': 'play_recording', 'recording': ident, 'duration': 0.125})
    tick(ctx); tick(ctx)
    assert module._app.io.recording_buffer == data
    clock.now = (clock.now + 125) % 65536
    tick(ctx)
    phase[0] = 'delete'
    assert request(rig, 'delete', id=ident)['ok']
    assert set(row[0] for row in traces) == {'startup', 'begin', 'chunk', 'finish', 'status', 'readback', 'delete'}
    print('filesystem stack traces:', traces)


def test_abort_and_malformed_chunk_acks_keep_owner_id_and_offset(tmp_path):
    rig = recording_rig(tmp_path)
    m, ctx, clock, io, client = rig
    ident = 'a' * 64
    assert request(rig, 'begin', id=ident, sha256=ident, size=3, duration_ms=1)['ok']
    assert request(rig, 'chunk', offset=0, data='aa')['ok']
    ack = request(rig, 'chunk', offset=1, data='bad!')
    assert not ack['ok'] and ack['id'] == ident and ack['offset'] == 1
    ack = request(rig, 'abort')
    assert ack['ok'] and ack['id'] == ident


@pytest.mark.parametrize('cause', ['stop', 'emergency', 'network'])
def test_transfer_stop_precedes_disk_cleanup_and_failed_retry_has_no_network(tmp_path, cause):
    rig = recording_rig(tmp_path)
    m, ctx, clock, io, client = rig
    assert request(rig, 'begin', id='a' * 64, sha256='a' * 64, size=3, duration_ms=1)['ok']
    trace = []
    execute = m._app.recordings.execute
    def disk(action):
        trace.append(('disk', action[0]))
        return execute(action)
    m._app.recordings.execute = disk
    def stop():
        trace.append(('stop',))
        raise RuntimeError('stop unavailable')
    io.stop = stop
    if cause == 'stop': base.send(client, {'type': 'stop'})
    elif cause == 'emergency': base.send(client, {}, 'emergency')
    else: client.fail = True
    m.ota_step(ctx)
    assert trace and trace[0] == ('stop',), trace
    assert not any(row[0] == 'disk' for row in trace), trace
    trace.clear()
    client.check_msg = lambda: trace.append(('network',))
    client.publish = lambda *args, **kwargs: trace.append(('publish',))
    for _ in range(3): m.ota_step(ctx)
    assert trace == [('stop',)] * 3
    assert m._app.recordings.transfer is None
    io.stop = lambda: trace.append(('stopped',))
    for _ in range(5): m.ota_step(ctx)
    assert not m._app.motor_stop_needed
    assert any(row[0] == 'disk' for row in trace)


def test_data_rename_accounts_quota_before_next_tick_stop(tmp_path, monkeypatch):
    import os
    rig = recording_rig(tmp_path)
    m, ctx, clock, io, client = rig
    data = b'abc'
    ident = hashlib.sha256(data).hexdigest()
    assert request(rig, 'begin', id=ident, sha256=ident, size=3, duration_ms=1)['ok']
    assert request(rig, 'chunk', offset=0, data=data.hex())['ok']
    renamed = []
    rename = os.rename
    def record(src, dst):
        result = rename(src, dst)
        renamed.append(dst)
        return result
    monkeypatch.setattr(os, 'rename', record)
    base.send(client, dict(op='finish', transfer_id='transfer', boot=ctx.boot), 'asset')
    for _ in range(10):
        m.ota_step(ctx)
        if renamed: break
    assert renamed == [str(tmp_path / 'voice' / (ident + '.mp3'))]
    assert ident in m._app.recordings.ids, 'a committed file occupies quota even if Stop arrives next'
    assert ident not in m._app.recordings.assets
    base.send(client, {}, 'emergency')
    for _ in range(6): m.ota_step(ctx)
    assert ident in m._app.recordings.ids
    assert not (tmp_path / 'voice' / (ident + '.json')).exists()
    assert request(rig, 'delete', id=ident)['ok']


def test_raw_asset_mailbox_is_one_bounded_slot_without_callback_validation(tmp_path, monkeypatch):
    rig = recording_rig(tmp_path)
    m, ctx, clock, io, client = rig
    message = dict(op='begin', transfer_id='first', boot=ctx.boot, id='a' * 64,
                   sha256='a' * 64, size=3, duration_ms=125)
    wire = json.dumps(message).encode()
    topic = (m._app.prefix + 'asset').encode()
    seen = []
    loads = m.json.loads
    monkeypatch.setattr(m, 'json', SimpleNamespace(loads=lambda raw: (seen.append(raw), loads(raw))[1], dumps=json.dumps))
    before = list(m._app.outgoing)
    client.callback(topic, b'x' * 1601)
    assert m._app.asset_pending is None
    client.callback(topic, wire)
    for _ in range(1000):
        client.callback(topic, wire)
        client.callback(topic, json.dumps(dict(message, transfer_id='foreign')).encode())
    assert m._app.asset_pending is wire and seen == []
    assert m._app.recordings.request is None and m._app.outgoing == before
    base.send(client, {'run_id': 'stale', 'type': 'wait', 'duration': 0})
    base.send(client, dict(op='tap', hold_id='stale', boot=ctx.boot, direction='forward', speed=20), 'drive')
    assert m._app.pending is None and m._app.drive is None
    seen.clear()  # Other protocol callbacks retain their own parsers.
    m.ota_step(ctx)
    assert seen == [wire] and m._app.asset_pending is None
    job = m._app.recordings.job
    client.callback(topic, wire)
    m.ota_step(ctx)
    assert m._app.recordings.job is job, 'in-flight identical retry coalesces'
    for _ in range(6): m.ota_step(ctx)
    acks = [e for t, e in client.events if t.endswith(b'/asset_status')]
    assert len(acks) == 1 and acks[0]['ok'] and acks[0]['transfer_id'] == 'first'
    assert not any(e.get('run_id') == 'stale' for _, e in client.events)


@pytest.mark.parametrize('owner', ['pending', 'blocks', 'timer', 'native_pending', 'action', 'stop_pending', 'sensor_index', 'drive', 'drive_stopping', 'motor_stop_needed', 'initial_stop'])
def test_asset_arriving_under_existing_owner_is_dropped_not_deferred(tmp_path, owner):
    m, ctx, clock, io, client = recording_rig(tmp_path)
    old = getattr(m._app, owner)
    setattr(m._app, owner, True)
    base.send(client, dict(op='begin', transfer_id='stale', boot=ctx.boot, id='a' * 64,
                          sha256='a' * 64, size=3, duration_ms=125), 'asset')
    assert m._app.asset_pending is None
    setattr(m._app, owner, old)
    for _ in range(6): m.ota_step(ctx)
    assert m._app.recordings.transfer is None and not list((tmp_path / 'voice').iterdir())


@pytest.mark.parametrize('cause', ['stop', 'emergency', 'ota', 'network', 'identity'])
def test_raw_asset_mailbox_canceled_before_validation_or_disk(tmp_path, monkeypatch, cause):
    rig = recording_rig(tmp_path)
    m, ctx, clock, io, client = rig
    base.send(client, dict(op='begin', transfer_id='stale', boot=ctx.boot, id='a' * 64,
                          sha256='a' * 64, size=3, duration_ms=125), 'asset')
    assert m._app.asset_pending is not None
    seen = []
    metadata = m._app.recordings.metadata
    monkeypatch.setattr(m._app.recordings, 'metadata', lambda value: (seen.append(value), metadata(value))[1])
    if cause == 'stop': base.send(client, {'type': 'stop'})
    elif cause == 'emergency': base.send(client, {}, 'emergency')
    elif cause == 'ota': client.callback(m._app.ota_topic, b'{}')
    elif cause == 'network': client.fail = True
    else:
        wrong = SimpleNamespace(**vars(ctx)); wrong.sha256 = 'b' * 64
        with pytest.raises(ValueError, match='identity'): m.ota_step(wrong)
    m.ota_step(ctx)
    assert not seen and m._app.asset_pending is None
    assert m._app.recordings.transfer is None
    assert not list((tmp_path / 'voice').iterdir())
    assert not any(t.endswith(b'/asset_status') for t, _ in client.events)
    clock.now = (clock.now + 2001) % 65536
    for _ in range(12): m.ota_step(ctx)
    assert upload((m, ctx, clock, io, m._app.client), b'fresh')


@pytest.mark.parametrize('stage', ['json', 'schema', 'metadata', 'admission', 'operation', 'fs_statvfs', 'fs_create'])
def test_asset_failure_ack_has_bounded_stage_and_correlation(tmp_path, monkeypatch, stage):
    rig = recording_rig(tmp_path)
    m, ctx, clock, io, client = rig
    message = dict(op='begin', transfer_id='transfer', boot=ctx.boot, id='a' * 64,
                   sha256='a' * 64, size=3, duration_ms=125)
    def fail(*args): raise RuntimeError('maximum recursion depth exceeded')
    if stage == 'json':
        monkeypatch.setattr(m, 'json', SimpleNamespace(loads=fail, dumps=json.dumps))
    elif stage == 'schema': message['extra'] = True
    elif stage == 'metadata': monkeypatch.setattr(m._app.recordings, 'metadata', fail)
    elif stage == 'admission': m._app.recordings.ready = False
    elif stage == 'operation':
        def operation(request):
            fail()
            yield
        monkeypatch.setattr(m._app.recordings, 'operation', operation)
    else:
        execute = m._app.recordings.execute
        def disk(action):
            if 'fs_' + action[0] == stage: fail()
            return execute(action)
        monkeypatch.setattr(m._app.recordings, 'execute', disk)
    before = len(client.events)
    base.send(client, message, 'asset')
    assert len(client.events) == before, 'callback must not ACK or parse'
    for _ in range(20): m.ota_step(ctx)
    acks = [e for t, e in client.events[before:] if t.endswith(b'/asset_status')]
    assert len(acks) == 1, acks
    ack = acks[0]
    assert not ack['ok'] and ack.get('error_stage') == stage, ack
    assert len(ack['error_stage']) <= 16 and len(ack['error']) <= 64
    if stage != 'json':
        assert (ack['op'], ack['transfer_id'], ack['id'], ack['boot'], ack['offset']) == (
            'begin', 'transfer', 'a' * 64, ctx.boot, 0)


@pytest.mark.parametrize('completed_upload', [False, True])
def test_real_loader_idle_recordings_stop_admits_fresh_indexed_wait_next_tick(tmp_path, completed_upload):
    from test_ota_loader import ControllerTests
    rig = recording_rig(tmp_path)
    m, ctx, clock, io, client = rig
    if completed_upload: upload(rig)
    store = m._app.recordings
    assert store.ready and store.transfer is None and store.request is None
    controller, events, engine, transport, mailbox, app = ControllerTests().fixture()
    engine.trial = None
    controller.start(); controller.context = ctx; app['ota_step'] = m.ota_step
    program = {'format': 'indexed-v1', 'commands': [{'type': 'wait', 'duration': 5}], 'order': '00'}
    base.send(client, {'run_id': 'waiting', 'program': program}, 'program')
    controller.cycle(clock.now)
    assert m._app.timer is not None
    base.send(client, {}, 'emergency')
    controller.cycle(clock.now)
    canceled = [e for _, e in client.events if e.get('run_id') == 'waiting'
                and e.get('type') == 'program' and e.get('event') == 'canceled']
    assert len(canceled) == 1 and canceled[0]['boot'] == ctx.boot
    assert not m._app.motor_stop_needed and io.calls[-1] == ('stop',)
    # No grace ticks after the correlated terminal: submit immediately.
    program['commands'][0]['duration'] = 0
    base.send(client, {'run_id': 'fresh', 'program': program}, 'program')
    controller.cycle(clock.now)
    assert any(e.get('run_id') == 'fresh' and e.get('type') == 'program'
               and e.get('event') == 'completed' for _, e in client.events)
    assert controller.app is not None and not store.cleanup


@pytest.mark.parametrize('cause', ['emergency', 'abort'])
def test_real_loader_partial_upload_cleanup_keeps_asset_ownership(tmp_path, cause):
    from test_ota_loader import ControllerTests
    m, ctx, clock, io, client = recording_rig(tmp_path)
    controller, events, engine, transport, mailbox, app = ControllerTests().fixture()
    engine.trial = None
    controller.start(); controller.context = ctx; app['ota_step'] = m.ota_step
    module = SimpleNamespace(ota_step=lambda context: controller.cycle(clock.now), _app=m._app)
    rig = module, ctx, clock, io, client
    assert request(rig, 'begin', id='a' * 64, sha256='a' * 64, size=3, duration_ms=1)['ok']
    assert request(rig, 'chunk', offset=0, data='aabb')['ok']
    root = tmp_path / 'voice'
    assert (root / 'upload.part').read_bytes() == b'\xaa\xbb'
    if cause == 'emergency':
        base.send(client, {}, 'emergency')
        controller.cycle(clock.now)
        assert m._app.recordings.cleanup and (root / 'upload.part').exists()
    else:
        base.send(client, dict(op='abort', transfer_id='transfer', boot=ctx.boot), 'asset')
    base.send(client, {'run_id': 'blocked', 'type': 'wait', 'duration': 0})
    assert m._app.pending is None and m._app.asset_busy()
    for _ in range(6): controller.cycle(clock.now)
    assert controller.app is not None and not list(root.iterdir())
    assert not m._app.asset_busy() and not m._app.recordings.temp_dirty
    assert not any(e.get('run_id') == 'blocked' for _, e in client.events)
    if cause == 'abort':
        assert any(t.endswith(b'/asset_status') and e['op'] == 'abort' and e['ok']
                   for t, e in client.events)
    base.send(client, {'run_id': 'fresh', 'type': 'wait', 'duration': 0})
    controller.cycle(clock.now)
    assert any(e.get('run_id') == 'fresh' and e.get('type') == 'program'
               and e.get('event') == 'completed' for _, e in client.events)


@pytest.mark.parametrize('phase', ['startup', 'startup_restart', 'created', 'failed_create', 'metadata_rename'])
def test_cancel_retains_possible_temp_files_until_cleanup(tmp_path, monkeypatch, phase):
    rig = recording_rig(tmp_path)
    m, ctx, clock, io, client = rig
    root = tmp_path / 'voice'
    if phase in ('startup', 'startup_restart'):
        (root / 'upload.part').write_bytes(b'orphan')
        (root / 'metadata.part').write_text('{}')
        m._app.recordings = m.Recordings(str(root))
        if phase == 'startup_restart':
            base.send(client, {}, 'emergency')
            m.ota_step(ctx)
            for _ in range(6):
                m.ota_step(ctx)
                if not m._app.recordings.cleanup: break
            assert not m._app.recordings.ready and m._app.recordings.job is not None
    else:
        store = m._app.recordings
        execute = store.execute
        def disk(action):
            result = execute(action)
            if phase == 'failed_create' and action[0] == 'create':
                raise OSError(28, 'create left a file')
            if phase == 'metadata_rename' and action[0] == 'rename' and action[1].endswith('metadata.part'):
                raise OSError(5, 'rename returned an error after side effect')
            return result
        monkeypatch.setattr(store, 'execute', disk)
        data = b'abc'; ident = hashlib.sha256(data).hexdigest()
        base.send(client, dict(op='begin', transfer_id='transfer', boot=ctx.boot,
                              id=ident, sha256=ident, size=3, duration_ms=1), 'asset')
        for _ in range(5):
            m.ota_step(ctx)
            if (root / 'upload.part').exists(): break
        assert (root / 'upload.part').exists() and store.transfer is None
        if phase == 'failed_create':
            m.ota_step(ctx)  # Error path clears request before invoking cancel.
            assert store.cleanup and store.transfer is None
        elif phase == 'metadata_rename':
            m.ota_step(ctx)
            assert request(rig, 'chunk', offset=0, data=data.hex())['ok']
            assert not request(rig, 'finish')['ok']
            assert store.cleanup and ident in store.ids
    base.send(client, {}, 'emergency')
    m.ota_step(ctx)
    assert m._app.recordings.cleanup
    # Repeated cancellation must not erase an existing cleanup obligation.
    base.send(client, {}, 'emergency')
    for _ in range(20): m.ota_step(ctx)
    assert not (root / 'upload.part').exists() and not (root / 'metadata.part').exists()
    assert m._app.recordings.ready and not m._app.recordings.cleanup


def test_new_raw_request_after_idle_timeout_is_not_expired_as_old_work(tmp_path):
    rig = recording_rig(tmp_path)
    m, ctx, clock, io, client = rig
    upload(rig, b'first')
    clock.now = (clock.now + 10001) % 65536
    assert upload(rig, b'second')


def test_foreign_requests_cannot_extend_transfer_expiry(tmp_path):
    rig = recording_rig(tmp_path)
    m, ctx, clock, io, client = rig
    assert request(rig, 'begin', id='a' * 64, sha256='a' * 64, size=3, duration_ms=1)['ok']
    clock.now = (clock.now + 9000) % 65536
    base.send(client, dict(op='chunk', transfer_id='foreign', boot=ctx.boot, offset=0, data='aa'), 'asset')
    m.ota_step(ctx)
    clock.now = (clock.now + 1000) % 65536
    for _ in range(5): m.ota_step(ctx)
    assert m._app.recordings.transfer is None and not m._app.asset_busy()

