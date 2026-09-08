"""Host-only tests; no connection to a robot."""
import importlib.util
import pathlib
from types import SimpleNamespace
import pytest

PATH = pathlib.Path(__file__).parents[1] / 'firmware/robot_control.py'

def load():
    assert PATH.exists(), 'minimal controller not implemented'
    spec = importlib.util.spec_from_file_location('control', PATH)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m

class Clock:
    now = 65500
    def ticks_ms(self): return self.now
    def ticks_diff(self, a, b): return (a-b+32768)%65536-32768

class Client:
    def __init__(self, *a, **kw):
        self.sock = self
        self.events = []
        self.timeout = None
        self.fail = False
    def settimeout(self, n): self.timeout = n
    def set_callback(self, fn): self.callback = fn
    def connect(self, **kw): pass
    def subscribe(self, *a, **kw): pass
    def close(self): pass
    def check_msg(self):
        self.timeout = None
        if self.fail: raise OSError('offline')
    def publish(self, topic, payload, **kw):
        assert self.timeout == 1
        import json
        self.events.append((topic, json.loads(payload)))

class IO:
    def __init__(self): self.calls = []; self.fail = False
    def stop(self): self.calls.append(('stop',))
    def execute(self, b):
        self.calls.append((b['type'], b))
        if self.fail: raise RuntimeError('actuator')
    def sensors(self, index=0): return {'distance': 17, 'battery': 80}

def setup():
    m = load()
    m.ROBOT_MQTT_BROKER = 'test'
    m.ROBOT_TOPIC_PREFIX = 'mbot-studio'
    m.ROBOT_DEVICE = 'test'
    ctx = SimpleNamespace(protocol=1, disarmed=True, device='test', boot='boot', sha256='a'*64)
    clock, io = Clock(), IO()
    m.ota_init(ctx, {'clock':clock, 'io':io, 'mqtt_factory':Client})
    m.ota_step(ctx)
    return m, ctx, clock, io, m._app.client

def send(client, value, topic='command'):
    import json
    client.callback(('mbot-studio/robot/'+topic).encode(), json.dumps(value).encode())

@pytest.mark.parametrize('failed', [None, 'motor_stop', 'dc_stop', 'audio_stop'])
@pytest.mark.parametrize('command', ['move_forward', 'read_sensors'])
def test_startup_native_stop_is_shallow_before_network_and_actions(monkeypatch, failed, command):
    import inspect
    import sys
    import time
    m = load()
    m.ROBOT_MQTT_BROKER = m.ROBOT_DEVICE = 'test'
    m.ROBOT_TOPIC_PREFIX = 'mbot-studio'
    ctx = SimpleNamespace(protocol=1, disarmed=True, device='test', boot='boot', sha256='a'*64)
    calls, stacks, faults = [], [], set()
    stops = ['motor_stop', 'dc_stop', 'audio_stop']

    def record(name):
        def call(*args, **kwargs):
            calls.append(name)
            if name in stops:
                stacks.append([frame.function for frame in inspect.stack()])
            if name in faults:
                raise RuntimeError(name + ' fault')
            return True
        return call

    class StartupClient(Client):
        def connect(self, **kw): calls.append('connected')
        def check_msg(self):
            calls.append('check_msg')
            if not self.events:
                send(self, {'type': command, 'run_id': 'startup'})

    client = StartupClient()
    def factory(*args, **kwargs):
        calls.append('factory')
        return client

    cyber = SimpleNamespace(wifi=SimpleNamespace(is_connect=record('network')),
                            audio=SimpleNamespace(stop=record('audio_stop')))
    mbot = SimpleNamespace(EM_stop=record('motor_stop'), forward=record('motion'),
        starter_shield=SimpleNamespace(dc_motor_stop=record('dc_stop')))
    for name, module in (('cyberpi', cyber), ('mbot2', mbot),
                         ('mbuild', SimpleNamespace(ultrasonic2=SimpleNamespace(get=record('read')))),
                         ('simple_mqtt', SimpleNamespace(MQTTClient=factory))):
        monkeypatch.setitem(sys.modules, name, module)
    monkeypatch.setattr(time, 'ticks_ms', Clock().ticks_ms, raising=False)
    monkeypatch.setattr(time, 'ticks_diff', Clock().ticks_diff, raising=False)
    m.ota_init(ctx)  # Exercise the real native adapter, not setup's already-started app.
    assert calls == [], 'constructor must not call native hardware or network'
    if failed:
        faults.add(failed)
        for _ in range(2):
            calls.clear()
            with pytest.raises(RuntimeError, match=failed + ' fault'):
                m.ota_step(ctx)
            assert calls == stops, 'failed stop must block network, reads and motion'
            assert m._app.client is None and not client.events
            assert not m._app.outgoing, 'failed startup must not queue an armed grant'
        faults.clear()
        calls.clear()
    m.ota_step(ctx)
    assert calls == stops + ['network', 'factory', 'connected', 'check_msg',
                             'motion' if command == 'move_forward' else 'read']
    assert stacks
    for stack in stacks:
        assert stack[1:3] == ['stop', 'ota_step']
        assert not {'__init__', 'ota_init', 'step', 'cancel', 'disconnect'}.intersection(stack)
    status = next(e for _, e in client.events if 'armed' in e)
    assert status['armed'] and status['motion_enabled']
    assert status['build'] == m.OTA_BUILD_ID == 'mbot-av-control-v1'
    calls.clear()
    m.ota_step(ctx)
    assert not set(stops).intersection(calls), 'successful initial stop must not repeat'


