"""Host-only leased drive regressions. No MQTT broker or hardware access."""
import inspect
import json
import sys
from types import SimpleNamespace
import pytest
from test_robot_control import setup, send, Clock, Client, load


def test_read_only_ota_request_preserves_ordinary_program():
    m, ctx, clock, io, client = setup()
    send(client, {'run_id': 'ordinary', 'program': [{'type': 'wait', 'duration': 2}]}, 'program')
    m.ota_step(ctx)
    assert m._app.blocks is not None
    m._app.put(m._app.ota_topic, b'{"op":"status"}')
    m.ota_step(ctx)
    assert m._app.blocks is not None
    clock.now = (clock.now + 2001) % 65536
    m.ota_step(ctx)
    assert any(d.get('run_id') == 'ordinary' and d.get('type') == 'program' and d.get('event') == 'completed' for _, d in client.events)


def packet(op='start', hold_id='h1', **kw):
    d = {'op': op, 'hold_id': hold_id, 'boot': 'boot'}
    if op in ('start', 'tap'): d.update(direction='forward', speed=30)
    d.update(kw)
    return d


@pytest.mark.parametrize('speed', [0, 50, 100])
@pytest.mark.parametrize('direction', ['forward', 'backward', 'left', 'right'])
def test_tap_pulses_once_for_400ms_from_successful_native_return(speed, direction):
    m, ctx, clock, io, client = rig()
    assert {'drive_tap', 'motor_power_100'}.issubset(m.CAPS)
    assert {'drive_tap', 'motor_power_100'}.issubset(client.events[-1][1]['capabilities'])
    request = packet('tap', direction=direction, speed=speed)
    send(client, request, 'drive')
    m.ota_step(ctx)
    assert io.calls == [('stop',)] and not evidence(client)
    clock.now = (clock.now + 600) % 65536  # Admission is not pulse start.
    def drive(direction, speed):
        assert inspect.currentframe().f_back.f_code.co_name == 'ota_step'
        io.calls.append(('drive', direction, speed))
        clock.now = (clock.now + 150) % 65536  # Native return is not dispatch.
    io.drive = drive
    m.ota_step(ctx)
    assert evidence(client) == [{'hold_id': 'h1', 'boot': 'boot', 'event': 'started'}]
    clock.now = (clock.now + 399) % 65536
    m.ota_step(ctx)
    assert io.calls == [('stop',), ('drive', direction, speed)]
    clock.now = (clock.now + 1) % 65536
    def check(): assert io.calls[-1] == ('stop',), 'tap expiry precedes network'
    client.check_msg = check
    m.ota_step(ctx)
    assert io.calls == [('stop',), ('drive', direction, speed), ('stop',)]
    assert evidence(client)[-1] == {'hold_id': 'h1', 'boot': 'boot',
                                  'event': 'stopped', 'reason': 'tap_completed'}
    assert m._app.drive is None and m._app.native_pending is None


@pytest.mark.parametrize('renew_at', [0, 399, 400, 701])
def test_tap_renew_rejected_without_extending_or_canceling_active_pulse(renew_at):
    m, ctx, clock, io, client = rig()
    start(m, ctx, client, op='tap')
    clock.now = (clock.now + renew_at) % 65536
    send(client, packet('renew'), 'drive')
    m.ota_step(ctx)
    assert any(d['event'] == 'rejected' for d in evidence(client))
    if renew_at < 400:
        assert m._app.drive is not None and io.calls[-1][0] == 'drive'
        clock.now = (clock.now + 400 - renew_at) % 65536
        m.ota_step(ctx)
    assert io.calls == [('stop',), ('drive', 'forward', 30), ('stop',)]
    assert any(d['event'] == 'stopped' and d['reason'] == 'tap_completed' for d in evidence(client))
    assert m._app.drive is None


def test_pending_tap_renew_is_rejected_and_cannot_extend_admission():
    m, ctx, clock, io, client = rig()
    send(client, packet('tap'), 'drive')
    m.ota_step(ctx)
    clock.now = (clock.now + 699) % 65536
    send(client, packet('renew'), 'drive')
    assert any(d.get('event') == 'rejected' for _, d in m._app.outgoing)
    clock.now = (clock.now + 1) % 65536
    m.ota_step(ctx)
    assert io.calls == [('stop',), ('stop',)]
    assert evidence(client)[-1]['reason'] == 'expired'
    assert m._app.drive is None and m._app.native_pending is None


def evidence(client):
    return [d for t, d in client.events if t.endswith(b'/drive_status')]


