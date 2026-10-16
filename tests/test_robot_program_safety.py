"""Ordinary Program safety through real native adapters; recording hardware only."""
import inspect
import json
import pathlib
import subprocess
import sys
from types import SimpleNamespace

import pytest
from test_robot_control import Client, setup, send


MOTORS = ('move_forward', 'move_backward', 'dc_motor')


def rig(monkeypatch):
    m, ctx, clock, _, client = setup()
    trace, active, faults = [], set(), set()

    def record(name):
        def call(*args, **kwargs):
            frame = inspect.currentframe().f_back
            assert frame.f_code.co_name in ('execute', 'stop')
            assert frame.f_back.f_code.co_name == 'ota_step'
            trace.append((name, clock.now))
            if name in MOTORS:
                active.add('dc' if name == 'dc_motor' else 'drive')
            if name in faults:
                raise RuntimeError('injected ' + name + ' failure')
            if name == 'em_stop': active.discard('drive')
            if name == 'dc_stop': active.discard('dc')
        return call

    modules = {
        'mbot2': SimpleNamespace(forward=record('move_forward'), backward=record('move_backward'),
            EM_stop=record('em_stop'), starter_shield=SimpleNamespace(
                dc_motor_set_power=record('dc_motor'), dc_motor_stop=record('dc_stop'))),
        'cyberpi': SimpleNamespace(wifi=SimpleNamespace(is_connect=lambda: True),
            audio=SimpleNamespace(stop=record('audio_stop'))),
        'mbuild': SimpleNamespace(),
        'simple_mqtt': SimpleNamespace(MQTTClient=Client),
    }
    for name, module in modules.items(): monkeypatch.setitem(sys.modules, name, module)
    m._app.io = m.native()['io']
    publish, check = client.publish, client.check_msg

    def publishing(topic, payload, **kwargs):
        trace.append(('publish', clock.now))
        publish(topic, payload, **kwargs)

    def checking():
        trace.append(('network', clock.now))
        check()

    client.publish, client.check_msg = publishing, checking
    return m, ctx, clock, client, trace, active, faults


def block(kind, duration):
    return dict(type=kind, speed=20, duration=duration,
                **({'port': 'M1'} if kind == 'dc_motor' else {}))


def completed(client, run_id='safety'):
    return [e for _, e in client.events
            if e.get('run_id') == run_id and e.get('event') == 'completed']


@pytest.mark.parametrize('kind', MOTORS)
@pytest.mark.parametrize('duration', [0, 1e-300, 0.0001, 0.000999, 0.001, 0.001001, 0.1])
def test_motor_duration_has_minimum_positive_tick_and_stops(monkeypatch, kind, duration):
    m, ctx, clock, client, trace, active, _ = rig(monkeypatch)
    send(client, {'run_id': 'safety', 'program': [block(kind, duration)]}, 'program')
    m.ota_step(ctx)
    if duration == 0:
        assert not active and not any(name in MOTORS for name, _ in trace)
        assert completed(client)
        return
    m.ota_step(ctx)
    assert active
    assert not completed(client), 'positive motor duration cannot complete without Stop'
    assert m._app.timer[1] == max(1, int(duration * 1000))
    m.ota_step(ctx)  # Same tick must not consume the minimum positive hold.
    assert active and not completed(client)
    clock.now = (clock.now + max(1, int(duration * 1000))) % 65536
    m.ota_step(ctx)
    assert not active
    assert [e['type'] for e in completed(client)] == ['block', 'program']
    assert m._app.blocks is None and m._app.timer is None


