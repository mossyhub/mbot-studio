"""Software-only cooperative engine tests; no native hardware or motor calls."""
import importlib.util
from pathlib import Path
import pytest


PATH = Path(__file__).resolve().parents[1] / 'firmware' / 'robot_engine.py'


def engine_class():
    assert PATH.exists(), 'cooperative engine implementation missing'
    spec = importlib.util.spec_from_file_location('robot_engine', PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.RobotEngine


class Clock:
    def __init__(self):
        self.now = 0

    def ticks_ms(self):
        return self.now % (1 << 20)

    def ticks_diff(self, a, b):
        return ((a - b + (1 << 19)) % (1 << 20)) - (1 << 19)


class IO:
    def __init__(self):
        self.calls = []
        self.stops = 0
        self.values = {'distance': 12}

    def execute(self, kind, params):
        assert kind in ('display_text', 'say', 'set_led')
        self.calls.append((kind, dict(params)))

    def stop(self):
        self.stops += 1

    def read(self, sensor):
        return self.values[sensor]


def setup():
    io, clock = IO(), Clock()
    return engine_class()(io, clock), io, clock


def finish(engine, limit=2000):
    for _ in range(limit):
        if not engine.running:
            return
        engine.step()
    pytest.fail('engine did not terminate within step budget')


def test_constructor_and_wait_lifecycle():
    engine, io, clock = setup()
    assert not engine.running and not engine.armed
    assert isinstance(engine.capabilities, list)
    assert io.calls == [] and io.stops == 0
    accepted = engine.submit([{'type': 'wait', 'params': {'duration': 2}}], 'run-1')
    assert accepted['accepted'] is True and accepted['run_id'] == 'run-1'
    assert [e['event'] for e in engine.drain_events()] == ['accepted']
    engine.step()
    assert engine.running
    clock.now = 1999
    engine.step()
    assert engine.running
    clock.now = 2000
    finish(engine)
    events = engine.drain_events()
    assert events[-1]['event'] == 'completed' and events[-1]['type'] == 'program'
    assert any(e['event'] == 'started' and e['block_path'] == [0] for e in events)
    assert all(e['run_id'] == 'run-1' for e in events)
    assert all(set(e) == {'run_id', 'event', 'block_path', 'type', 'details'} for e in events)
    assert engine.drain_events() == [] and io.calls == []


def test_cancel_deadline_and_recovery():
    engine, io, clock = setup()
    with pytest.raises(ValueError):
        engine.arm()
    engine.submit([{'type': 'wait', 'duration': 50}], 'cancel')
    engine.step()
    engine.stop('emergency')
    assert not engine.running and not engine.armed and io.stops == 1
    assert engine.drain_events()[-1]['event'] == 'canceled'
    clock.now = (1 << 20) - 100
    engine.submit([{'type': 'wait', 'duration': 60}], 'timeout')
    engine.step()
    clock.now += 60000
    engine.step()
    assert not engine.running and io.stops == 2
    assert engine.drain_events()[-1]['details']['reason'] == 'deadline'
    engine.submit([{'type': 'display_text', 'text': 'back'}], 'recovery')
    finish(engine)
    assert io.calls == [('display_text', {'text': 'back', 'size': 14})]


@pytest.mark.parametrize('program', [
    [{'type': 'display_text'}, {'type': 'unknown'}],
    [{'type': 'wait', 'params': []}],
    [{'type': 'wait', 'duration': float('nan')}],
    [{'type': 'wait', 'duration': float('inf')}],
    [{'type': 'wait', 'duration': True}],
    [{'type': 'wait', 'duration': -1}],
    [{'type': 'wait', 'typo': 1}],
    [{'type': 'display_text', 'text': {}}],
    [{'type': 'set_led', 'color': 'not-a-color'}],
    [{'type': 'wait'}] * 257,
])
def test_invalid_program_has_no_side_effects(program):
    engine, io, _ = setup()
    with pytest.raises(ValueError):
        engine.submit(program, 'bad')
    assert not engine.running and io.calls == [] and io.stops == 0
    assert engine.drain_events() == []


def test_one_dispatch_per_step_and_stop_block_cancels_tail():
    engine, io, _ = setup()
    program = [{'type': 'set_led', 'color': 'red'}, {'type': 'stop'},
               {'type': 'say', 'text': 'must not happen'}]
    engine.submit(program, 'bounded')
    program[0]['color'] = 'blue'
    engine.step()
    assert io.calls == [('set_led', {'color': 'red'})]
    engine.step()
    assert not engine.running and io.stops == 1
    assert engine.drain_events()[-1]['event'] == 'canceled'


def test_adapter_failure_is_terminal_and_disarmed():
    engine, io, _ = setup()
    def broken(kind, params):
        raise RuntimeError('adapter unavailable')
    io.execute = broken
    engine.submit([{'type': 'say', 'text': 'hi'}], 'broken')
    engine.step()
    assert not engine.running and not engine.armed and io.stops == 1
    assert engine.drain_events()[-1]['event'] == 'failed'


def test_bounded_repeat_and_reporter_evaluation():
    engine, io, _ = setup()
    engine.submit([
        {'type': 'set_variable', 'name': 'n', 'value': 1},
        {'type': 'repeat', 'times': 3, 'do': [
            {'type': 'change_variable', 'name': 'n', 'by': 2}]},
        {'type': 'math_operation', 'result': 'answer', 'operator': '*',
         'a': {'type': 'var_get', 'name': 'n'}, 'b': 2},
        {'type': 'if_predicate', 'cond': {'type': 'op_eq',
             'a': {'type': 'var_get', 'name': 'answer'}, 'b': 14},
         'then': [{'type': 'say', 'text': 'correct'}]},
    ], 'math')
    finish(engine)
    assert io.calls == [('say', {'text': 'correct', 'size': 14})]
    events = engine.drain_events()
    assert len([e for e in events if e['type'] == 'change_variable' and e['event'] == 'started']) == 3
    assert any(e['block_path'] == [1, 'do', 0] for e in events)


@pytest.mark.parametrize('wrapped', [False, True])
def test_editor_metadata_nested_statements_and_reporters(wrapped):
    engine, io, _ = setup()
    program = [
        {'type': 'set_variable', '_id': 'b_seed', 'name': 'n', 'value': 1},
        {'type': 'repeat', '_id': 'b_loop', 'times': 2, 'do': [
            {'type': 'change_variable', '_id': 'b_change', 'name': 'n',
             'by': {'type': 'op_add', '_id': 'b_add', 'a': 1, 'b': 1}}]},
        {'type': 'if_predicate', '_id': 'b_if',
         'cond': {'type': 'op_and', '_id': 'b_and',
                  'a': {'type': 'op_eq', '_id': 'b_eq',
                        'a': {'type': 'var_get', '_id': 'b_var', 'name': 'n'}, 'b': 5},
                  'b': {'type': 'op_lt', '_id': 'b_lt',
                        'a': {'type': 'sensor_distance', '_id': 'b_sensor'}, 'b': 20}},
         'then': [{'type': 'say', '_id': 'b_say', 'text': 'correct'}]},
    ]
    if wrapped:
        def wrap(block):
            params = {k: v for k, v in block.items() if k not in ('type', '_id')}
            for key in ('do', 'then'):
                if key in params:
                    params[key] = [wrap(child) for child in params[key]]
            return {'type': block['type'], '_id': block['_id'], 'params': params}
        program = [wrap(block) for block in program]
    import copy
    original = copy.deepcopy(program)
    assert engine.submit(program, 'editor')['accepted'] is True

    def assert_no_metadata(value):
        if isinstance(value, dict):
            assert '_id' not in value
            for child in value.values():
                assert_no_metadata(child)
        elif isinstance(value, list):
            for child in value:
                assert_no_metadata(child)
    assert_no_metadata(engine._stack)
    assert program == original
    finish(engine)
    assert io.calls == [('say', {'text': 'correct', 'size': 14})]
    events = engine.drain_events()
    assert events[-1]['event'] == 'completed'
    assert events[-1]['type'] == 'program'
    assert any(e['event'] == 'completed' and e['block_path'] == [2, 'then', 0]
               for e in events)


def metadata_program(metadata, location):
    reporter = {'type': 'sensor_distance'}
    params = {'name': 'n', 'value': reporter}
    block = {'type': 'set_variable', 'params': params}
    target = {'statement': block, 'params': params, 'reporter': reporter}[location]
    target.update(metadata)
    return [{'type': 'repeat', '_id': 'parent', 'do': [block]}]


@pytest.mark.parametrize('location', ['statement', 'params', 'reporter'])
@pytest.mark.parametrize('editor_id', ['', 'x' * 128])
def test_editor_metadata_string_boundaries(location, editor_id):
    engine, _, _ = setup()
    engine.submit(metadata_program({'_id': editor_id}, location), 'bounds')
    finish(engine)
    assert engine._variables == {'n': 12}
    assert engine.drain_events()[-1]['event'] == 'completed'


@pytest.mark.parametrize('location', ['statement', 'params', 'reporter'])
@pytest.mark.parametrize('editor_id', [None, False, 1, [], {}, 'x' * 129])
def test_editor_metadata_invalid_values_reject(location, editor_id):
    engine, io, _ = setup()
    with pytest.raises(ValueError, match='_id must be a string up to 128 characters'):
        engine.submit(metadata_program({'_id': editor_id}, location), 'bad-id')
    assert not engine.running and io.calls == [] and io.stops == 0
    assert engine.drain_events() == []


@pytest.mark.parametrize('location', ['statement', 'params', 'reporter'])
@pytest.mark.parametrize('field', ['typo', 'run_id', 'timestamp', '_other'])
def test_editor_metadata_does_not_allow_other_fields(location, field):
    engine, io, _ = setup()
    with pytest.raises(ValueError):
        engine.submit(metadata_program({'_id': 'valid', field: 'extra'}, location), 'bad')
    assert not engine.running and io.calls == [] and io.stops == 0
    assert engine.drain_events() == []


def test_editor_metadata_does_not_allow_mixed_statement_forms():
    engine, io, _ = setup()
    with pytest.raises(ValueError):
        engine.submit([{'type': 'wait', '_id': 'valid', 'params': {}, 'duration': 0}], 'bad')
    assert not engine.running and io.calls == []


@pytest.mark.parametrize('limit', ['block_depth', 'blocks', 'reporter_depth', 'reporter_nodes'])
def test_editor_metadata_preserves_exact_tree_limits(limit):
    leaf = {'type': 'wait', '_id': 'leaf', 'duration': 0}
    if limit == 'block_depth':
        accepted = [leaf]
        for _ in range(7):
            accepted = [{'type': 'repeat', '_id': 'loop', 'do': accepted}]
        rejected = [{'type': 'repeat', '_id': 'overflow', 'do': accepted}]
    elif limit == 'blocks':
        accepted = [{'type': 'repeat', '_id': 'loop', 'do': [leaf] * 255}]
        rejected = [{'type': 'repeat', '_id': 'loop', 'do': [leaf] * 256}]
    elif limit == 'reporter_depth':
        expr = True
        for _ in range(7):
            expr = {'type': 'op_not', '_id': 'not', 'a': expr}
        accepted = [{'type': 'set_variable', '_id': 'set', 'value': expr}]
        rejected = [{'type': 'set_variable', '_id': 'set',
                     'value': {'type': 'op_not', '_id': 'overflow', 'a': expr}}]
    else:
        accepted = [{'type': 'set_variable', '_id': 'set',
                     'value': {'type': 'op_not', '_id': 'not', 'a': True}}] * 128
        rejected = accepted + [{'type': 'set_variable', '_id': 'overflow', 'value': 0}]
    engine, _, _ = setup()
    assert engine.submit(accepted, 'at-limit')['accepted'] is True
    engine, io, _ = setup()
    with pytest.raises(ValueError, match='limit|at most 256 blocks'):
        engine.submit(rejected, 'over-limit')
    assert not engine.running and io.calls == [] and io.stops == 0
    assert engine.drain_events() == []


def test_forever_is_bounded_and_sensor_wait_is_cooperative():
    engine, io, clock = setup()
    engine.submit([{'type': 'repeat_forever', 'do': []}], 'forever')
    finish(engine)
    assert engine.drain_events()[-1]['details']['reason'] == 'loop limit'
    engine.submit([{'type': 'wait_until', 'cond': {'type': 'op_lt',
        'a': {'type': 'sensor_distance'}, 'b': 10}},
        {'type': 'say', 'text': 'close'}], 'sensor')
    for _ in range(10):
        engine.step()
    assert engine.running and io.calls == []
    io.values['distance'] = 5
    finish(engine)
    assert io.calls[0][1]['text'] == 'close'


@pytest.mark.parametrize('bad', [
    {'type': 'repeat', 'times': 51, 'do': []},
    {'type': 'repeat', 'times': 1.5, 'do': []},
    {'type': 'if_predicate', 'cond': False, 'then': [{'type': 'unknown'}]},
    {'type': 'set_variable', 'name': 'x', 'value': {'type': 'sensor_fake'}},
    {'type': 'set_variable', 'name': 'x', 'value': 'implicit variable'},
    {'type': 'math_operation', 'operator': '%'},
])
def test_nested_validation_rejects_before_dispatch(bad):
    engine, io, _ = setup()
    with pytest.raises(ValueError):
        engine.submit([{'type': 'say', 'text': 'no'}, bad], 'bad')
    assert io.calls == [] and not engine.running


def test_depth_block_budget_and_cycles_rejected():
    engine, io, _ = setup()
    program = [{'type': 'wait'}]
    for _ in range(9):
        program = [{'type': 'repeat', 'do': program}]
    with pytest.raises(ValueError):
        engine.submit(program, 'deep')
    with pytest.raises(ValueError):
        engine.submit([{'type': 'repeat', 'do': [{'type': 'wait'}] * 256}], 'many')
    cycle = {'type': 'repeat'}
    cycle['do'] = [cycle]
    with pytest.raises(ValueError):
        engine.submit([cycle], 'cycle')
    assert io.calls == []


def test_reporter_failure_is_not_fabricated_value():
    engine, io, _ = setup()
    engine.submit([{'type': 'math_operation', 'operator': '/', 'b': 0}], 'zero')
    finish(engine)
    assert engine.drain_events()[-1]['event'] == 'failed'
    engine.submit([{'type': 'set_variable', 'value': {'type': 'var_get', 'name': 'missing'}}], 'undefined')
    finish(engine)
    assert engine.drain_events()[-1]['event'] == 'failed'


def test_event_backpressure_fails_closed_without_unbounded_memory():
    engine, io, _ = setup()
    engine.submit([{'type': 'say', 'text': 'x'}] * 256, 'queue')
    finish(engine)
    events = engine.drain_events()
    assert len(events) <= 128
    assert events[-1]['event'] == 'failed'
    assert events[-1]['details']['reason'] == 'event backpressure'
    assert io.stops == 1


def test_program_started_and_nested_cancellation_events():
    engine, io, _ = setup()
    engine.submit([{'type': 'repeat', 'do': [{'type': 'wait', 'duration': 20}]}], 'nested')
    for _ in range(3):
        engine.step()
    engine.stop()
    events = engine.drain_events()
    assert any(e['event'] == 'started' and e['type'] == 'program' for e in events)
    canceled = [(e['type'], e['block_path']) for e in events if e['event'] == 'canceled']
    assert ('repeat', [0]) in canceled
    assert ('wait', [0, 'do', 0]) in canceled


def test_capabilities_cannot_extend_dispatch_and_invalid_ids_reject():
    engine, io, _ = setup()
    engine.capabilities.append('invented')
    with pytest.raises(ValueError):
        engine.submit([{'type': 'invented'}], 'unsupported')
    for bad_id in (None, '', 12, 'x' * 129):
        with pytest.raises(ValueError):
            engine.submit([], bad_id)
    assert io.calls == []


def test_stop_adapter_failure_still_clears_plan():
    engine, io, _ = setup()
    engine.submit([{'type': 'wait'}], 'stop-error')
    def broken_stop():
        raise RuntimeError('cannot confirm stop')
    io.stop = broken_stop
    engine.stop()
    assert not engine.running and not engine.armed
    event = engine.drain_events()[-1]
    assert event['event'] == 'failed' and event['details']['stop_error'] == 'cannot confirm stop'