def rig():
    m, ctx, clock, io, client = setup()
    def drive(direction, speed):
        assert inspect.currentframe().f_back.f_code.co_name == 'ota_step'
        assert not any(d['event'] == 'started' and d['hold_id'] == m._app.drive['hold_id']
                       for d in evidence(client))
        io.calls.append(('drive', direction, speed))
    io.drive = drive
    return m, ctx, clock, io, client


def start(m, ctx, client, **kw):
    send(client, packet(**kw), 'drive')
    m.ota_step(ctx)  # Publish native preparation, no native motion yet.
    m.ota_step(ctx)


@pytest.mark.parametrize('direction', ['forward', 'backward', 'left', 'right'])
def test_start_renew_release_are_nonblocking_and_evidence_follows_native(direction):
    m, ctx, clock, io, client = rig()
    assert 'drive_hold' in m.CAPS
    send(client, packet(direction=direction), 'drive')
    m.ota_step(ctx)
    assert io.calls == [('stop',)]
    assert not evidence(client)
    m.ota_step(ctx)
    assert io.calls == [('stop',), ('drive', direction, 30)]
    assert evidence(client) == [{'hold_id':'h1', 'boot':'boot', 'event':'started'}]
    for _ in range(3):
        clock.now = (clock.now + 500) % 65536
        send(client, packet('renew'), 'drive')
        m.ota_step(ctx)
    assert io.calls == [('stop',), ('drive', direction, 30)]
    old_stop = io.stop
    def stop():
        assert evidence(client)[-1]['event'] == 'started'
        assert inspect.currentframe().f_back.f_code.co_name == 'ota_step'
        old_stop()
    io.stop = stop
    send(client, packet('stop'), 'drive')
    m.ota_step(ctx)
    assert io.calls[-1] == ('stop',)
    assert evidence(client)[-1] == {'hold_id':'h1', 'boot':'boot', 'event':'stopped', 'reason':'released'}


@pytest.mark.parametrize('prepared', [False, True])
@pytest.mark.parametrize('late_renew', [False, True])
def test_lease_wrap_expiry_precedes_network_and_never_starts_expired_preparation(prepared, late_renew):
    m, ctx, clock, io, client = rig()
    send(client, packet(), 'drive')
    m.ota_step(ctx)
    if not prepared: m.ota_step(ctx)
    clock.now = (clock.now + 699) % 65536
    if not prepared:
        m.ota_step(ctx)
        assert io.calls[-1][0] == 'drive'
    clock.now = (clock.now + 1) % 65536
    if late_renew: send(client, packet('renew'), 'drive')
    def check():
        assert io.calls[-1] == ('stop',), 'expiry must physically stop before network'
    client.check_msg = check
    m.ota_step(ctx)
    assert io.calls[-1] == ('stop',)
    assert m._app.drive is None and m._app.native_pending is None
    assert len([c for c in io.calls if c[0] == 'drive']) == (0 if prepared else 1)
    assert any(d['event']=='stopped' and d['reason']=='expired' for d in evidence(client))
    client.check_msg = lambda: None
    send(client, packet('renew'), 'drive')
    m.ota_step(ctx)
    assert evidence(client)[-1]['event'] == 'rejected'
    start(m, ctx, client, hold_id='fresh')
    assert evidence(client)[-1] == {'hold_id':'fresh','boot':'boot','event':'started'}


def test_release_then_renew_cannot_revive_and_unrelated_renew_cannot_extend():
    m, ctx, clock, io, client = rig()
    start(m, ctx, client)
    clock.now = (clock.now + 600) % 65536
    send(client, packet('renew', hold_id='other'), 'drive')
    m.ota_step(ctx)
    clock.now = (clock.now + 100) % 65536
    m.ota_step(ctx)
    assert io.calls[-1] == ('stop',)
    start(m, ctx, client, hold_id='second')
    send(client, packet('stop', hold_id='second'), 'drive')
    m.ota_step(ctx)
    before = list(io.calls)
    send(client, packet('renew', hold_id='second'), 'drive')
    m.ota_step(ctx)
    assert io.calls == before and evidence(client)[-1]['event'] == 'rejected'
    start(m, ctx, client, hold_id='third')
    assert evidence(client)[-1]['hold_id'] == 'third'


@pytest.mark.parametrize('op', ['start', 'tap'])
def test_network_latency_cannot_dispatch_expired_native_start(op):
    m, ctx, clock, io, client = rig()
    send(client, packet(op), 'drive')
    m.ota_step(ctx)
    def delayed_check(): clock.now = (clock.now + 700) % 65536
    client.check_msg = delayed_check
    m.ota_step(ctx)
    assert not any(c[0]=='drive' for c in io.calls)
    assert io.calls[-1] == ('stop',)
    assert evidence(client)[-1]['reason'] == 'expired'


