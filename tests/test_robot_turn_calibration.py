"""Directional chassis targets; host-only native stand-ins, never a robot."""
import inspect
import sys
from types import SimpleNamespace

import pytest

from test_robot_control import Client, setup, send


def rig(monkeypatch):
    m, ctx, clock, _, client = setup()
    calls = []

    def turn(*args, **kwargs):
        frame = inspect.currentframe().f_back
        assert frame.f_code.co_name == 'execute'
        assert frame.f_back.f_code.co_name == 'ota_step'
        calls.append(('turn', args, kwargs))

    modules = {
        'mbot2': SimpleNamespace(turn=turn, EM_stop=lambda: calls.append(('em_stop',)),
            starter_shield=SimpleNamespace(dc_motor_stop=lambda: calls.append(('dc_stop',)))),
        'cyberpi': SimpleNamespace(wifi=SimpleNamespace(is_connect=lambda: True),
            audio=SimpleNamespace(stop=lambda: calls.append(('audio_stop',)))),
        'mbuild': SimpleNamespace(),
        'simple_mqtt': SimpleNamespace(MQTTClient=Client),
    }
    for name, module in modules.items():
        monkeypatch.setitem(sys.modules, name, module)
    m._app.io = m.native()['io']
    return m, ctx, clock, client, calls


@pytest.mark.parametrize('direction,native_angle', [('left', -215), ('right', 198)])
def test_displayed_quarter_turn_is_one_directionally_calibrated_native_call(monkeypatch, direction, native_angle):
    m, ctx, _, client, calls = rig(monkeypatch)
    send(client, {'type': 'turn_' + direction, 'angle': 90, 'run_id': 'quarter'})
    m.ota_step(ctx)
    assert calls == [], 'native preparation must remain a separate tick'
    assert m._app.native_pending[0][1]['angle'] == 90
    m.ota_step(ctx)
    assert calls == [('turn', (native_angle,), {})], 'do not override native default speed'
    for _ in range(3):
        m.ota_step(ctx)
    assert calls == [('turn', (native_angle,), {})], 'no repeated or split turn'
    assert any(e.get('run_id') == 'quarter' and e.get('type') == 'program'
               and e.get('event') == 'completed' for _, e in client.events)


@pytest.mark.parametrize('direction', ['left', 'right'])
@pytest.mark.parametrize('angle', [180.000001, 220, 360])
@pytest.mark.parametrize('indexed', [False, True])
def test_calibrated_limit_rejects_whole_program_before_any_native_effect(monkeypatch, direction, angle, indexed):
    m, ctx, _, client, calls = rig(monkeypatch)
    commands = [{'type': 'turn_right', 'angle': 90},
                {'type': 'turn_' + direction, 'angle': angle}]
    plan = {'format': 'indexed-v1', 'commands': commands, 'order': '00'} if indexed else commands
    send(client, {'run_id': 'oversized', 'program': plan}, 'program')
    for _ in range(4):
        m.ota_step(ctx)
    assert not any(c[0] == 'turn' for c in calls)
    assert any(e.get('run_id') == 'oversized' and e.get('event') == 'failed'
               and e.get('error') == 'angle' for _, e in client.events)
    assert m._app.blocks is None and m._app.native_pending is None


def test_status_advertises_calibrated_targets_and_owner_reference():
    m, _, _, _, client = setup()
    status = next(e for _, e in client.events if 'capabilities' in e)
    assert 'chassis_turn_calibrated_v1' in status['capabilities']
    assert 'turn_angle_360' not in status['capabilities']
    assert status['turn_calibration'] == {
        'reference': 'owner_visual', 'reference_degrees': 90,
        'native_per90': {'left': 215, 'right': 198},
        'factors': {'left': 215 / 90, 'right': 198 / 90},
        'provisional': {'left': True, 'right': False},
        'max_angle': 180, 'extrapolated_above': 90,
    }
    for kind in ('turn_left', 'turn_right', 'drive_hold', 'drive_tap', 'motor_power_100'):
        assert kind in m.CAPS


@pytest.mark.parametrize('direction,per90', [('left', -215), ('right', 198)])
@pytest.mark.parametrize('angle', [0, 0.5, 45, 90, 180])
@pytest.mark.parametrize('indexed', [False, True])
def test_target_range_preserves_source_and_single_native_branch(monkeypatch, direction, per90, angle, indexed):
    m, ctx, _, client, calls = rig(monkeypatch)
    source = {'type': 'turn_' + direction, 'angle': angle}
    plan = {'format': 'indexed-v1', 'commands': [source], 'order': '00'} if indexed else [source]
    send(client, {'run_id': 'range', 'program': plan}, 'program')
    for _ in range(4):
        m.ota_step(ctx)
    expected = angle * per90 / 90
    assert abs(expected) <= 720
    assert [c for c in calls if c[0] == 'turn'] == ([] if angle == 0 else [('turn', (expected,), {})])
    diagnostics = [e for _, e in client.events if e.get('run_id') == 'range'
                   and e.get('event') in ('native_before', 'native_after')]
    assert len(diagnostics) == 2
    assert all(e['command']['angle'] == angle for e in diagnostics)
    assert source == {'type': 'turn_' + direction, 'angle': angle}