def test_cooperative_run_wrap_zero_and_events():
    m, ctx, clock, io, client = setup()
    status = client.events[-1][1]
    assert status['application'] == 'cooperative-v1'
    assert status['armed'] and status['motion_enabled'] and status['self_managed_homing']
    assert status['sha256'] == ctx.sha256
    assert io.calls == [('stop',)]
    send(client, {'run_id':'r1','blocks':[{'type':'move_forward','speed':10,'duration':0.1}, {'type':'dc_motor','port':'M1','duration':0}]}, 'program')
    m.ota_step(ctx)
    assert io.calls[-1][0] == 'move_forward'
    clock.now = 30
    m.ota_step(ctx)
    assert io.calls[-1][0] == 'move_forward'
    clock.now = 65
    m.ota_step(ctx)
    assert io.calls[-1] == ('stop',)
    m.ota_step(ctx)
    assert not any(c[0]=='dc_motor' for c in io.calls)
    events = [e for t,e in client.events if t.endswith(b'execution')]
    assert any(e['type']=='program' and e['event']=='completed' and e['run_id']=='r1' for e in events)
    assert any(e.get('path')==[0] for e in events)

@pytest.mark.parametrize('failure', ['invalid', 'emergency', 'network', 'hardware'])
def test_failures_cancel_and_stop(failure):
    m, ctx, clock, io, client = setup()
    send(client, {'type':'move_backward','duration':1,'run_id':'a'})
    if failure == 'invalid':
        # Validation of every block precedes the first motor effect.
        m._app.pending = None
        send(client, {'run_id':'bad','blocks':[{'type':'move_forward'}, {'type':'repeat'}]}, 'program')
    elif failure == 'emergency':
        send(client, {}, 'emergency')
    elif failure == 'network': client.fail = True
    else: io.fail = True
    m.ota_step(ctx)
    assert io.calls[-1] == ('stop',)
    assert m._app.pending is None and m._app.blocks is None
    if failure == 'network':
        assert m._app.client is None
        m.ota_step(ctx)
        assert m._app.client is None
        clock.now = (clock.now+2001)%65536
        m.ota_step(ctx)
        assert m._app.client is not None
    elif failure != 'emergency':
        assert any(e.get('event')=='failed' for t,e in client.events)

def test_single_slot_and_runtime_sensors():
    m, ctx, clock, io, client = setup()
    send(client, {'type':'read_sensors','run_id':'s'})
    send(client, {'type':'move_forward'})
    m.ota_step(ctx)
    assert not any(c[0]=='move_forward' for c in io.calls)
    assert any(e.get('distance')==17 for t,e in client.events)

@pytest.mark.parametrize('where', ['check_msg', 'publish'])
def test_transport_failure_cancels_active_and_reports_after_retry(where):
    m, ctx, clock, io, client = setup()
    send(client, {'type':'move_forward','run_id':'lost','duration':1})
    m.ota_step(ctx)
    send(client, {'type':'move_backward'})
    def fail(*a, **kw): raise RuntimeError('transport')
    setattr(client, where, fail)
    if where == 'publish':
        clock.now = (clock.now+1001)%65536
    m.ota_step(ctx)
    assert m._app.client is None
    assert io.calls[-1] == ('stop',)
    assert m._app.pending is None and m._app.blocks is None
    clock.now = (clock.now+2001)%65536
    m.ota_step(ctx)
    assert any(e.get('event')=='failed' and e.get('run_id')=='lost' for t,e in m._app.client.events)

@pytest.mark.parametrize('kind', ['move_forward','move_backward','dc_motor'])
def test_zero_duration_never_starts_any_motor(kind):
    m, ctx, clock, io, client = setup()
    block = {'type':kind,'duration':0}
    if kind == 'dc_motor': block['port']='M4'
    send(client, block)
    m.ota_step(ctx)
    assert io.calls == [('stop',)]

def test_native_adapters_bind_only_known_nonblocking_calls(monkeypatch):
    import sys
    calls = []
    def record(name): return lambda *a,**kw: calls.append((name,a,kw))
    mbot = SimpleNamespace(forward=record('forward'), backward=record('backward'), EM_stop=record('stop'),
        starter_shield=SimpleNamespace(dc_motor_stop=record('dc_stop'), dc_motor_set_power=record('dc'), servo_set_angle=record('servo')))
    cyber = SimpleNamespace(audio=SimpleNamespace(stop=lambda:None),wifi=SimpleNamespace(is_connect=lambda:True),display=SimpleNamespace(show_label=record('display')), led=SimpleNamespace(off=record('off'),show=record('led')), get_battery=lambda:77)
    monkeypatch.setitem(sys.modules,'mbot2',mbot)
    monkeypatch.setitem(sys.modules,'cyberpi',cyber)
    monkeypatch.setitem(sys.modules,'mbuild',SimpleNamespace(ultrasonic2=SimpleNamespace(get=lambda:23)))
    monkeypatch.setitem(sys.modules,'simple_mqtt',SimpleNamespace(MQTTClient=Client))
    m=load()
    assert not calls
    io=m.native()['io']
    for b in m.validate([{'type':'move_forward'}, {'type':'move_backward'}, {'type':'dc_motor','port':'M3','speed':-20}, {'type':'servo','port':'S4','angle':45}, {'type':'display_text','text':'Hi'}, {'type':'set_led','color':'red'}]):
        io.execute(b)
    io.stop()
    assert [c[0] for c in calls]==['forward','backward','dc','servo','display','led','stop','dc_stop']
    assert calls[2][1]==(3,-20) and calls[3][1]==(4,45)
    assert io.sensors()=={'distance':23,'errors':{},'sampling':True}
    assert io.sensors(1)=={'distance':23,'battery':77,'errors':{},'sampling':True}

def test_ota_protocol_and_actual_server_envelopes():
    m,ctx,clock,io,client=setup()
    assert m.OTA_APP_PROTOCOL == 1
    send(client, {'run_id':'real','timestamp':123,'program':[{'type':'wait','duration':0,'_id':'editor'}]}, 'program')
    m.ota_step(ctx)
    assert any(e.get('event')=='completed' and e.get('run_id')=='real' and e.get('type')=='program' for _,e in client.events)
    send(client, {'run_id':'wrapped','command':{'type':'move_forward','duration':0.1,'speed':10}})
    m.ota_step(ctx)
    assert io.calls[-1][0]=='move_forward'
    send(client, {}, 'emergency'); m.ota_step(ctx)
    assert any(e.get('event')=='canceled' and e.get('run_id')=='wrapped' for _,e in client.events)