@pytest.mark.parametrize('bad', [
    None, [], {}, packet(op='oops'), packet(speed=True), packet(speed='30'),
    packet(speed=-1), packet(speed=101), packet(speed=float('nan')),
    packet(speed=float('inf')), packet(direction='turn_left'), packet(direction=None),
    packet(hold_id=''), packet(hold_id='x'*65), packet(hold_id=1), packet(boot='stale'),
    packet(boot=True), packet(extra=1), packet('renew', speed=30),
    packet('stop', direction='forward'), {k:v for k,v in packet().items() if k!='speed'},
    {k:v for k,v in packet().items() if k!='direction'},
])
@pytest.mark.parametrize('op', ['start', 'tap'])
def test_strict_wire_rejection_has_no_native_effect_and_fresh_hold_works(bad, op):
    m, ctx, clock, io, client = rig()
    if isinstance(bad, dict) and bad.get('op') == 'start': bad = dict(bad, op=op)
    send(client, bad, 'drive')
    for _ in range(2): m.ota_step(ctx)
    assert io.calls == [('stop',)]
    assert evidence(client)[-1]['event'] == 'rejected'
    start(m, ctx, client, hold_id='fresh')
    assert evidence(client)[-1]['event'] == 'started'


@pytest.mark.parametrize('raw', [b'{', b'x'*1025])
def test_invalid_json_and_oversize_are_rejected_without_callback_exception(raw):
    m, ctx, clock, io, client = rig()
    client.callback(b'mbot-studio/robot/drive', raw)
    m.ota_step(ctx)
    assert io.calls == [('stop',)]
    assert evidence(client)[-1]['event'] == 'rejected'


@pytest.mark.parametrize('op', ['start', 'tap'])
@pytest.mark.parametrize('field,value', [('op','"start"'),('hold_id','"h1"'),('speed','30')])
def test_duplicate_wire_fields_are_malformed(field, value, op):
    m, ctx, clock, io, client = rig()
    raw = json.dumps(packet(op))[:-1] + ',"' + field + '":' + value + '}'
    client.callback(b'mbot-studio/robot/drive', raw.encode())
    for _ in range(2): m.ota_step(ctx)
    assert io.calls == [('stop',)]
    assert evidence(client)[-1]['reason'] == 'malformed'


@pytest.mark.parametrize('speed', [0, 0.5, 50, 100])
def test_valid_boundary_speed_and_escaped_identity(speed):
    m, ctx, clock, io, client = rig()
    hold_id = '"\\:' + 'x'*61
    start(m, ctx, client, hold_id=hold_id, speed=speed)
    assert io.calls[-1] == ('drive','forward',speed)
    assert evidence(client)[-1]['hold_id'] == hold_id


@pytest.mark.parametrize('op', ['start', 'tap'])
@pytest.mark.parametrize('busy', ['mailbox','program','native_pending','sensor','hold','tap','pending_hold','pending_tap','stop'])
def test_start_rejects_busy_without_preempting_original_work(busy, op):
    m, ctx, clock, io, client = rig()
    if busy in ('mailbox','native_pending'):
        send(client, {'type':'servo','port':'S1','run_id':'original'})
        if busy == 'native_pending': m.ota_step(ctx)
    elif busy == 'program':
        send(client, {'type':'wait','duration':10,'run_id':'original'})
        m.ota_step(ctx)
    elif busy == 'sensor': m._app.sensor_index = 1
    elif busy in ('hold', 'tap'): start(m, ctx, client, op='tap' if busy == 'tap' else 'start')
    elif busy in ('pending_hold', 'pending_tap'):
        send(client, packet('tap' if busy == 'pending_tap' else 'start'), 'drive')
        m.ota_step(ctx)
    else: send(client, {'type':'stop'})
    send(client, packet(op, hold_id='busy-attempt'), 'drive')
    for _ in range(2): m.ota_step(ctx)
    assert not any(d['hold_id']=='busy-attempt' and d['event']=='started' for d in evidence(client))
    assert any(d['hold_id']=='busy-attempt' and d['event']=='rejected' and d['reason']=='busy'
               for d in evidence(client))
    if busy in ('hold', 'tap', 'pending_hold', 'pending_tap'): assert m._app.drive['hold_id'] == 'h1'
    if busy in ('mailbox','native_pending'): assert io.calls[-1][0] == 'servo'


