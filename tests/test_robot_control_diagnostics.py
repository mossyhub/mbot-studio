"""Host-only native-boundary diagnostics: publication is not physical proof."""
import inspect
import sys
from types import SimpleNamespace
import pytest
from test_robot_control import setup, send, load, Clock, IO, Client
from test_robot_control import native_sensor_setup


def logs(client):
    return [d for t, d in client.events if t.endswith(b'/log')]


def test_publish_prepare_next_tick_native_return_identity():
    m, ctx, clock, io, client = setup()
    order = []
    publish = client.publish
    def record(topic, payload, **kw):
        publish(topic, payload, **kw)
        d = client.events[-1][1]
        order.append(d.get('event', 'status'))
    client.publish = record
    def execute(b):
        assert inspect.currentframe().f_back.f_code.co_name == 'ota_step'
        order.append('native')
        clock.now = (clock.now + 47) % 65536
    io.execute = execute
    send(client, {'run_id': 'original', 'program': [{'type': 'turn_right', 'angle': 10}]}, 'program')
    m.ota_step(ctx)
    assert order == ['started', 'started', 'native_before']
    assert m._app.index == 0
    m.ota_step(ctx)
    assert order == ['started', 'started', 'native_before', 'native', 'native_after', 'completed', 'completed', 'status']
    before, after = [d for d in logs(client) if d['event'].startswith('native_')]
    for key, value in {'run_id': 'original', 'block_path': [0], 'boot': ctx.boot, 'sha256': ctx.sha256,
                       'build': 'mbot-av-control-v1', 'command': {'type': 'turn_right', 'angle': 10}}.items():
        assert before[key] == after[key] == value
    assert after['elapsed_ms'] == 47
    assert before['diagnostic_revision'] == after['diagnostic_revision']


@pytest.mark.parametrize('mode', ['ok', 'missing', 'error', 'no_module'])
def test_reset_sample_once_after_startup_stop(monkeypatch, mode):
    calls = []
    def reset():
        calls.append('reset')
        if mode == 'error': raise RuntimeError('reset fault')
        return 5
    machine = SimpleNamespace(PWRON_RESET=1, SOFT_RESET=5, reset_cause=reset)
    if mode == 'missing': del machine.reset_cause
    monkeypatch.setitem(sys.modules, 'machine', None if mode == 'no_module' else machine)
    m = load()
    m.ROBOT_DEVICE = m.ROBOT_MQTT_BROKER = 'test'
    m.ROBOT_TOPIC_PREFIX = 'mbot-studio'
    ctx = SimpleNamespace(protocol=1, disarmed=True, device='test', boot='b', sha256='a'*64)
    io = IO()
    io.stop = lambda: calls.append('stop')
    m.ota_init(ctx, {'clock': Clock(), 'io': io, 'mqtt_factory': Client})
    assert calls == []
    m.ota_step(ctx)
    client = m._app.client
    status = next(d for t,d in client.events if t.endswith(b'/status'))
    cause = status['reset_cause']
    assert status['diagnostic_revision'] == 'native-boundary-v1'
    assert status['uptime_ms'] == 65500
    assert calls == (['stop', 'reset'] if mode in ('ok', 'error') else ['stop'])
    assert cause['raw'] == (5 if mode == 'ok' else None)
    assert cause['constants'] == ({} if mode == 'no_module' else {'PWRON_RESET':1, 'SOFT_RESET':5})
    assert ('error' in cause) is (mode != 'ok')
    assert logs(client)[0]['event'] == 'boot'
    assert logs(client)[0]['reset_cause'] == cause
    for _ in range(3): m.ota_step(ctx)
    assert calls.count('reset') == (1 if mode in ('ok', 'error') else 0)


def test_exception_published_before_recovery_stop_even_if_stop_blocks():
    m, ctx, clock, io, client = setup()
    class Blocked(BaseException): pass
    def execute(b):
        clock.now = (clock.now + 13) % 65536
        raise RuntimeError('driver fault')
    def stop():
        diag = logs(client)[-1]
        assert diag['event'] == 'native_exception'
        assert diag['error'] == 'driver fault' and diag['error_type'] == 'RuntimeError'
        assert diag['elapsed_ms'] == 13 and diag['block_path'] == [0]
        assert diag['run_id'] == 'fault'
        raise Blocked()
    io.execute, io.stop = execute, stop
    send(client, {'run_id':'fault', 'type':'turn_left', 'angle':10})
    m.ota_step(ctx)
    with pytest.raises(Blocked): m.ota_step(ctx)
    assert not any(d.get('event') in ('completed','native_after') for _,d in client.events)


def test_blocked_native_has_before_but_no_after_or_completed():
    m, ctx, clock, io, client = setup()
    class Blocked(BaseException): pass
    def execute(b): raise Blocked()
    io.execute = execute
    send(client, {'type':'turn_right', 'angle':10})
    m.ota_step(ctx)
    with pytest.raises(Blocked): m.ota_step(ctx)
    assert logs(client)[-1]['event'] == 'native_before'
    assert not any(d.get('event') in ('completed','native_after') for _,d in client.events)


@pytest.mark.parametrize('interruption', ['stop','emergency','network','identity','publish'])
def test_prepared_action_discarded_no_replay_and_new_command_works(interruption):
    m, ctx, clock, io, client = setup()
    send(client, {'run_id':'old', 'type':'move_forward', 'duration':1})
    if interruption == 'publish':
        publish = client.publish
        def fail(topic, payload, **kw):
            import json
            if json.loads(payload).get('event') == 'native_before': raise OSError('publish failed')
            publish(topic, payload, **kw)
        client.publish = fail
    m.ota_step(ctx)
    assert io.calls == ([('stop',), ('stop',)] if interruption == 'publish' else [('stop',)])
    if interruption in ('stop','emergency'):
        send(client, {'type':'stop'}, 'command' if interruption == 'stop' else 'emergency')
    elif interruption == 'network': client.fail = True
    elif interruption == 'identity':
        wrong = SimpleNamespace(**vars(ctx)); wrong.boot = 'other'
        with pytest.raises(ValueError, match='identity'): m.ota_step(wrong)
    m.ota_step(ctx)
    clock.now = (clock.now + 2001) % 65536
    for _ in range(3): m.ota_step(ctx)
    assert not any(c[0] == 'move_forward' for c in io.calls)
    send(m._app.client, {'run_id':'new', 'type':'servo', 'port':'S1', 'angle':90})
    m.ota_step(ctx)
    assert not any(c[0] == 'servo' for c in io.calls)
    m.ota_step(ctx)
    assert io.calls[-1][0] == 'servo'
    assert any(d.get('run_id') == 'new' and d.get('event') == 'completed' for _,d in m._app.client.events)


def test_battery_snapshot_uses_existing_read_time_not_republished_age(monkeypatch):
    m, ctx, clock, client, calls, values, failures, _, _ = native_sensor_setup(monkeypatch)
    send(client, {'type':'read_sensors'})
    m.ota_step(ctx)
    clock.now = 10
    m.ota_step(ctx)
    clock.now = 20
    m.ota_step(ctx)
    assert calls == ['distance','battery','loudness']
    send(client, {'run_id':'battery', 'type':'turn_left', 'angle':1})
    m.ota_step(ctx)
    assert logs(client)[-1]['battery_snapshot'] == {'value':77, 'ticks_ms':10}
    assert calls == ['distance','battery','loudness'], 'preparation must cancel scan, not poll'