@pytest.mark.parametrize('kind', MOTORS)
@pytest.mark.parametrize('failed_stop', ['em_stop', 'dc_stop', 'audio_stop'])
def test_transient_program_stop_failure_retries_before_network_and_new_work(monkeypatch, kind, failed_stop):
    m, ctx, clock, client, trace, active, faults = rig(monkeypatch)
    send(client, {'run_id': 'safety', 'program': [block(kind, 0.1), block(kind, 0.1)]}, 'program')
    m.ota_step(ctx)
    m.ota_step(ctx)
    faults.add(failed_stop)
    clock.now = (clock.now + 100) % 65536
    trace.clear()
    m.ota_step(ctx)
    names = [name for name, _ in trace]
    first_stop = names.index('em_stop')
    assert names[first_stop:] == ['em_stop', 'dc_stop', 'audio_stop'] * 2, 'no network while Stop is unresolved'
    assert not completed(client)
    assert m._app.blocks is None and m._app.timer is None
    assert not any(e.get('event') == 'failed' for _, e in client.events)
    send(client, {'run_id': 'must-not-run', 'program': [block(kind, 0.1)]}, 'program')
    send(client, {'op': 'tap', 'hold_id': 'unsafe', 'boot': ctx.boot,
                  'direction': 'forward', 'speed': 20}, 'drive')
    trace.clear()
    m.ota_step(ctx)  # Retry must remain inside the live application.
    assert [name for name, _ in trace] == ['em_stop', 'dc_stop', 'audio_stop']
    faults.clear()
    trace.clear()
    clock.now = (clock.now + 100) % 65536
    m.ota_step(ctx)
    assert [name for name, _ in trace][:3] == ['em_stop', 'dc_stop', 'audio_stop']
    assert not active
    failures = [e for _, e in client.events if e.get('event') == 'failed']
    assert len(failures) == 1 and failures[0]['run_id'] == 'safety'
    assert failures[0]['error'] == 'injected ' + failed_stop + ' failure'
    for _ in range(3): m.ota_step(ctx)
    assert not active and not completed(client)
    assert not any(e.get('run_id') == 'must-not-run' for _, e in client.events)
    send(client, {'run_id': 'fresh', 'program': [block(kind, 0.001)]}, 'program')
    m.ota_step(ctx)
    m.ota_step(ctx)
    assert active
    clock.now = (clock.now + 1) % 65536
    m.ota_step(ctx)
    assert not active and completed(client, 'fresh')


@pytest.mark.parametrize('kind', MOTORS)
def test_motor_completion_is_not_even_queued_until_stop_returns(monkeypatch, kind):
    m, ctx, clock, client, trace, active, _ = rig(monkeypatch)
    send(client, {'run_id': 'safety', 'program': [block(kind, 0.001)]}, 'program')
    m.ota_step(ctx)
    m.ota_step(ctx)
    complete = m._app.complete

    def after_stop():
        assert not active, 'completion is contingent on native Stop success'
        assert [name for name, _ in trace][-3:] == ['em_stop', 'dc_stop', 'audio_stop']
        assert m._app.index == 0 and m._app.blocks is not None
        complete()

    m._app.complete = after_stop
    clock.now = (clock.now + 1) % 65536
    m.ota_step(ctx)
    assert not active and completed(client)


@pytest.mark.parametrize('kind', MOTORS)
def test_static_expression_lowered_by_real_server_has_bounded_motor_execution(monkeypatch, kind):
    m, ctx, clock, client, trace, active, _ = rig(monkeypatch)
    source = [block(kind, {'type': 'op_div', 'a': 1, 'b': 10000})]
    result = subprocess.run(['node', '--input-type=module', '-e', '''
        import {readFileSync} from 'node:fs';
        import {lowerProgram} from './server/src/services/program-lowering.js';
        console.log(JSON.stringify(lowerProgram(JSON.parse(readFileSync(0, 'utf8'))).program));
    '''], input=json.dumps(source), text=True, capture_output=True, check=True,
        cwd=pathlib.Path(__file__).parents[1], timeout=10)
    lowered = json.loads(result.stdout)
    assert lowered[0]['duration'] == 0.0001
    send(client, {'run_id': 'safety', 'program': lowered}, 'program')
    m.ota_step(ctx)
    m.ota_step(ctx)
    assert active and not completed(client)
    clock.now = (clock.now + 1) % 65536
    m.ota_step(ctx)
    assert not active and completed(client)