def test_pending_hold_renew_does_not_extend_unstarted_lease():
    m, ctx, clock, io, client = rig()
    send(client, packet(), 'drive')
    m.ota_step(ctx)
    clock.now = (clock.now + 600) % 65536
    send(client, packet('renew'), 'drive')
    assert not any(d.get('event')=='rejected' for _,d in m._app.outgoing), 'pending renew is ignored, not a terminal rejection'
    clock.now = (clock.now + 100) % 65536
    m.ota_step(ctx)
    assert not any(c[0]=='drive' for c in io.calls)


@pytest.mark.parametrize('command,topic', [({'type':'read_sensors'},'command'),
    ({'type':'servo','port':'S1'},'command'), ({'blocks':[{'type':'wait','duration':10}]},'program')])
@pytest.mark.parametrize('op', ['start', 'tap'])
def test_no_command_program_or_sensor_work_is_queued_during_hold(command, topic, op):
    m, ctx, clock, io, client = rig()
    reads = []
    io.sensors = lambda index=0: reads.append(index) or {'sampling': True}
    start(m, ctx, client, op=op)
    send(client, command, topic)
    m.ota_step(ctx)
    assert m._app.pending is None and not reads
    send(client, packet('stop'), 'drive')
    for _ in range(5): m.ota_step(ctx)
    assert not reads and not any(c[0]=='servo' for c in io.calls)
    assert m._app.blocks is None


@pytest.mark.parametrize('pending', [False, True])
@pytest.mark.parametrize('op', ['start', 'tap'])
@pytest.mark.parametrize('cause', ['stop','drive_stop','emergency','disconnect','identity','mutable_identity','ota'])
def test_all_invalidation_paths_clear_drive_and_pending_then_allow_fresh(cause, pending, op):
    m, ctx, clock, io, client = rig()
    send(client, packet(op), 'drive')
    m.ota_step(ctx)
    if not pending: m.ota_step(ctx)
    if cause == 'stop': send(client, {'type':'stop'})
    elif cause == 'drive_stop': send(client, packet('stop'), 'drive')
    elif cause == 'emergency': send(client, {}, 'emergency')
    elif cause == 'disconnect': client.fail = True
    elif cause == 'ota': client.callback(b'mbot-studio/ota/test/request', b'{}')
    elif cause == 'identity':
        wrong = SimpleNamespace(**vars(ctx)); wrong.boot = 'wrong'
        with pytest.raises(ValueError, match='identity'): m.ota_step(wrong)
    else:
        ctx.boot = 'wrong'
        with pytest.raises(ValueError, match='identity'): m.ota_step(ctx)
        ctx.boot = 'boot'
    m.ota_step(ctx)
    assert m._app.drive is None and m._app.native_pending is None
    assert m._app.pending is None and m._app.blocks is None
    assert io.calls[-1] == ('stop',)
    assert len([c for c in io.calls if c[0]=='drive']) == (0 if pending else 1)
    clock.now = (clock.now + 2001) % 65536
    for _ in range(3): m.ota_step(ctx)
    client = m._app.client
    assert any(d['hold_id']=='h1' and d['event']=='stopped' for d in evidence(client))
    send(client, packet('renew'), 'drive')
    m.ota_step(ctx)
    assert evidence(client)[-1]['event'] == 'rejected'
    start(m, ctx, client, op=op, hold_id='fresh')
    assert evidence(client)[-1]['event'] == 'started'


@pytest.mark.parametrize('op', ['start', 'tap'])
def test_emergency_already_received_stops_before_network_and_cannot_be_overwritten(op):
    m, ctx, clock, io, client = rig()
    start(m, ctx, client, op=op)
    send(client, {}, 'emergency')
    send(client, packet(hold_id='unsafe'), 'drive')
    def check(): assert io.calls[-1] == ('stop',)
    client.check_msg = check
    m.ota_step(ctx)
    assert io.calls[-1] == ('stop',) and m._app.client is client
    assert evidence(client)[-1]['event'] == 'stopped'


