"""Bounded cooperative execution; adapters must themselves be nonblocking.

Actual block catalog (also advertised by capabilities): wait, stop,
display_text, say, set_led, repeat, repeat_forever, set_variable,
change_variable, math_operation, if_predicate, wait_until.

Input is a list of {type, params:{...}} or flat {type,...}; mixed forms and
unknown fields reject, except inert _id strings up to 128 characters on
statements, params and reporters (stripped from the detached execution plan).
Text is literal only (256 characters, size 8..64).
LED colors: red/green/blue/yellow/cyan/magenta/white/off. Wait duration is
literal seconds 0..60. Repeat takes literal integer times 0..50 and do:[...].
if_predicate takes cond and then:[...]; wait_until takes cond. Variables use
name/value or name/by; math_operation uses result/a/b/operator (+,-,*,/).
Names are explicit, never implicit variable interpolation in strings.

Actual reporter catalog: var_get{name}, sensor_distance (io.read('distance')),
op_add/sub/mul/div/gt/lt/eq/and/or{a,b}, op_not{a}. Reporters are flat objects
with type; numeric/boolean literals also accepted in expressions. Numeric
values/results must be finite within +/-1e9. Undefined variables and failed
sensors/division fail the run, never manufacture zero. Other sensors/reporters,
else branches, dynamic display parameters, motion and audio are unsupported.

Limits: 256 blocks, block depth 8, 256 expression nodes total, expression
depth 8, 50 iterations per loop invocation, 60 seconds from acceptance.
repeat_forever fails at its iteration limit or deadline; it is not infinite.
Each step dispatches at most one block or performs one stack transition.
Events must be drained regularly: backlog >=114 fails closed before dispatch;
queue is capped at 128 (repeated idle stop errors coalesce at capacity).
Paths use list indexes and 'do'/'then'; repeated iterations share source paths.
Adapters must be nonblocking. No motion is supported even when enabled;
arm() never auto-runs anything. Stop clears the complete plan and disarms.
Events report software lifecycle, never physical completion. Clock must
supply wrap-safe ticks_ms()/ticks_diff(). This module has no imports.
"""


