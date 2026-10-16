"""Indexed Program contract and scheduler; host-only, no robot connection."""
import copy
import importlib.util
import os
from pathlib import Path

import pytest
import test_robot_control as base


def load():
    path = Path(os.environ.get('MBOT_INDEXED_SOURCE', str(base.PATH)))
    spec = importlib.util.spec_from_file_location('indexed_control', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def indexed(commands=None, order='00'):
    return {'format': 'indexed-v1', 'commands': commands or [{'type': 'wait', 'duration': 0}], 'order': order}


def test_dictionary_and_tape_normalize_without_expansion_or_input_mutation():
    m = load()
    program = indexed([{'type': 'wait', 'duration': 0.1},
                       {'type': 'move_forward'}], '0001' * 50)
    original = copy.deepcopy(program)
    assert callable(getattr(m, 'validate_indexed', None)), 'indexed validator missing'
    commands, tape = m.validate_indexed(program)
    assert commands == [{'type': 'wait', 'duration': 0.1},
                        {'type': 'move_forward', 'speed': 20, 'duration': 1}]
    assert type(tape) is bytes and tape == bytes([0, 1]) * 50
    assert program == original


@pytest.mark.parametrize('program', [
    None, [], {}, {'format': 'indexed-v2', 'commands': [{'type': 'stop'}], 'order': '00'},
    dict(indexed(), extra=True), {'format': 'indexed-v1', 'commands': [] , 'order': '00'},
    indexed([{'type': 'stop'}] * 33), indexed(order=''), indexed(order='0'),
    indexed(order='gg'), indexed(order=' 00'), indexed(order='00\n'), indexed(order='00' * 1025),
    indexed(order='01'), indexed(order='ff'), indexed(order=0), indexed(order=['00']),
    indexed([{'type': 'display_animation', 'frames': ['x']}]),
    indexed([{'type': 'repeat', 'count': 1, 'body': []}]),
    indexed([{'type': 'wait', 'duration': True}]),
    indexed([{'type': 'wait', 'duration': float('nan')}]),
    indexed([{'type': 'wait', 'params': {'duration': 0}, 'duration': 0}]),
    indexed([{'type': 'stop'}, {'type': 'wait', 'unknown': 0}], '00'),
    indexed([{'type': 'wait', 'params': {'duration': 0}}]),
    indexed([{'type': 'wait', '_id': 'editor'}]),
    indexed([{'type': 'wait', 'run_id': 'nested'}]),
    indexed([{'type': 'status'}]), indexed([{'type': 'read_sensors'}]),
])
def test_invalid_indexed_shapes_and_unused_tail_are_rejected(program):
    with pytest.raises(ValueError):
        load().validate_indexed(program)


def test_all_32_byte_indexes_and_maximum_tape_are_bounded():
    m = load()
    source = [{'type': 'display_text', 'text': str(i)} for i in range(32)]
    commands, tape = m.validate_indexed(indexed(source, bytes(range(32)).hex().upper() * 32))
    assert len(commands) == 32 and len(tape) == 1024
    assert all('run_id' not in command for command in commands)
    assert tape == bytes(range(32)) * 32


@pytest.mark.parametrize('command,count', [
    ({'type': 'wait'}, 121), ({'type': 'move_forward'}, 121),
    ({'type': 'play_tone'}, 241), ({'type': 'dc_motor', 'port': 'M1'}, 121),
    ({'type': 'wait', 'duration': 0.1200001}, 1000),
    ({'type': 'wait', 'duration': 0.1200000000001}, 1000),
])
def test_total_holds_include_defaults_and_repeated_occurrences(command, count):
    with pytest.raises(ValueError, match='duration'):
        load().validate_indexed(indexed([command], '00' * count))


@pytest.mark.parametrize('duration,count', [(60, 2), (0.12, 1000), (0.1, 1024), (0, 1024), (1e-300, 1024)])
def test_exact_or_lower_120_second_hold_budget(duration, count):
    commands, tape = load().validate_indexed(indexed([{'type': 'wait', 'duration': duration}], '00' * count))
    assert len(commands) == 1 and len(tape) == count


@pytest.fixture
def rig(monkeypatch):
    monkeypatch.setattr(base, 'load', load)
    m, ctx, clock, io, client = base.setup()
    clock.now = (1 << 30) - 100
    clock.ticks_diff = lambda a, b: (a - b + (1 << 29)) % (1 << 30) - (1 << 29)
    return m, ctx, clock, io, client


def advance(clock, ms):
    clock.now = (clock.now + ms) % (1 << 30)


def lifecycle(client, run_id='indexed'):
    return [e for _, e in client.events if e.get('run_id') == run_id and e.get('type') in ('block', 'program')]


def cleared(app):
    assert app.blocks is None and app.tape is None and app.program_started is None
    assert app.timer is None and app.native_pending is None


def test_1024_step_scheduler_uses_bounded_dictionary_and_global_indexes(rig):
    m, ctx, clock, io, client = rig
    base.send(client, {'run_id': 'indexed', 'program': indexed(order='00' * 1024)}, 'program')
    m.ota_step(ctx)
    assert m._app.blocks is not None, 'indexed program was rejected'
    assert 'program_indexed_v1' in m.CAPS
    assert len(m._app.blocks) == 1 and len(m._app.tape) == 1024
    for _ in range(1023):
        advance(clock, 20)
        m.ota_step(ctx)
        assert len(m._app.outgoing) == 0
    events = lifecycle(client)
    assert [(e['type'], e['event'], e.get('path')) for e in events] == [
        ('program', 'started', None)] + [
        ('block', event, [i]) for i in range(1024) for event in ('started', 'completed')
    ] + [('program', 'completed', None)]
    cleared(m._app)
    assert io.calls == [('stop',)]


def test_repeated_native_primitive_identity_is_reused_without_mutation(rig):
    import inspect
    m, ctx, clock, io, client = rig
    refs = []
    original = {'type': 'display_text', 'text': 'same', 'size': 16}
    def execute(command):
        assert inspect.currentframe().f_back.f_code.co_name == 'ota_step'
        assert command == original
        refs.append(command)
    io.execute = execute
    base.send(client, {'run_id': 'indexed', 'program': indexed([original], '00' * 33)}, 'program')
    for _ in range(66): m.ota_step(ctx)
    assert len(refs) == 33 and all(command is refs[0] for command in refs)
    assert refs[0] == original
    cleared(m._app)
    assert [e['path'] for e in lifecycle(client) if e['type'] == 'block' and e['event'] == 'completed'] == [[i] for i in range(33)]


@pytest.mark.parametrize('boundary', ['wait', 'prepared', 'network', 'native', 'publish'])
def test_elapsed_deadline_stops_at_cooperative_boundaries_without_completion(rig, boundary):
    m, ctx, clock, io, client = rig
    command = {'type': 'wait', 'duration': 1} if boundary == 'wait' else {'type': 'display_text', 'text': 'x'}
    base.send(client, {'run_id': 'indexed', 'program': indexed([command], '00' * 2)}, 'program')
    m.ota_step(ctx)
    assert m._app.blocks is not None
    advance(clock, 299999)
    if boundary == 'network':
        client.check_msg = lambda: advance(clock, 1)
    elif boundary == 'native':
        io.execute = lambda b: (io.calls.append(('native',)), advance(clock, 1))
    elif boundary == 'publish':
        original = client.publish
        def publish(*args, **kwargs):
            advance(clock, 1)
            original(*args, **kwargs)
        client.publish = publish
    else:
        advance(clock, 1)
    m.ota_step(ctx)
    assert io.calls[-1] == ('stop',)
    cleared(m._app)
    events = lifecycle(client)
    assert sum(e['type'] == 'program' and e['event'] == 'failed' and e.get('error') == 'elapsed' for e in events) == 1
    assert not any(e['type'] == 'program' and e['event'] == 'completed' for e in events)
    if boundary in ('prepared', 'network'):
        assert io.calls == [('stop',), ('stop',)], 'expired preparation must not reach native IO'


def test_elapsed_stop_failure_is_retained_before_network_and_fresh_work(rig):
    m, ctx, clock, io, client = rig
    base.send(client, {'run_id': 'indexed', 'program': indexed([{'type': 'wait', 'duration': 1}])}, 'program')
    m.ota_step(ctx)
    advance(clock, 300000)
    attempts = []
    def failing_stop():
        attempts.append(True)
        raise RuntimeError('stop-failed')
    io.stop = failing_stop
    m.ota_step(ctx)  # Contained Stop retry; loader retains the app.
    assert m._app.motor_stop_needed
    before = len(client.events)
    base.send(client, {'run_id': 'stale', 'program': indexed()}, 'program')
    m.ota_step(ctx)  # Contained Stop retry; loader retains the app.
    assert len(client.events) == before and len(attempts) == 2
    io.stop = lambda: io.calls.append(('stop',))
    m.ota_step(ctx)
    assert not m._app.motor_stop_needed
    cleared(m._app)
    base.send(client, {'run_id': 'fresh', 'program': indexed()}, 'program')
    m.ota_step(ctx)
    assert any(e['event'] == 'completed' and e['type'] == 'program' for e in lifecycle(client, 'fresh'))
    assert not lifecycle(client, 'stale')


@pytest.mark.parametrize('active_indexed', [False, True])
@pytest.mark.parametrize('late_indexed', [False, True])
def test_busy_indexed_requests_are_rejected_without_canceling_active(rig, active_indexed, late_indexed):
    m, ctx, clock, io, client = rig
    commands = [{'type': 'wait', 'duration': 1}]
    base.send(client, {'run_id': 'active', 'program': indexed(commands) if active_indexed else commands}, 'program')
    m.ota_step(ctx)
    base.send(client, {'run_id': 'late', 'program': indexed() if late_indexed else [{'type': 'wait', 'duration': 0}]}, 'program')
    m.ota_step(ctx)
    if not active_indexed and not late_indexed:
        assert m._app.pending is not None and not lifecycle(client, 'late')
        advance(clock, 1000)
        for _ in range(3): m.ota_step(ctx)
        assert any(e['event'] == 'completed' and e['type'] == 'program' for e in lifecycle(client, 'late'))
        return
    assert any(e['event'] == 'failed' and e.get('error') == 'busy' for e in lifecycle(client, 'late'))
    assert m._app.run_id == 'active' and m._app.blocks is not None
    assert m._app.pending is None
    advance(clock, 1000)
    for _ in range(3): m.ota_step(ctx)
    assert any(e['event'] == 'completed' and e['type'] == 'program' for e in lifecycle(client, 'active'))
    assert not any(e['event'] == 'started' for e in lifecycle(client, 'late'))


@pytest.mark.parametrize('extra', [{'blocks': []}, {'command': {'type': 'stop'}}, {'other': True}])
def test_ambiguous_indexed_envelopes_reject_before_execution(rig, extra):
    m, ctx, clock, io, client = rig
    base.send(client, dict({'run_id': 'bad', 'program': indexed()}, **extra), 'program')
    m.ota_step(ctx)
    assert not any(e['event'] == 'started' for e in lifecycle(client, 'bad'))
    assert any(e['event'] == 'failed' for e in lifecycle(client, 'bad'))
    cleared(m._app)


@pytest.mark.parametrize('interruption', ['emergency', 'stop', 'network', 'publish', 'identity', 'native'])
def test_indexed_cancel_clears_tape_and_can_run_fresh(rig, interruption):
    from types import SimpleNamespace
    m, ctx, clock, io, client = rig
    base.send(client, {'run_id': 'indexed', 'program': indexed([{'type': 'display_text', 'text': 'x'}], '00' * 1024)}, 'program')
    m.ota_step(ctx)
    if interruption == 'identity':
        wrong = SimpleNamespace(**vars(ctx)); wrong.sha256 = 'b' * 64
        with pytest.raises(ValueError, match='identity'): m.ota_step(wrong)
    else:
        if interruption == 'emergency': base.send(client, {}, 'emergency')
        elif interruption == 'stop': base.send(client, {'type': 'stop', 'run_id': 'stop'})
        elif interruption == 'network': client.fail = True
        elif interruption == 'native': io.fail = True
        elif interruption == 'publish':
            def fail(*a, **kw): raise OSError('publish')
            client.publish = fail
        m.ota_step(ctx)
    cleared(m._app)
    assert io.calls[-1] == ('stop',)
    io.fail = False
    advance(clock, 2001)
    m.ota_step(ctx)
    base.send(m._app.client, {'run_id': 'fresh', 'program': indexed()}, 'program')
    m.ota_step(ctx)
    assert any(e['type'] == 'program' and e['event'] == 'completed' for e in lifecycle(m._app.client, 'fresh'))


@pytest.mark.parametrize('interruption', ['emergency', 'network', 'native'])
def test_nonmotor_indexed_failure_also_retains_failed_stop(rig, interruption):
    m, ctx, clock, io, client = rig
    base.send(client, {'run_id': 'indexed', 'program': indexed([{'type': 'play_sound', 'sound': 'hello'}], '00' * 2)}, 'program')
    m.ota_step(ctx)
    def fail_stop(): raise RuntimeError('stop-failed')
    io.stop = fail_stop
    if interruption == 'emergency': base.send(client, {}, 'emergency')
    elif interruption == 'network': client.fail = True
    else: io.fail = True
    # Recovery policy can return after immediate retries, or propagate to loader.
    try: m.ota_step(ctx)
    except RuntimeError: pass
    assert m._app.motor_stop_needed
    cleared(m._app)
    m.ota_step(ctx)  # Contained Stop retry; loader retains the app.
    io.stop = lambda: io.calls.append(('stop',))
    io.fail = False
    m.ota_step(ctx)
    assert not m._app.motor_stop_needed


def test_final_indexed_publish_failure_retains_stop_after_tape_cleanup(rig):
    m, ctx, clock, io, client = rig
    base.send(client, {'run_id': 'indexed', 'program': indexed([{'type': 'play_sound', 'sound': 'hello'}])}, 'program')
    m.ota_step(ctx)
    def failed_publish(*a, **kw): raise OSError('publish-failed')
    def failed_stop(): raise RuntimeError('stop-failed')
    client.publish = failed_publish
    io.stop = failed_stop
    m.ota_step(ctx)  # Contained Stop retry; loader retains the app.
    cleared(m._app)
    assert m._app.motor_stop_needed, 'completion cleared tape but must not erase final-output recovery Stop'
    m.ota_step(ctx)  # Contained Stop retry; loader retains the app.
    io.stop = lambda: io.calls.append(('stop',))
    m.ota_step(ctx)
    assert not m._app.motor_stop_needed


@pytest.mark.parametrize('boundary', ['native', 'publish'])
def test_deadline_stop_failure_keeps_elapsed_terminal_until_recovery(rig, boundary):
    m, ctx, clock, io, client = rig
    base.send(client, {'run_id': 'indexed', 'program': indexed([{'type': 'display_text', 'text': 'x'}], '0000')}, 'program')
    m.ota_step(ctx)
    advance(clock, 299999)
    if boundary == 'native': io.execute = lambda b: advance(clock, 1)
    else:
        publish = client.publish
        def slow_publish(*args, **kwargs):
            advance(clock, 1)
            publish(*args, **kwargs)
        client.publish = slow_publish
    def fail_stop(): raise RuntimeError('stop-failed')
    io.stop = fail_stop
    try: m.ota_step(ctx)
    except RuntimeError: pass
    assert m._app.motor_stop_needed
    io.stop = lambda: io.calls.append(('stop',))
    m.ota_step(ctx)
    terminal = [e for e in lifecycle(client) if e['type'] == 'program' and e['event'] in ('failed', 'completed')]
    assert len(terminal) == 1 and terminal[0].get('error') == 'elapsed'
    cleared(m._app)


def test_indexed_native_failure_stops_before_network_diagnostic(rig):
    m, ctx, clock, io, client = rig
    trace = []
    base.send(client, {'run_id': 'indexed', 'program': indexed([{'type': 'play_sound', 'sound': 'hello'}])}, 'program')
    m.ota_step(ctx)
    def fail(command):
        trace.append('native')
        raise RuntimeError('native-failure')
    io.execute = fail
    io.stop = lambda: trace.append('stop')
    publish = client.publish
    def record(*args, **kwargs):
        trace.append('publish')
        publish(*args, **kwargs)
    client.publish = record
    m.ota_step(ctx)
    assert trace[:2] == ['native', 'stop']
    diagnostics = [e for _, e in client.events if e.get('event') == 'native_exception']
    assert len(diagnostics) == 1


@pytest.mark.parametrize('length', [8191, 8192, 8193])
def test_complete_utf8_payload_ceiling(rig, length):
    import json
    m, ctx, clock, io, client = rig
    request = {'program': indexed([{'type': 'display_text', 'text': 'é漢字'}]),
               'run_id': 'wire', 'timestamp': ''}
    raw = json.dumps(request, ensure_ascii=False, separators=(',', ':')).encode()
    request['timestamp'] = 'x' * (length - len(raw))
    raw = json.dumps(request, ensure_ascii=False, separators=(',', ':')).encode()
    assert len(raw) == length
    client.callback(b'mbot-studio/robot/program', raw)
    m.ota_step(ctx)
    if length <= 8192:
        assert m._app.native_pending is not None
        m.ota_step(ctx)
        assert any(e['type'] == 'program' and e['event'] == 'completed' for e in lifecycle(client, 'wire'))
    else:
        assert not any(call[0] == 'display_text' for call in io.calls)
        assert any(e.get('event') == 'failed' for _, e in client.events)
    cleared(m._app)


@pytest.mark.parametrize('position', [0, 511, 1023])
def test_cancellation_at_first_middle_last_prepared_step(rig, position):
    m, ctx, clock, io, client = rig
    base.send(client, {'run_id': 'indexed', 'program': indexed([{'type': 'display_text', 'text': 'x'}], '00' * 1024)}, 'program')
    for _ in range(position * 2 + 1): m.ota_step(ctx)
    assert m._app.index == position and m._app.native_pending is not None
    base.send(client, {}, 'emergency')
    m.ota_step(ctx)
    assert sum(call[0] == 'display_text' for call in io.calls) == position
    cleared(m._app)
    assert any(e['type'] == 'program' and e['event'] == 'canceled' for e in lifecycle(client))
    base.send(client, {'run_id': 'fresh', 'program': indexed()}, 'program')
    m.ota_step(ctx)
    assert any(e['type'] == 'program' and e['event'] == 'completed' for e in lifecycle(client, 'fresh'))


def test_legacy_32_and_33_limits_and_animation_semantics_remain():
    m = load()
    assert len(m.validate([{'type': 'wait', 'duration': 0}] * 32)) == 32
    with pytest.raises(ValueError): m.validate([{'type': 'wait', 'duration': 0}] * 33)
    assert m.validate([{'type': 'display_animation', 'frames': ['A', 'B']}]) == [
        {'type': 'display_text', 'text': 'A', 'size': 24}, {'type': 'wait', 'duration': 0.5},
        {'type': 'display_text', 'text': 'B', 'size': 24}, {'type': 'wait', 'duration': 0.5}]


@pytest.mark.parametrize('mode', ['start', 'tap'])
def test_indexed_submission_cannot_steal_live_drive_or_resume_after_release(rig, mode):
    m, ctx, clock, io, client = rig
    io.drive = lambda direction, speed: io.calls.append(('drive', direction, speed))
    request = {'op': mode, 'hold_id': 'owned', 'boot': ctx.boot, 'direction': 'forward', 'speed': 20}
    base.send(client, request, 'drive')
    m.ota_step(ctx)
    base.send(client, {'run_id': 'stale', 'program': indexed()}, 'program')
    m.ota_step(ctx)
    assert m._app.drive is not None and m._app.pending is None and m._app.tape is None
    base.send(client, {'op': 'stop', 'hold_id': 'owned', 'boot': ctx.boot}, 'drive')
    m.ota_step(ctx)
    assert not lifecycle(client, 'stale')
    base.send(client, {'run_id': 'fresh', 'program': indexed()}, 'program')
    m.ota_step(ctx)
    assert any(e['type'] == 'program' and e['event'] == 'completed' for e in lifecycle(client, 'fresh'))