@pytest.mark.parametrize('stop_fails', [False, True])
@pytest.mark.parametrize('op', ['start', 'tap'])
def test_native_drive_side_effect_failure_stops_before_network_and_latches_retry(stop_fails, op):
    m, ctx, clock, io, client = rig()
    normal_drive, normal_stop, publish = io.drive, io.stop, client.publish
    trace, stop_states = [], []
    send(client, packet(op), 'drive')
    m.ota_step(ctx)  # Preparation is already published before the native call.

    def fail_drive(*args):
        trace.append('motor-side-effect')  # A native driver can move then throw.
        raise RuntimeError('start fault')

    def stop():
        trace.append('stop')
        stop_states.append((inspect.currentframe().f_back.f_code.co_name,
                            m._app.drive, m._app.native_pending,
                            m._app.drive_stopping))
        if stop_fails: raise RuntimeError('stop fault')
        normal_stop()

    def network_publish(topic, payload, **kw):
        trace.append('publish:' + json.loads(payload).get('event', 'other'))
        publish(topic, payload, **kw)

    io.drive, io.stop, client.publish = fail_drive, stop, network_publish
    m.ota_step(ctx)
    assert trace[:2] == ['motor-side-effect', 'stop'], trace
    assert stop_states == [('ota_step', None, None, (packet(op), 'native_error'))]
    assert not any(d['event']=='started' for d in evidence(client))
    if stop_fails:
        assert trace == ['motor-side-effect', 'stop'], 'no network while Stop remains unfulfilled'
        assert m._app.drive_stopping is not None
        send(client, packet(hold_id='cannot-run'), 'drive')
        client.check_msg = lambda: trace.append('network-check')
        with pytest.raises(RuntimeError, match='stop fault'): m.ota_step(ctx)
        assert trace == ['motor-side-effect', 'stop', 'stop']
        assert not any(d['event']=='stopped' for d in evidence(client))
        stop_fails = False
        m.ota_step(ctx)
    assert m._app.drive_stopping is None
    assert 'publish:native_exception' in trace
    assert any(d['event']=='stopped' and d['hold_id']=='h1' for d in evidence(client))
    io.drive, io.stop, client.publish = normal_drive, normal_stop, publish
    client.check_msg = lambda: None
    start(m, ctx, client, hold_id='fresh')
    assert evidence(client)[-1]['event'] == 'started'


@pytest.mark.parametrize('op', ['start', 'tap'])
def test_publish_failure_stops_clears_and_preserves_stop_evidence_for_reconnect(op):
    m, ctx, clock, io, client = rig()
    start(m, ctx, client, op=op)
    def fail(*args, **kw): raise OSError('publish')
    client.publish = fail
    m._app.status()
    m.ota_step(ctx)
    assert io.calls[-1] == ('stop',) and m._app.drive is None
    clock.now = (clock.now + 2001) % 65536
    m.ota_step(ctx)
    client = m._app.client
    assert any(d['event']=='stopped' for d in evidence(client))
    start(m, ctx, client, hold_id='fresh')
    assert evidence(client)[-1]['event']=='started'


@pytest.mark.parametrize('op,deadline', [('start', 700), ('tap', 400)])
def test_publish_latency_rechecks_lease_before_next_network_operation(op, deadline):
    m, ctx, clock, io, client = rig()
    start(m, ctx, client, op=op)
    publish = client.publish
    count = []
    def slow(topic, payload, **kw):
        if count: assert io.calls[-1] == ('stop',)
        publish(topic, payload, **kw)
        count.append(1)
        clock.now = (clock.now + deadline) % 65536
    client.publish = slow
    m._app.status()
    m._app.status()
    m.ota_step(ctx)
    assert io.calls[-1] == ('stop',) and m._app.drive is None
    assert m._app.client is client, 'slow publication must not turn into a transport failure'


@pytest.mark.parametrize('op', ['start', 'tap'])
@pytest.mark.parametrize('speed', [0, 50, 100])
@pytest.mark.parametrize('direction,signs', [('forward',(1,-1)),('backward',(-1,1)),
                                           ('left',(-1,-1)),('right',(1,1))])
def test_native_adapter_uses_single_documented_differential_power_setpoint(monkeypatch, direction, signs, speed, op):
    m, ctx, clock, io, client = rig()
    powers = tuple(sign * speed for sign in signs)
    calls = []
    def drive_power(*args):
        assert [f.function for f in inspect.stack()][1:3] == ['drive','ota_step']
        calls.append(args)
    mbot = SimpleNamespace(drive_power=drive_power, EM_stop=lambda:None,
                         starter_shield=SimpleNamespace(dc_motor_stop=lambda:None))
    cyber = SimpleNamespace(audio=SimpleNamespace(stop=lambda:None),
                            wifi=SimpleNamespace(is_connect=lambda:True))
    for name, module in [('mbot2',mbot),('cyberpi',cyber),('mbuild',SimpleNamespace()),
                         ('simple_mqtt',SimpleNamespace(MQTTClient=Client))]:
        monkeypatch.setitem(sys.modules,name,module)
    m._app.io = m.native()['io']
    start(m, ctx, client, op=op, direction=direction, speed=speed)
    assert calls == [powers]
    send(client, packet('renew'), 'drive')
    m.ota_step(ctx)
    assert calls == [powers]
    assert evidence(client)[-1]['event'] == ('rejected' if op == 'tap' else 'started')