class RobotEngine:
    BLOCKS = ('wait', 'stop', 'display_text', 'say', 'set_led', 'repeat',
              'repeat_forever', 'set_variable', 'change_variable',
              'math_operation', 'if_predicate', 'wait_until')

    def __init__(self, io, clock, motion_enabled=False):
        self.io = io
        self.clock = clock
        self.motion_enabled = bool(motion_enabled)
        self.armed = False
        self.running = False
        self.capabilities = list(self.BLOCKS)
        self._events = []
        self._run_id = None
        self._pending = None
        self._stack = []
        self._active = None

    def _event(self, event, path=None, kind='program', details=None):
        item = {'run_id': self._run_id, 'event': event,
                'block_path': path or [], 'type': kind, 'details': details or {}}
        if len(self._events) < 128:
            self._events.append(item)
        else:
            self._events[-1] = item

    def drain_events(self):
        events = self._events
        self._events = []
        return events

    def arm(self):
        if not self.motion_enabled:
            raise ValueError('motion disabled')
        self.armed = True

    def _terminate(self, event, reason):
        was_running = self.running
        self.running = False
        self.armed = False
        self._pending = None
        stack = self._stack
        self._stack = []
        details = {'reason': reason}
        try:
            self.io.stop()
        except Exception as exc:
            details['stop_error'] = str(exc)[:160]
            event = 'failed'
        if was_running:
            if self._active is not None:
                self._event(event, self._active[0], self._active[1], details)
            # At most eight validated enclosing controls, not an unbounded walk.
            for frame in reversed(stack):
                if isinstance(frame, dict):
                    target = (frame['path'], frame['block']['type'])
                    if target != self._active:
                        self._event(event, target[0], target[1], details)
            self._event(event, details=details)
        elif 'stop_error' in details:
            self._event('failed', details=details)
        self._active = None

    def stop(self, reason='stop'):
        self._terminate('canceled', reason)

    def _number(self, value, low=-1000000000, high=1000000000):
        if type(value) not in (int, float) or not low <= value <= high:
            raise ValueError('invalid numeric value')
        return value

    def _keys(self, params, allowed):
        if not isinstance(params, dict):
            raise ValueError('invalid parameters')
        # Editor identity is inert; normalized blocks/reporters never copy it.
        metadata = '_id' in params
        if len(params) > len(allowed) + int(metadata):
            raise ValueError('invalid parameters')
        if metadata and (not isinstance(params['_id'], str) or len(params['_id']) > 128):
            raise ValueError('_id must be a string up to 128 characters')
        for key in params:
            if key != '_id' and key not in allowed:
                raise ValueError('unsupported parameter')

    def _name(self, value):
        if not isinstance(value, str) or not 1 <= len(value) <= 32:
            raise ValueError('variable name must contain 1..32 characters')
        return value

    def _expr(self, value, depth=1):
        self._expr_nodes += 1
        if depth > 8 or self._expr_nodes > 256:
            raise ValueError('reporter depth/node limit')
        if type(value) == bool:
            return value
        if type(value) in (int, float):
            return self._number(value)
        if not isinstance(value, dict):
            raise ValueError('numeric literals or explicit reporters required')
        kind = value.get('type')
        if kind == 'var_get':
            self._keys(value, ('type', 'name'))
            return {'type': kind, 'name': self._name(value.get('name'))}
        if kind == 'sensor_distance':
            self._keys(value, ('type',))
            return {'type': kind}
        if kind not in ('op_add', 'op_sub', 'op_mul', 'op_div', 'op_gt',
                        'op_lt', 'op_eq', 'op_and', 'op_or', 'op_not'):
            raise ValueError('unsupported reporter')
        self._keys(value, ('type', 'a') if kind == 'op_not' else ('type', 'a', 'b'))
        result = {'type': kind, 'a': self._expr(value.get('a'), depth + 1)}
        if kind != 'op_not':
            result['b'] = self._expr(value.get('b'), depth + 1)
        return result

    def _eval(self, expr):
        # Trees are detached and validated: at most 256 nodes, depth eight.
        if not isinstance(expr, dict):
            return expr
        kind = expr['type']
        if kind == 'var_get':
            if expr['name'] not in self._variables:
                raise ValueError('undefined variable: ' + expr['name'])
            return self._variables[expr['name']]
        if kind == 'sensor_distance':
            return self._number(self.io.read('distance'))
        a = self._eval(expr['a'])
        if kind == 'op_not':
            return not a
        if kind == 'op_and':
            return bool(a) and bool(self._eval(expr['b']))
        if kind == 'op_or':
            return bool(a) or bool(self._eval(expr['b']))
        b = self._eval(expr['b'])
        if kind == 'op_eq':
            return a == b
        if kind == 'op_gt':
            return a > b
        if kind == 'op_lt':
            return a < b
        self._number(a)
        self._number(b)
        if kind == 'op_add':
            result = a + b
        elif kind == 'op_sub':
            result = a - b
        elif kind == 'op_mul':
            result = a * b
        else:
            result = a / b
        return self._number(result)

    def _validate(self, program, depth=1):
        if depth > 8 or not isinstance(program, list) or len(program) > 256:
            raise ValueError('program must be a list of at most 256 blocks')
        plan = []
        for block in program:
            self._blocks += 1
            if self._blocks > 256:
                raise ValueError('block limit')
            if not isinstance(block, dict):
                raise ValueError('block must be an object')
            kind = block.get('type')
            if not isinstance(kind, str) or kind not in self.BLOCKS:
                raise ValueError('unsupported block (motion unavailable)')
            if 'params' in block:
                self._keys(block, ('type', 'params'))
                p = block['params']
            else:
                if len(block) > 8:
                    raise ValueError('too many block fields')
                p = dict(block)
                del p['type']
            if kind == 'wait':
                self._keys(p, ('duration',))
                q = {'duration': self._number(p.get('duration', 1), 0, 60)}
            elif kind in ('display_text', 'say'):
                self._keys(p, ('text', 'size'))
                text = p.get('text', '')
                if not isinstance(text, str) or len(text) > 256:
                    raise ValueError('text must be a literal up to 256 characters')
                q = {'text': text, 'size': self._number(p.get('size', 14), 8, 64)}
            elif kind == 'set_led':
                self._keys(p, ('color',))
                color = p.get('color', 'green')
                if color not in ('red', 'green', 'blue', 'yellow', 'cyan', 'magenta', 'white', 'off'):
                    raise ValueError('unsupported LED color')
                q = {'color': color}
            elif kind in ('repeat', 'repeat_forever'):
                self._keys(p, ('do', 'times') if kind == 'repeat' else ('do',))
                times = p.get('times', 1)
                if type(times) != int or not 0 <= times <= 50:
                    raise ValueError('repeat times must be an integer in 0..50')
                q = {'times': times, 'do': self._validate(p.get('do', []), depth + 1)}
            elif kind in ('set_variable', 'change_variable'):
                field = 'value' if kind == 'set_variable' else 'by'
                self._keys(p, ('name', field))
                q = {'name': self._name(p.get('name', 'my_var')),
                     field: self._expr(p.get(field, 0 if field == 'value' else 1))}
            elif kind == 'math_operation':
                self._keys(p, ('result', 'a', 'b', 'operator'))
                operator = p.get('operator', '+')
                if operator not in ('+', '-', '*', '/'):
                    raise ValueError('unsupported math operator')
                q = {'result': self._name(p.get('result', 'result')),
                     'expr': self._expr({'type': {'+': 'op_add', '-': 'op_sub', '*': 'op_mul', '/': 'op_div'}[operator],
                                         'a': p.get('a', 0), 'b': p.get('b', 0)})}
            elif kind in ('if_predicate', 'wait_until'):
                self._keys(p, ('cond', 'then') if kind == 'if_predicate' else ('cond',))
                q = {'cond': self._expr(p.get('cond', False))}
                if kind == 'if_predicate':
                    q['then'] = self._validate(p.get('then', []), depth + 1)
            else:
                self._keys(p, ())
                q = {}
            plan.append({'type': kind, 'params': q})
        return plan

    def submit(self, program, run_id):
        if self.running:
            raise ValueError('busy')
        if len(self._events) >= 114:
            raise ValueError('drain events before submission')
        if not isinstance(run_id, str) or not 1 <= len(run_id) <= 128:
            raise ValueError('run_id must be a nonempty string up to 128 characters')
        self._blocks = 0
        self._expr_nodes = 0
        plan = self._validate(program)
        self._variables = {}
        self._run_id = run_id
        self._started = self.clock.ticks_ms()
        self._stack = [[plan, 0, []]]
        self._pending = None
        self._active = None
        self._announced = False
        self.running = True
        self._event('accepted')
        return {'accepted': True, 'run_id': run_id}

    def step(self):
        if not self.running:
            return
        if len(self._events) >= 114:
            self._terminate('failed', 'event backpressure')
            return
        if self.clock.ticks_diff(self.clock.ticks_ms(), self._started) >= 60000:
            self._terminate('failed', 'deadline')
            return
        try:
            if not self._announced:
                self._event('started')
                self._announced = True
            self._advance()
        except Exception as exc:
            self._terminate('failed', str(exc)[:160])

    def _advance(self):
        if self._pending is not None:
            block, path, started = self._pending
            done = (self._eval(block['params']['cond']) if block['type'] == 'wait_until' else
                    self.clock.ticks_diff(self.clock.ticks_ms(), started) >= int(block['params']['duration'] * 1000))
            if done:
                self._pending = None
                self._active = None
                self._event('completed', path, block['type'])
            return
        if not self._stack:
            self.running = False
            self._event('completed')
            return
        frame = self._stack[-1]
        if isinstance(frame, dict):
            block, path = frame['block'], frame['path']
            self._active = (path, block['type'])
            if frame['left'] == 0:
                self._stack.pop()
                self._event('completed', path, block['type'])
                self._active = None
            elif frame['count'] >= 50:
                self._terminate('failed', 'loop limit')
            else:
                frame['count'] += 1
                if frame['left'] > 0:
                    frame['left'] -= 1
                body = 'then' if block['type'] == 'if_predicate' else 'do'
                self._stack.append([block['params'][body], 0, path + [body]])
            return
        if frame[1] >= len(frame[0]):
            self._stack.pop()
            return
        block = frame[0][frame[1]]
        path = frame[2] + [frame[1]]
        frame[1] += 1
        kind = block['type']
        self._active = (path, kind)
        self._event('started', path, kind)
        p = block['params']
        if kind in ('wait', 'wait_until'):
            self._pending = (block, path, self.clock.ticks_ms())
        elif kind == 'stop':
            self.stop('stop block')
        elif kind in ('repeat', 'repeat_forever', 'if_predicate'):
            left = (-1 if kind == 'repeat_forever' else
                    int(bool(self._eval(p['cond']))) if kind == 'if_predicate' else p['times'])
            self._stack.append({'block': block, 'path': path, 'left': left, 'count': 0})
        else:
            if kind == 'set_variable':
                self._variables[p['name']] = self._eval(p['value'])
            elif kind == 'change_variable':
                value = self._number(self._variables.get(p['name'], 0)) + self._number(self._eval(p['by']))
                self._variables[p['name']] = self._number(value)
            elif kind == 'math_operation':
                self._variables[p['result']] = self._eval(p['expr'])
            else:
                self.io.execute(kind, dict(p))
            self._event('completed', path, kind)
            self._active = None