def test_wifi_gate_and_heartbeat_during_wait():
    m,ctx,clock,io,client=setup()
    app=m._app
    app.disconnect(clock.now)
    app.network_ready=lambda:False
    clock.now=(clock.now+3000)%65536
    m.ota_step(ctx)
    assert app.client is None
    app.network_ready=lambda:True
    m.ota_step(ctx);client=app.client
    send(client, {'run_id':'wait','program':[{'type':'wait','duration':20}]},'program')
    m.ota_step(ctx)
    count=sum(t.endswith(b'/status') for t,_ in client.events)
    clock.now=(clock.now+5100)%65536
    m.ota_step(ctx)
    assert sum(t.endswith(b'/status') for t,_ in client.events)>count
    assert app.blocks is not None

def test_runtime_failure_prints_cause_before_loader_rollback(capsys):
    m,ctx,clock,io,client=setup()
    def fail():raise ValueError('specific native failure')
    m._app.step=fail
    with pytest.raises(ValueError):m.ota_step(ctx)
    assert 'specific native failure' in capsys.readouterr().out

def test_native_calls_and_publish_do_not_run_inside_dispatch_stack():
    import inspect
    m,ctx,clock,io,client=setup()
    def checked_stop():
        names=[f.function for f in inspect.stack()]
        assert not any(n in names for n in ('step','cancel','disconnect'))
        io.calls.append(('stop',))
    io.stop=checked_stop
    publish=client.publish
    def checked_publish(*a,**kw):
        assert 'step' not in [f.function for f in inspect.stack()]
        return publish(*a,**kw)
    client.publish=checked_publish
    send(client, {}, 'emergency')
    m.ota_step(ctx)
    assert io.calls[-1]==('stop',)
    assert m._app.client is not None

def test_validation_is_whole_program_and_strict():
    m = load()
    assert m.validate([{'type':'move_forward','params':{'speed':10,'duration':0.1},'_id':'ui'}])[0]['speed'] == 10
    for blocks in ([{'type':'stop'}]*33, [{'type':'stop'}, {'type':'repeat'}],
                   [{'type':'servo','port':'S1','angle':90,'speed':1}],
                   [{'type':'move_forward','speed':51,'duration':1}],
                   [{'type':'wait','duration':float('nan')}],
                   [{'type':'set_led','color':'unknown'}]):
        with pytest.raises(ValueError):
            m.validate(blocks)


@pytest.mark.parametrize('kind', ['move_forward', 'wait'])
@pytest.mark.parametrize('wrapped', [False, True])
def test_validated_stop_preempts_shallow(kind, wrapped):
    import inspect
    m, ctx, clock, io, client = setup()
    send(client, {'run_id': 'active', 'type': kind, 'duration': 5})
    m.ota_step(ctx)
    def checked_stop():
        assert not any(f.function in ('put', 'step', 'cancel', 'disconnect') for f in inspect.stack())
        io.calls.append(('stop',))
    io.stop = checked_stop
    request = {'run_id': 'stop-request', 'type': 'stop'}
    if wrapped:
        request = {'run_id': 'stop-request', 'command': {'type': 'stop', 'timestamp': 123}}
    before = list(io.calls)
    send(client, request)
    assert io.calls == before
    m.ota_step(ctx)
    assert io.calls[-1] == ('stop',)
    assert m._app.timer is None and m._app.blocks is None
    assert any(e.get('event') == 'canceled' and e.get('run_id') == 'active' for _, e in client.events)
    assert any(e.get('event') == 'completed' and e.get('run_id') == 'stop-request' for _, e in client.events)
    assert m._app.run_id is None


@pytest.mark.parametrize('payload,topic', [
    ({'program': [{'type': 'stop'}]}, 'command'),
    ({'blocks': [{'type': 'stop'}]}, 'program'),
    ({'type': 'stop'}, 'program'),
    ({'type': 'stop', 'unexpected': True}, 'command'),
    ({'type': 'stop', 'run_id': 123}, 'command'),
])
def test_only_valid_standalone_command_stop_has_priority(payload, topic):
    m, ctx, clock, io, client = setup()
    send(client, {'type': 'move_forward', 'duration': 5})
    m.ota_step(ctx)
    send(client, payload, topic)
    m.ota_step(ctx)
    assert io.calls[-1][0] == 'move_forward'
    assert m._app.timer is not None


def test_embedded_stop_remains_sequential():
    m, ctx, clock, io, client = setup()
    send(client, {'run_id': 'program', 'program': [
        {'type': 'wait', 'duration': 1}, {'type': 'stop'},
        {'type': 'move_forward', 'duration': 0.1}]}, 'program')
    m.ota_step(ctx)
    m.ota_step(ctx)
    assert io.calls == [('stop',)]
    clock.now = (clock.now + 1001) % 65536
    m.ota_step(ctx)
    m.ota_step(ctx)
    assert io.calls == [('stop',), ('stop',)]
    m.ota_step(ctx)
    assert io.calls[-1][0] == 'move_forward'


def test_identity_mismatch_stops_shallow_before_raising():
    import inspect
    m, ctx, clock, io, client = setup()
    send(client, {'type': 'move_forward', 'duration': 5})
    m.ota_step(ctx)
    def checked_stop():
        assert not any(f.function in ('step', 'cancel', 'disconnect') for f in inspect.stack())
        io.calls.append(('stop',))
    io.stop = checked_stop
    wrong = SimpleNamespace(**vars(ctx))
    wrong.sha256 = 'b' * 64
    with pytest.raises(ValueError, match='identity'):
        m.ota_step(wrong)
    assert io.calls[-1] == ('stop',)
    assert m._app.action is None
    assert m._app.blocks is None and m._app.timer is None