@pytest.mark.parametrize('interruption', ['stop', 'emergency', 'network', 'publish', 'identity'])
@pytest.mark.parametrize('kind', MOTORS)
def test_cancellation_keeps_motor_stop_obligation_through_failure(monkeypatch, kind, interruption):
    m, ctx, clock, client, trace, active, faults = rig(monkeypatch)
    send(client, {'run_id': 'safety', 'program': [block(kind, 1)]}, 'program')
    m.ota_step(ctx)
    m.ota_step(ctx)
    fault = 'dc_stop' if kind == 'dc_motor' else 'em_stop'
    faults.add(fault)
    if interruption in ('stop', 'emergency'):
        send(client, {'type': 'stop'}, 'command' if interruption == 'stop' else 'emergency')
    elif interruption == 'network': client.fail = True
    elif interruption == 'publish':
        def failed_publish(*args, **kwargs): raise OSError('transport')
        client.publish = failed_publish
        m._app.status()
    wrong = SimpleNamespace(**vars(ctx))
    wrong.sha256 = 'b' * 64
    if interruption in ('identity', 'publish'):
        m.ota_step(wrong if interruption == 'identity' else ctx)
    else: m.ota_step(ctx)
    assert active and not completed(client)
    trace.clear()
    m.ota_step(ctx)  # Retry must remain inside the live application.
    assert [name for name, _ in trace] == ['em_stop', 'dc_stop', 'audio_stop']
    faults.clear()
    trace.clear()
    m.ota_step(ctx)
    assert [name for name, _ in trace][:3] == ['em_stop', 'dc_stop', 'audio_stop']
    assert not active
    clock.now = (clock.now + 2001) % 65536
    for _ in range(3): m.ota_step(ctx)
    client = m._app.client
    assert not completed(client)
    send(client, {'run_id': 'fresh', 'program': [block(kind, 0.001)]}, 'program')
    m.ota_step(ctx)
    m.ota_step(ctx)
    assert active
    clock.now = (clock.now + 1) % 65536
    m.ota_step(ctx)
    assert not active and completed(client, 'fresh')


@pytest.mark.parametrize('kind', MOTORS)
@pytest.mark.parametrize('stop_fails', [False, True])
def test_motor_dispatch_exception_stops_before_diagnostics_and_retains_retry(monkeypatch, kind, stop_fails):
    m, ctx, clock, client, trace, active, faults = rig(monkeypatch)
    send(client, {'run_id': 'safety', 'program': [block(kind, 0.0001)]}, 'program')
    m.ota_step(ctx)
    faults.add(kind)
    if stop_fails: faults.add('em_stop' if kind != 'dc_motor' else 'dc_stop')
    trace.clear()
    m.ota_step(ctx)
    names = [name for name, _ in trace]
    assert names[names.index(kind):][:4] == [kind, 'em_stop', 'dc_stop', 'audio_stop']
    assert not completed(client)
    if stop_fails:
        assert active
        assert 'publish' not in names
        assert not any(e.get('event') == 'failed' for _, e in client.events)
        faults.clear()
        trace.clear()
        m.ota_step(ctx)
        assert [name for name, _ in trace][:3] == ['em_stop', 'dc_stop', 'audio_stop']
    assert not active
    failures = [e for _, e in client.events if e.get('event') == 'failed']
    assert len(failures) == 1 and failures[0]['error'] == 'injected ' + kind + ' failure'
    diagnostics = [e for _, e in client.events if e.get('event') == 'native_exception']
    assert len(diagnostics) == 1 and diagnostics[0]['run_id'] == 'safety'
    faults.clear()
    send(client, {'run_id': 'fresh', 'program': [block(kind, 0.001)]}, 'program')
    m.ota_step(ctx)
    m.ota_step(ctx)
    clock.now = (clock.now + 1) % 65536
    m.ota_step(ctx)
    assert not active and completed(client, 'fresh')