@pytest.mark.parametrize('direction', ['left', 'right'])
def test_omitted_target_stays_zero_no_native_call(monkeypatch, direction):
    m, ctx, _, client, calls = rig(monkeypatch)
    send(client, {'type': 'turn_' + direction, 'run_id': 'omitted'})
    for _ in range(4):
        m.ota_step(ctx)
    assert calls == []
    assert any(e.get('run_id') == 'omitted' and e.get('event') == 'completed'
               and e.get('type') == 'program' for _, e in client.events)


@pytest.mark.parametrize('direction', ['left', 'right'])
@pytest.mark.parametrize('interruption', ['emergency', 'command_stop', 'deadline'])
def test_stop_and_deadline_cancel_prepared_turn_without_native_dispatch(monkeypatch, direction, interruption):
    m, ctx, clock, client, calls = rig(monkeypatch)
    clock.now = 1000
    clock.ticks_diff = lambda a, b: a - b
    plan = {'format': 'indexed-v1', 'commands': [{'type': 'turn_' + direction, 'angle': 180}], 'order': '00'}
    send(client, {'run_id': 'cancel', 'program': plan}, 'program')
    m.ota_step(ctx)
    assert m._app.native_pending is not None and calls == []
    if interruption == 'emergency':
        send(client, {}, 'emergency')
    elif interruption == 'command_stop':
        send(client, {'type': 'stop', 'run_id': 'stop'})
    else:
        clock.now += 300000
    for _ in range(3):
        m.ota_step(ctx)
    assert not any(c[0] == 'turn' for c in calls)
    assert {'em_stop', 'dc_stop', 'audio_stop'} <= {c[0] for c in calls}
    assert not any(e.get('run_id') == 'cancel' and e.get('event') == 'completed' for _, e in client.events)
    assert any(e.get('run_id') == 'cancel' and e.get('event') == ('failed' if interruption == 'deadline' else 'canceled')
               for _, e in client.events)
    send(client, {'type': 'turn_' + direction, 'angle': 90, 'run_id': 'fresh'})
    for _ in range(3):
        m.ota_step(ctx)
    expected = -215 if direction == 'left' else 198
    assert [c for c in calls if c[0] == 'turn'] == [('turn', (expected,), {})]
    assert any(e.get('run_id') == 'fresh' and e.get('event') == 'completed'
               and e.get('type') == 'program' for _, e in client.events)


@pytest.mark.parametrize('direction', ['left', 'right'])
def test_deadline_after_blocking_native_return_stops_without_completion(monkeypatch, direction):
    m, ctx, clock, client, calls = rig(monkeypatch)
    clock.now = 1000
    clock.ticks_diff = lambda a, b: a - b
    native_turn = sys.modules['mbot2'].turn

    # Keep the stack-sensitive stand-in at the exact IO.execute boundary.
    def delayed_turn(*args, **kwargs):
        calls.append(('turn', args, kwargs))
        clock.now += 300000
    sys.modules['mbot2'].turn = delayed_turn
    plan = {'format': 'indexed-v1', 'commands': [{'type': 'turn_' + direction, 'angle': 180}], 'order': '00'}
    send(client, {'run_id': 'expired', 'program': plan}, 'program')
    m.ota_step(ctx)
    m.ota_step(ctx)
    expected = -430 if direction == 'left' else 396
    assert calls == [('turn', (expected,), {}), ('em_stop',), ('dc_stop',), ('audio_stop',)]
    assert not any(e.get('run_id') == 'expired' and e.get('event') == 'completed' for _, e in client.events)
    assert any(e.get('run_id') == 'expired' and e.get('event') == 'failed'
               and e.get('error') == 'elapsed' for _, e in client.events)
    sys.modules['mbot2'].turn = native_turn
    send(client, {'type': 'turn_' + direction, 'angle': 90, 'run_id': 'fresh'})
    for _ in range(3):
        m.ota_step(ctx)
    assert any(e.get('run_id') == 'fresh' and e.get('event') == 'completed'
               and e.get('type') == 'program' for _, e in client.events)