def test_command_stop_preempts_active_motor():
    m, ctx, clock, io, client = setup()
    send(client, {'run_id': 'moving', 'type': 'move_forward', 'duration': 5})
    m.ota_step(ctx)
    send(client, {'run_id': 'stop-request', 'type': 'stop'})
    m.ota_step(ctx)
    assert io.calls[-1] == ('stop',), 'standalone stop remains pending behind active five-second motor timer'
    assert m._app.blocks is None


def test_callback_stop_is_not_dropped_behind_pending_motion():
    m, ctx, clock, io, client = setup()
    send(client, {'run_id': 'moving', 'type': 'move_forward', 'duration': 5})
    send(client, {'run_id': 'stop-request', 'type': 'stop'})
    m.ota_step(ctx)
    assert not any(call[0] == 'move_forward' for call in io.calls), 'stop callback was discarded and motion started'


@pytest.mark.parametrize('kind', ['servo', 'read_sensors', 'move_forward'])
def test_final_native_failure_retains_run_id(kind):
    m, ctx, clock, io, client = setup()
    request = {'run_id': 'native-failure', 'type': kind}
    if kind == 'servo':
        request['port'] = 'S1'
        io.fail = True
    elif kind == 'read_sensors':
        def fail_sensors(index=0):
            raise RuntimeError('sensor fault')
        io.sensors = fail_sensors
    else:
        request['duration'] = 0.1
    send(client, request)
    m.ota_step(ctx)
    if kind == 'move_forward':
        original_stop = io.stop
        attempts = []
        def fail_first_stop():
            attempts.append(True)
            if len(attempts) == 1:
                raise RuntimeError('first stop fault')
            original_stop()
        io.stop = fail_first_stop
        clock.now = (clock.now + 101) % 65536
        m.ota_step(ctx)
    failures = [event for _, event in client.events if event.get('event') == 'failed']
    assert len(failures) == 1
    assert failures[0]['run_id'] == 'native-failure', failures


def test_final_publish_failure_with_heartbeat_retains_run_id():
    m, ctx, clock, io, client = setup()
    send(client, {'run_id': 'publish-failure', 'type': 'move_forward', 'duration': 5})
    m.ota_step(ctx)
    def fail_publish(*args, **kwargs):
        raise OSError('publish fault')
    client.publish = fail_publish
    clock.now = (clock.now + 5001) % 65536
    m.ota_step(ctx)
    assert m._app.client is None
    assert io.calls[-1] == ('stop',)
    clock.now = (clock.now + 2001) % 65536
    m.ota_step(ctx)
    failures = [event for _, event in m._app.client.events if event.get('event') == 'failed']
    assert any(event.get('run_id') == 'publish-failure' for event in failures), failures


@pytest.mark.parametrize('failure', ['native', 'publish'])
def test_priority_stop_failure_preserves_preempted_run_terminal(failure):
    # Copied from the independent motor-server rereview reproduction.
    m, ctx, clock, io, client = setup()
    send(client, {'run_id': 'active-old', 'type': 'move_forward', 'duration': 5})
    m.ota_step(ctx)
    send(client, {'run_id': 'priority-stop', 'type': 'stop'})
    if failure == 'native':
        original = io.stop
        attempts = []
        def fail_once():
            attempts.append(True)
            if len(attempts) == 1:
                raise RuntimeError('first native stop failed')
            original()
        io.stop = fail_once
    else:
        def fail_publish(*args, **kwargs):
            raise OSError('publish failed')
        client.publish = fail_publish
    m.ota_step(ctx)
    events = [event for _, event in client.events if event.get('type') == 'program']
    if failure == 'publish':
        clock.now = (clock.now + 2001) % 65536
        m.ota_step(ctx)
        events += [event for _, event in m._app.client.events if event.get('type') == 'program']
    assert io.calls[-1] == ('stop',)
    assert any(event.get('run_id') == 'priority-stop' and event.get('event') == 'failed' for event in events)
    assert any(event.get('run_id') == 'active-old' and event.get('event') in ('canceled', 'completed', 'failed') for event in events), events
    assert sum(event.get('run_id') == 'active-old' and event.get('event') == 'canceled' for event in events) == 1
    assert not any(event.get('run_id') == 'priority-stop' and event.get('event') == 'completed' for event in events)
    assert m._app.run_id is None


def native_sensor_setup(monkeypatch, failures=None):
    """Exercise the production native adapter using host-only vendor stubs."""
    import sys
    import inspect
    calls = []
    failures = {} if failures is None else failures
    values = {'distance': 23, 'battery': 77, 'loudness': 0, 'brightness': 42,
              'yaw': -5, 'pitch': 6, 'roll': -7, 'line_status': 1,
              'color_L1': '#001122', 'color_L2': '#334455',
              'color_R1': '#667788', 'color_R2': '#99aabb'}

    def reading(key):
        # No firmware wrappers may sit between IO.sensors and a vendor call.
        frame = inspect.currentframe().f_back
        assert frame.f_code.co_name in ('sensors', 'get_color')
        if frame.f_code.co_name == 'get_color':
            frame = frame.f_back
        assert frame.f_code.co_name == 'sensors'
        assert frame.f_back.f_code.co_name == 'ota_step'
        calls.append(key)
        if key in failures:
            raise failures[key]
        return values[key]

    class Quad:
        def get_color(self, port):
            assert port in ('L1', 'L2', 'R1', 'R2')
            return reading('color_' + port)

    # Bind directly to the stub implementation: no extra production helper frames.
    from functools import partial
    cyber = SimpleNamespace(wifi=SimpleNamespace(is_connect=lambda: True), audio=SimpleNamespace(stop=lambda: None))
    for key in ('battery', 'loudness', 'brightness', 'yaw', 'pitch', 'roll'):
        setattr(cyber, 'get_' + key, partial(reading, key))
    mbot = SimpleNamespace(EM_stop=lambda: None,
                          starter_shield=SimpleNamespace(dc_motor_stop=lambda: None))
    mbuild = SimpleNamespace(ultrasonic2=SimpleNamespace(get=partial(reading, 'distance')),
                            quad_rgb_sensor=Quad(),
                            dual_rgb_sensor=SimpleNamespace(get_line_sta=partial(reading, 'line_status')))
    for name, module in (('cyberpi', cyber), ('mbot2', mbot), ('mbuild', mbuild),
                         ('simple_mqtt', SimpleNamespace(MQTTClient=Client))):
        monkeypatch.setitem(sys.modules, name, module)
    m, ctx, clock, _, client = setup()
    m._app.io = m.native()['io']
    return m, ctx, clock, client, calls, values, failures, cyber, mbuild


def test_native_sensor_scan_is_bounded_shallow_and_reaches_every_reading(monkeypatch):
    m, ctx, clock, client, calls, values, _, _, _ = native_sensor_setup(monkeypatch)
    send(client, {'type': 'read_sensors'})
    for index in range(len(values)):
        before = len(calls)
        m.ota_step(ctx)
        assert len(calls) == before + 1, 'each OTA step must perform exactly one native sensor read'
        data = [e for t, e in client.events if t.endswith(b'/sensors')][-1]
        assert data['sampling'] is (index < len(values) - 1)
    assert calls == list(values)[:7] + list(values)[8:] + ['line_status']
    assert {key: data[key] for key in values} == values
    assert data['errors'] == {}
    for _ in range(3):
        m.ota_step(ctx)
    assert len(calls) == len(values), 'sampling must terminate, not become a perpetual poll'


@pytest.mark.parametrize('failed_key', ['distance', 'battery', 'loudness', 'brightness',
    'yaw', 'pitch', 'roll', 'color_L1', 'color_L2', 'color_R1', 'color_R2', 'line_status'])
def test_native_sensor_failure_is_per_reading_bounded_and_recovers(monkeypatch, failed_key):
    failure = RuntimeError('native fault ' + 'x' * 200)
    m, ctx, clock, client, calls, values, failures, _, _ = native_sensor_setup(monkeypatch, {failed_key: failure})
    send(client, {'type': 'read_sensors'})
    for _ in range(len(values)):
        m.ota_step(ctx)
    data = [e for t, e in client.events if t.endswith(b'/sensors')][-1]
    assert len(calls) == len(values), 'a failed driver must not abort later readings'
    assert not data['sampling']
    assert data['errors'] == {failed_key: str(failure)[:128]}
    assert failed_key not in data, 'errors must not synthesize a sensor value'
    assert {key: data[key] for key in values if key != failed_key} == {key: value for key, value in values.items() if key != failed_key}
    assert m._app.client is client
    assert not any(e.get('event') == 'failed' for _, e in client.events)
    failures.clear()
    send(client, {'type': 'read_sensors'})
    m.ota_step(ctx)
    fresh = [e for t, e in client.events if t.endswith(b'/sensors')][-1]
    assert 'battery' not in fresh, 'a new scan cannot reuse old readings'
    for _ in range(len(values) - 1):
        m.ota_step(ctx)
    recovered = [e for t, e in client.events if t.endswith(b'/sensors')][-1]
    assert recovered['errors'] == {}
    assert {key: recovered[key] for key in values} == values


def test_native_sensor_capability_discovery_is_read_only_and_whitelisted(monkeypatch):
    m, ctx, clock, client, calls, values, _, cyber, mbuild = native_sensor_setup(monkeypatch)
    def forbidden(*args, **kwargs):
        raise AssertionError('capability discovery must not invoke audio or quad methods')
    cyber.audio = SimpleNamespace(play=forbidden, play_tone=forbidden, stop=forbidden,
                                  private_secret='must not publish', arbitrary=forbidden)
    mbuild.quad_rgb_sensor.get_line_sta = forbidden
    mbuild.quad_rgb_sensor.private_secret = 'must not publish'
    send(client, {'type': 'read_sensors'})
    for _ in range(len(values)):
        m.ota_step(ctx)
    data = [e for t, e in client.events if t.endswith(b'/sensors')][-1]
    assert data['audio_methods'] == ['play', 'play_tone', 'stop']
    assert data['quad_methods'] == ['get_color', 'get_line_sta']
    assert data['errors'] == {}
    assert 'private_secret' not in str(data) and 'arbitrary' not in str(data)
    assert len(calls) == len(values)


@pytest.mark.parametrize('interruption', ['stop', 'emergency', 'network', 'publish', 'identity'])
def test_native_sensor_scan_cancels_and_next_request_starts_fresh(monkeypatch, interruption):
    m, ctx, clock, client, calls, values, _, _, _ = native_sensor_setup(monkeypatch)
    send(client, {'type': 'read_sensors'})
    m.ota_step(ctx)
    assert calls == ['distance']
    if interruption == 'stop':
        send(client, {'type': 'stop'})
    elif interruption == 'emergency':
        send(client, {}, 'emergency')
    elif interruption == 'network':
        client.fail = True
    elif interruption == 'publish':
        def fail_publish(*args, **kwargs):
            raise OSError('publish fault')
        client.publish = fail_publish
    else:
        wrong = SimpleNamespace(**vars(ctx))
        wrong.sha256 = 'b' * 64
        with pytest.raises(ValueError, match='identity'):
            m.ota_step(wrong)
    if interruption != 'identity':
        m.ota_step(ctx)
    count = len(calls)
    clock.now = (clock.now + 2001) % 65536
    for _ in range(3):
        m.ota_step(ctx)
    assert len(calls) == count, 'cancellation must not resume a stale scan'
    send(m._app.client, {'type': 'read_sensors'})
    m.ota_step(ctx)
    assert calls[-1] == 'distance'
    data = [e for t, e in m._app.client.events if t.endswith(b'/sensors')][-1]
    assert 'battery' not in data


def test_native_sensor_missing_apis_are_errors_not_fallbacks(monkeypatch):
    m, ctx, clock, client, calls, values, _, cyber, mbuild = native_sensor_setup(monkeypatch)
    del cyber.get_pitch
    del cyber.audio
    del mbuild.quad_rgb_sensor
    del mbuild.dual_rgb_sensor
    send(client, {'type': 'read_sensors'})
    for _ in range(len(values)):
        m.ota_step(ctx)
    data = [e for t, e in client.events if t.endswith(b'/sensors')][-1]
    missing = {'pitch', 'color_L1', 'color_L2', 'color_R1', 'color_R2', 'line_status',
               'audio_methods', 'quad_methods'}
    assert set(data['errors']) == missing
    assert not missing.intersection(data)
    assert data['distance'] == 23 and data['battery'] == 77
    assert data['loudness'] == 0 and data['roll'] == -7
    assert not data['sampling']


def test_repeated_sensor_requests_do_not_restart_an_active_scan(monkeypatch):
    m, ctx, clock, client, calls, values, _, _, _ = native_sensor_setup(monkeypatch)
    for _ in range(len(values)):
        send(client, {'type': 'read_sensors'})
        m.ota_step(ctx)
    data = [e for t, e in client.events if t.endswith(b'/sensors')][-1]
    assert len(calls) == len(values)
    assert len(set(calls)) == len(values)
    assert not data['sampling']
    assert {key: data[key] for key in values} == values


@pytest.mark.parametrize('kind', ['turn_left', 'turn_right'])
def test_turn_validation_is_bounded_strict_and_advertised(kind):
    m, ctx, clock, io, client = setup()
    assert kind in m.CAPS
    assert kind in client.events[-1][1]['capabilities']
    assert m.validate([{'type': kind}]) == [{'type': kind, 'angle': 0}]
    for angle in (0, 0.5, 15, 30):
        assert m.validate([{'type': kind, 'params': {'angle': angle}}]) == [
            {'type': kind, 'angle': angle}]
    for angle in (-0.1, 30.1, 90, True, False, '10', None,
                  float('nan'), float('inf'), -float('inf')):
        with pytest.raises(ValueError, match='angle'):
            m.validate([{'type': kind, 'angle': angle}])
    for extra in ({'speed': 0}, {'speed': 20}, {'duration': 0}, {'duration': 1}):
        with pytest.raises(ValueError, match='parameter'):
            m.validate([dict({'type': kind, 'angle': 10}, **extra)])


@pytest.mark.parametrize('kind,sign', [('turn_left', -1), ('turn_right', 1)])
@pytest.mark.parametrize('failure', [False, True])
@pytest.mark.parametrize('angle', [0, 0.5, 30])
def test_native_turn_sign_zero_shallow_completion_and_failure_stop(monkeypatch, kind, sign, failure, angle):
    import inspect
    import sys
    m, ctx, clock, io, client = setup()
    calls = []

    def turn(angle):
        frame = inspect.currentframe().f_back
        assert frame.f_code.co_name == 'execute'
        assert frame.f_back.f_code.co_name == 'ota_step'
        assert not any(f.function in ('step', 'cancel', 'disconnect') for f in inspect.stack())
        assert not any(e.get('event') == 'completed' for _, e in client.events)
        calls.append(('turn', angle))
        if failure:
            raise RuntimeError('turn fault')

    mbot = SimpleNamespace(turn=turn, EM_stop=lambda: calls.append(('stop',)),
        starter_shield=SimpleNamespace(dc_motor_stop=lambda: calls.append(('dc_stop',))))
    for name, module in (('mbot2', mbot),
                         ('cyberpi', SimpleNamespace(wifi=SimpleNamespace(is_connect=lambda: True), audio=SimpleNamespace(stop=lambda: None))),
                         ('mbuild', SimpleNamespace()),
                         ('simple_mqtt', SimpleNamespace(MQTTClient=Client))):
        monkeypatch.setitem(sys.modules, name, module)
    m._app.io = m.native()['io']
    send(client, {'run_id': 'turn-test', 'type': kind, 'angle': angle})
    m.ota_step(ctx)
    if angle == 0:
        assert calls == [], 'zero angle must not call any native actuator'
        failure = False
    else:
        assert calls == ([('turn', sign * angle), ('stop',), ('dc_stop',)] if failure
                         else [('turn', sign * angle)])
    events = [e for _, e in client.events if e.get('run_id') == 'turn-test']
    terminal = [e for e in events if e.get('type') == 'program' and
                e.get('event') in ('completed', 'failed')]
    assert [e['event'] for e in terminal] == ['failed' if failure else 'completed']
    if failure:
        assert terminal[0]['error'] == 'turn fault'
        assert not any(e.get('event') == 'completed' for e in events)
    assert m._app.blocks is None and m._app.timer is None
    assert m._app.run_id is None


@pytest.mark.parametrize('block', [
    {'type': 'play_tone', 'frequency': 100, 'duration': 0},
    {'type': 'play_tone', 'frequency': 2000, 'duration': 2},
    *[{'type': 'play_sound', 'sound': s} for s in ('hello', 'beeps', 'laugh', 'score')],
    {'type': 'set_volume', 'volume': 0}, {'type': 'set_volume', 'volume': 60},
    {'type': 'stop_sound'},
])
def test_audio_validation_and_capabilities(block):
    m = load()
    assert block['type'] in m.CAPS
    assert m.validate([block]) == [block]


@pytest.mark.parametrize('block', [
    {'type': 'play_tone', 'frequency': f} for f in (99, 2001, True, '440', float('nan'), float('inf'))
] + [
    {'type': 'play_tone', 'duration': d} for d in (-0.1, 2.1, True, '1', float('nan'))
] + [
    {'type': 'set_volume', 'volume': v} for v in (-1, 61, 1.5, 20.0, True, '20', None)
] + [
    {'type': 'play_sound', 'sound': 'explosion'}, {'type': 'play_sound'},
    {'type': 'stop_sound', 'duration': 1}, {'type': 'play_tone', 'code': 'bad'},
])
def test_malformed_audio_whole_program_has_no_execution_effects(block):
    m, ctx, clock, io, client = setup()
    send(client, {'program': [{'type': 'play_sound', 'sound': 'hello'}, block]}, 'program')
    m.ota_step(ctx)
    assert all(call == ('stop',) for call in io.calls)
    assert not any(e.get('event') == 'started' for _, e in client.events)
    assert any(e.get('event') == 'failed' for _, e in client.events)


def test_zero_tone_does_not_dispatch_or_wait():
    m, ctx, clock, io, client = setup()
    send(client, {'type': 'play_tone', 'frequency': 440, 'duration': 0})
    m.ota_step(ctx)
    assert io.calls == [('stop',)]
    assert m._app.timer is None
    assert any(e.get('event') == 'completed' for _, e in client.events)


def native_av_setup(monkeypatch):
    import inspect
    import sys
    m, ctx, clock, _, client = setup()
    calls, failures = [], {}
    def record(name):
        def call(*args, **kwargs):
            frame = inspect.currentframe().f_back
            assert frame.f_code.co_name in ('execute', 'stop')
            assert frame.f_back.f_code.co_name == 'ota_step'
            calls.append((name, args, kwargs))
            if name in failures:
                raise RuntimeError(name + ' fault')
        return call
    cyber = SimpleNamespace(wifi=SimpleNamespace(is_connect=lambda: True),
        audio=SimpleNamespace(play_tone=record('tone'), play=record('sound'),
                              set_vol=record('volume'), stop=record('audio_stop')),
        display=SimpleNamespace(show_label=record('display')))
    mbot = SimpleNamespace(EM_stop=record('motor_stop'),
        starter_shield=SimpleNamespace(dc_motor_stop=record('dc_stop')))
    for name, module in (('cyberpi', cyber), ('mbot2', mbot), ('mbuild', SimpleNamespace()),
                         ('simple_mqtt', SimpleNamespace(MQTTClient=Client))):
        monkeypatch.setitem(sys.modules, name, module)
    m._app.io = m.native()['io']
    return m, ctx, clock, client, calls, failures


@pytest.mark.parametrize('block,expected', [
    ({'type': 'play_tone', 'frequency': 440, 'duration': 0.5}, [('tone', (440, 0.5), {})]),
    ({'type': 'play_tone', 'frequency': 100, 'duration': 0}, []),
    *[({'type': 'play_sound', 'sound': s}, [('sound', (s,), {})]) for s in ('hello', 'beeps', 'laugh', 'score')],
    ({'type': 'set_volume', 'volume': 60}, [('volume', (60,), {})]),
    ({'type': 'stop_sound'}, [('audio_stop', (), {})]),
])
def test_native_audio_exact_args_shallow(monkeypatch, block, expected):
    m, ctx, clock, client, calls, _ = native_av_setup(monkeypatch)
    send(client, dict(block, run_id='audio'))
    m.ota_step(ctx)
    assert calls == expected
    clock.now = (clock.now + 501) % 65536
    m.ota_step(ctx)
    assert any(e.get('event') == 'completed' and e.get('run_id') == 'audio' for _, e in client.events)


@pytest.mark.parametrize('interruption', ['stop', 'emergency'])
@pytest.mark.parametrize('failed', [None, 'audio_stop', 'motor_stop'])
def test_native_stop_audio_and_both_motors_even_on_failure(monkeypatch, interruption, failed):
    m, ctx, clock, client, calls, failures = native_av_setup(monkeypatch)
    send(client, {'run_id': 'active', 'type': 'wait', 'duration': 5})
    m.ota_step(ctx)
    if failed:
        failures[failed] = True
    send(client, {'type': 'stop'}, 'command' if interruption == 'stop' else 'emergency')
    m.ota_step(ctx)
    assert {c[0] for c in calls} == {'audio_stop', 'motor_stop', 'dc_stop'}
    assert m._app.blocks is None and m._app.timer is None
    if failed:
        assert any(e.get('event') == 'failed' for _, e in client.events)


@pytest.mark.parametrize('block,failed', [
    ({'type': 'play_tone', 'duration': 2}, 'tone'),
    ({'type': 'play_sound', 'sound': 'hello'}, 'sound'),
    ({'type': 'set_volume', 'volume': 30}, 'volume'),
    ({'type': 'stop_sound'}, 'audio_stop'),
])
def test_audio_native_failure_cleanup_keeps_original_error(monkeypatch, block, failed):
    m, ctx, clock, client, calls, failures = native_av_setup(monkeypatch)
    failures.update({failed: True, 'audio_stop': True})
    send(client, {'run_id': 'audio-fault', 'program': [block, {'type': 'play_sound', 'sound': 'score'}]}, 'program')
    m.ota_step(ctx)
    assert {'motor_stop', 'dc_stop', 'audio_stop'}.issubset(c[0] for c in calls)
    assert m._app.blocks is None and m._app.timer is None
    terminal = [e for _, e in client.events if e.get('type') == 'program' and e.get('event') in ('failed', 'completed')]
    assert len(terminal) == 1 and terminal[0]['event'] == 'failed'
    assert terminal[0]['error'] == failed + ' fault'
    assert terminal[0]['run_id'] == 'audio-fault'


def test_animation_expands_bounded_text_wait_before_execution():
    m = load()
    assert 'display_animation' in m.CAPS
    animation = {'type': 'display_animation', 'params': {'frames': ['A', 'B'], 'interval': 0.15}}
    assert m.validate([animation]) == [
        {'type': 'display_text', 'text': 'A', 'size': 24}, {'type': 'wait', 'duration': 0.15},
        {'type': 'display_text', 'text': 'B', 'size': 24}, {'type': 'wait', 'duration': 0.15}]
    assert animation['params']['frames'] == ['A', 'B']
    assert len(m.validate([{'type': 'display_animation', 'frames': ['x' * 128] * 12, 'interval': 1}])) == 24
    assert len(m.validate([{'type': 'display_animation', 'frames': ['x'] * 8, 'interval': 0.15}] * 2)) == 32


@pytest.mark.parametrize('tail', [
    [{'type': 'display_animation', 'frames': f, 'interval': 0.15}] for f in ([], ['x'] * 13, 'x', [1], [True], ['x' * 129], None)
] + [
    [{'type': 'display_animation', 'frames': ['x'], 'interval': i}] for i in (0, 0.149, 2.01, True, '1', float('nan'), float('inf'))
] + [
    [{'type': 'display_animation', 'frames': ['x'], 'interval': 0.15, 'size': 32}],
    [{'type': 'display_animation', 'frames': ['x'] * 7, 'interval': 2}],
    [{'type': 'display_animation', 'frames': ['x'] * 4, 'interval': 2}] * 2,
    [{'type': 'display_animation', 'frames': ['x'] * 8, 'interval': 0.15}] * 2,
    [{'type': 'display_animation', 'frames': ['x'], 'interval': 0.15}, {'type': 'repeat'}],
])
def test_invalid_animation_whole_program_has_no_execution_effects(tail):
    m, ctx, clock, io, client = setup()
    send(client, {'program': [{'type': 'play_sound', 'sound': 'hello'}] + tail}, 'program')
    m.ota_step(ctx)
    assert all(call == ('stop',) for call in io.calls)
    assert not any(e.get('event') == 'started' for _, e in client.events)
    assert any(e.get('event') == 'failed' for _, e in client.events)


def test_animation_native_frame_order_timing_and_chronological_events(monkeypatch):
    m, ctx, clock, client, calls, _ = native_av_setup(monkeypatch)
    send(client, {'run_id': 'frames', 'program': [
        {'type': 'display_animation', 'frames': ['A', 'B'], 'interval': 0.15}]}, 'program')
    m.ota_step(ctx)
    assert calls == [('display', ('A', 24, 'center'), {'index': 0})]
    m.ota_step(ctx)  # first frame hold
    clock.now = (clock.now + 149) % 65536
    m.ota_step(ctx)
    assert len(calls) == 1
    clock.now = (clock.now + 1) % 65536
    m.ota_step(ctx)  # first hold completes
    m.ota_step(ctx)  # next frame
    assert calls[-1] == ('display', ('B', 24, 'center'), {'index': 0})
    m.ota_step(ctx)
    clock.now = (clock.now + 150) % 65536
    m.ota_step(ctx)
    events = [(e['type'], e['event'], e.get('path')) for _, e in client.events if e.get('run_id') == 'frames']
    assert events == [('program', 'started', None)] + [
        ('block', event, [i]) for i in range(4) for event in ('started', 'completed')
    ] + [('program', 'completed', None)]
    assert m._app.blocks is None and m._app.timer is None


@pytest.mark.parametrize('interruption', ['stop', 'emergency', 'display_failure'])
def test_animation_cancels_remaining_frames_and_cleans_up(monkeypatch, interruption):
    m, ctx, clock, client, calls, failures = native_av_setup(monkeypatch)
    if interruption == 'display_failure':
        failures['display'] = True
    send(client, {'run_id': 'frames', 'program': [
        {'type': 'display_animation', 'frames': ['A', 'B', 'C'], 'interval': 0.15}]}, 'program')
    m.ota_step(ctx)
    assert calls[0] == ('display', ('A', 24, 'center'), {'index': 0})
    if interruption != 'display_failure':
        m.ota_step(ctx)
        send(client, {'type': 'stop'}, 'command' if interruption == 'stop' else 'emergency')
        m.ota_step(ctx)
    for _ in range(10):
        clock.now = (clock.now + 200) % 65536
        m.ota_step(ctx)
    assert [c[1][0] for c in calls if c[0] == 'display'] == ['A']
    assert {'audio_stop', 'motor_stop', 'dc_stop'}.issubset(c[0] for c in calls)
    assert m._app.blocks is None and m._app.timer is None
    expected = 'failed' if interruption == 'display_failure' else 'canceled'
    assert any(e.get('run_id') == 'frames' and e.get('event') == expected for _, e in client.events)
    assert not any(e.get('run_id') == 'frames' and e.get('type') == 'program' and e.get('event') == 'completed' for _, e in client.events)


def test_blocking_tone_does_not_add_a_second_duration(monkeypatch):
    import sys
    m, ctx, clock, client, calls, _ = native_av_setup(monkeypatch)
    def blocking_tone(frequency, duration):
        # Simulate elapsed vendor time without sleeping or touching hardware.
        calls.append(('tone', (frequency, duration), {}))
        clock.now = (clock.now + int(duration * 1000)) % 65536
    sys.modules['cyberpi'].audio.play_tone = blocking_tone
    send(client, {'run_id': 'blocking-tone', 'type': 'play_tone', 'frequency': 440, 'duration': 2})
    m.ota_step(ctx)
    m.ota_step(ctx)
    assert m._app.timer is None and m._app.blocks is None
    assert calls == [('tone', (440, 2), {})]
    assert any(e.get('run_id') == 'blocking-tone' and e.get('event') == 'completed' for _, e in client.events)


def test_emergency_callback_preempts_pending_motion_control_case():
    m, ctx, clock, io, client = setup()
    send(client, {'run_id': 'moving', 'type': 'move_forward', 'duration': 5})
    send(client, {}, 'emergency')
    m.ota_step(ctx)
    assert io.calls == [('stop',), ('stop',)]
    assert m._app.pending is None and m._app.blocks is None
