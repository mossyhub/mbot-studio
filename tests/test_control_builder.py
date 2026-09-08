import ast,hashlib,io,json,subprocess,sys,tokenize

import pytest
import runpy
import warnings
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]


def test_staged_sections_preserve_exact_source_and_whole_statements():
    builder=runpy.run_path(str(ROOT/'tools/build-robot-control.py'))
    source=('# café\r\nvalue = """literal\r\n  # untouched\r\n"""\r\n'
            'alias = value; other = alias\r\n'
            '@staticmethod\r\ndef decorated():\r\n    return other\r\n'
            'class Large:\r\n    text = '+repr('x'*6500)+'\r\n')
    sections=builder['split_source'](source, target=80)
    assert ''.join(sections)==source
    assert len(sections)>1
    assert [ast.dump(n) for s in sections for n in ast.parse(s).body]==[ast.dump(n) for n in ast.parse(source).body]
    assert any(len(s)>6500 and 'class Large:' in s for s in sections)


def staged_fixture():
    from types import SimpleNamespace
    builder=runpy.run_path(str(ROOT/'tools/build-robot-control.py'))
    source=('events.append("first")\nvalue = 42\n'
            'events.append(value)\n'
            'def ota_init(ctx):\n    events.append(("init", ctx))\n'
            'def ota_step(ctx):\n    events.append("target")\n')
    ns={}
    exec(builder['staged_source'](source, target=55),ns)
    ns['_stage_ns']['events']=[]
    ctx=SimpleNamespace(device='robot',boot='boot',sha256='a'*64,protocol=1,disarmed=True)
    return ns,ctx


def test_staged_one_section_per_tick_then_separate_init_and_direct_handoff():
    ns,ctx=staged_fixture()
    events=ns['_stage_ns']['events']
    wrapper=ns['ota_step']
    assert not events
    ns['ota_init'](ctx)
    assert not events
    expected={'events':[]}
    for section in ns['_stage_sections']:
        exec(section,expected)
        ns['ota_step'](ctx)
        assert events==expected['events']
        assert ns['ota_step'] is wrapper
        assert not any(isinstance(e,tuple) for e in events)
    target=ns['_stage_ns']['ota_step']
    ns['ota_step'](ctx)
    assert events==['first',42,('init',ctx)]
    assert ns['ota_step'] is target
    ns['ota_step'](ctx)
    assert events[-1]=='target'


@pytest.mark.parametrize('field,value',[('device','other'),('boot','other'),('sha256','b'*64),('protocol',2),('disarmed',False)])
@pytest.mark.parametrize('stage',['first','middle','init'])
def test_staged_context_drift_rejected_before_every_stage(field,value,stage):
    ns,ctx=staged_fixture()
    ns['ota_init'](ctx)
    count={'first':0,'middle':1,'init':len(ns['_stage_sections'])}[stage]
    for _ in range(count):ns['ota_step'](ctx)
    before=list(ns['_stage_ns']['events'])
    setattr(ctx,field,value)
    with pytest.raises(ValueError,match='context'):
        ns['ota_step'](ctx)
    assert ns['_stage_ns']['events']==before


def test_staged_rejects_step_before_init_and_unsafe_init():
    ns,ctx=staged_fixture()
    with pytest.raises(ValueError,match='context'):ns['ota_step'](ctx)
    ctx.disarmed=False
    with pytest.raises(ValueError,match='context'):ns['ota_init'](ctx)


@pytest.mark.parametrize('failure',['compile','execute','init'])
def test_staged_errors_print_bounded_traceback_and_propagate(failure,capsys):
    ns,ctx=staged_fixture()
    ns['ota_init'](ctx)
    if failure=='compile':ns['_stage_sections'][0]='def broken(\n'
    elif failure=='execute':ns['_stage_sections'][0]='raise RuntimeError("x"*10000)\n'
    else:
        for _ in ns['_stage_sections']:ns['ota_step'](ctx)
        def broken(ctx):raise RuntimeError('x'*10000)
        ns['_stage_ns']['ota_init']=broken
    wrapper=ns['ota_step']
    index=ns['_stage_index']
    with pytest.raises((SyntaxError,RuntimeError)):ns['ota_step'](ctx)
    output=capsys.readouterr().out
    assert 'Traceback' in output
    assert len(output)<1000
    assert ns['ota_step'] is wrapper
    assert ns['_stage_index']==index


@pytest.mark.parametrize('mode', [None,'--compact','--dense'])
def test_staged_cli_digest_exclusive_create_and_exact_embedded_source(tmp_path,mode):
    builder=runpy.run_path(str(ROOT/'tools/build-robot-control.py'))
    cfg=tmp_path/'operator.json'
    cfg.write_text(json.dumps({'brokerUrl':'mqtt://192.0.2.1:1883','prefix':'fixture','device':'fixture-device'}))
    plain=tmp_path/'plain.py'
    staged=tmp_path/'staged.py'
    cmd=[sys.executable,str(ROOT/'tools/build-robot-control.py'),'--config',str(cfg)]
    if mode:cmd.append(mode)
    normal=subprocess.run(cmd+['--out',str(plain)],capture_output=True,text=True)
    assert normal.returncode==0,normal.stderr
    run=subprocess.run(cmd+['--out',str(staged),'--staged'],capture_output=True,text=True)
    assert run.returncode==0,run.stderr
    data=staged.read_bytes()
    report=json.loads(run.stdout)
    assert report['sha256']==hashlib.sha256(data).hexdigest()
    assert report['size']==len(data) and report['uploaded'] is False
    assert report['staged'] is True
    assert 'status revision + SHA' in report['confirmationRequired']
    assert report['loaderHealthyMeansTargetReady'] is False
    ns={};exec(data,ns)
    assert ns['OTA_APP_PROTOCOL']==1 and callable(ns['ota_init']) and callable(ns['ota_step'])
    assert ''.join(ns['_stage_sections']).encode()==plain.read_bytes()
    assert ns['_stage_sections']==builder['split_source'](plain.read_bytes().decode())
    assert ns['_stage_ns']=={'__name__':'robot_control'}
    assert not any(isinstance(n,(ast.Import,ast.ImportFrom)) for n in ast.walk(ast.parse(data)))
    refused=subprocess.run(cmd+['--out',str(staged),'--staged'],capture_output=True,text=True)
    assert refused.returncode!=0 and 'existing files are not overwritten' in refused.stderr
    assert staged.read_bytes()==data


def test_dense_preserves_literal_tokens_and_comparisons():
    dense_source=runpy.run_path(str(ROOT/'tools/build-robot-control.py'))['dense_source']
    source=(
        '# removed\n'
        'def example(a):\n'
        '    """literal # text\n\n    unchanged indentation\n    """\n'
        '    raw = r"a\\b"\n'
        '    data = br"bytes\\n"\n'
        '    text = u"café" " adjacent"\n'
        '    formatted = f"value {a!r}"\n'
        '    attr = 1 .real\n'
        '    value = -50 if a is not None and a not in [1, -2] else -1\n'
        '    return (value < -1 or 1 in [1], a - -2, a / 2)\n'
    )
    with warnings.catch_warnings():
        warnings.simplefilter('error',SyntaxWarning)
        dense=dense_source(source)
        compile(dense,'fixture','exec')
    assert ast.dump(ast.parse(source))==ast.dump(ast.parse(dense))
    literals=lambda s:[t.string for t in tokenize.generate_tokens(io.StringIO(s).readline) if t.type==tokenize.STRING]
    assert literals(dense)==literals(source)
    assert 'f"value {a!r}"' in dense
    assert '\n  raw=' in dense
    assert '# removed' not in dense
    assert '  ' not in dense.split('text=',1)[1].split('\n',1)[0]


@pytest.mark.parametrize('source',[
    'if True:\n x = 1\n if x:\n  x = - -2\n',
    'value = 1 + \\\n    2\n',
    'value = (\n    1, # comment\n\n    -2,\n)\n',
    'if True:\n\tif True:\n\t\tx = b"bytes"\n',
])
def test_dense_preserves_continuations_and_small_indents(source):
    dense_source=runpy.run_path(str(ROOT/'tools/build-robot-control.py'))['dense_source']
    dense=dense_source(source)
    assert ast.dump(ast.parse(source))==ast.dump(ast.parse(dense))
    compile(dense,'fixture','exec')


def test_dense_rejects_compile_invalid_ast():
    dense_source=runpy.run_path(str(ROOT/'tools/build-robot-control.py'))['dense_source']
    with pytest.raises(SyntaxError):
        dense_source('return 1\n')


def test_dense_ast_change_writes_no_output(tmp_path,monkeypatch,capsys):
    builder=runpy.run_path(str(ROOT/'tools/build-robot-control.py'))
    cfg=tmp_path/'operator.json'
    cfg.write_text(json.dumps({'brokerUrl':'mqtt://192.0.2.1:1883','prefix':'fixture','device':'fixture-device'}))
    out=tmp_path/'app.py'
    original=tokenize.generate_tokens
    def corrupt(readline):
        for token in original(readline):
            yield token._replace(string='1884') if token.type==tokenize.NUMBER and token.string=='1883' else token
    monkeypatch.setattr(tokenize,'generate_tokens',corrupt)
    monkeypatch.setattr(sys,'argv',['builder','--config',str(cfg),'--out',str(out),'--dense'])
    with pytest.raises(ValueError,match='AST'):
        builder['dense_source']('port = 1883\n')
    assert builder['main']()==1
    assert not out.exists()
    assert 'no output written' in capsys.readouterr().err

@pytest.mark.parametrize('compact', [False, True, 'dense'])
def test_control_builder_uses_exact_source_and_loader_contract(tmp_path, compact):
    cfg=tmp_path/'operator.json';cfg.write_text(json.dumps({'brokerUrl':'mqtt://192.0.2.1:1883','prefix':'fixture','device':'fixture-device'}))
    out=tmp_path/'control.py'
    cmd=[sys.executable,str(ROOT/'tools/build-robot-control.py'),'--config',str(cfg),'--out',str(out)]
    if compact:cmd.append('--dense' if compact=='dense' else '--compact')
    run=subprocess.run(cmd,capture_output=True,text=True)
    assert run.returncode==0,run.stderr
    data=out.read_bytes();report=json.loads(run.stdout)
    assert hashlib.sha256(data).hexdigest()==report['sha256']
    source=(ROOT/'firmware/robot_control.py').read_bytes()
    if compact:
        assert [ast.dump(node) for node in ast.parse(data).body[4:]]==[ast.dump(node) for node in ast.parse(source).body]
        assert not any(t.type==tokenize.COMMENT for t in tokenize.generate_tokens(io.StringIO(data.decode('utf-8')).readline))
    else:
        assert data.endswith(source)
    ns={};exec(compile(data,str(out),'exec'),ns)
    assert ns['OTA_APP_PROTOCOL']==1
    assert ns['ROBOT_DEVICE']=='fixture-device'
    assert callable(ns['ota_init']) and callable(ns['ota_step'])
    assert ns['_app'] is None
    refused=subprocess.run(cmd,capture_output=True,text=True)
    assert refused.returncode!=0
    assert 'existing files are not overwritten' in refused.stderr
    assert out.read_bytes()==data

@pytest.mark.parametrize('compact', [False, True])
def test_control_builder_compaction_preserves_strings_and_ast(tmp_path, compact):
    # Exercise the real CLI with a small source fixture, without hardware imports.
    tools=tmp_path/'tools';tools.mkdir()
    firmware=tmp_path/'firmware';firmware.mkdir()
    builder=tools/'build-robot-control.py'
    builder.write_bytes((ROOT/'tools/build-robot-control.py').read_bytes())
    source=(
        '# module comment\n\n'
        '\"\"\"Module # docstring.\n\n   \nEnd.\"\"\" # trailing comment\n'
        '\nvalue = "# literal café"  # remove only this comment\n'
        'text = """# not a comment\n\n  \nlast line\n"""\n'
        '\nclass Example:\n'
        '    """Class # docstring.\n\n    Keep blank line.\n    """\n'
        '\n    def method(self):\n'
        '        """Method # docstring."""\n'
        '        # body comment\n'
        '        return "escaped \\\"# literal" # final comment'
    )
    expected=(
        '\"\"\"Module # docstring.\n\n   \nEnd.\"\"\" \n'
        'value = "# literal café"  \n'
        'text = """# not a comment\n\n  \nlast line\n"""\n'
        'class Example:\n'
        '    """Class # docstring.\n\n    Keep blank line.\n    """\n'
        '    def method(self):\n'
        '        """Method # docstring."""\n'
        '        return "escaped \\\"# literal" \n'
    )
    (firmware/'robot_control.py').write_text(source,encoding='utf-8')
    cfg=tmp_path/'operator.json'
    cfg.write_text(json.dumps({'brokerUrl':'mqtt://192.0.2.1:1883','prefix':'fixture','device':'fixture-device'}))
    out=tmp_path/'control.py'
    cmd=[sys.executable,str(builder),'--config',str(cfg),'--out',str(out)]
    if compact:cmd.append('--compact')
    run=subprocess.run(cmd,capture_output=True,text=True)
    assert run.returncode==0,run.stderr
    header=("ROBOT_MQTT_BROKER = '192.0.2.1'\nROBOT_MQTT_PORT = 1883\n"
            "ROBOT_TOPIC_PREFIX = 'fixture'\nROBOT_DEVICE = 'fixture-device'\n")
    data=out.read_bytes()
    assert data==(header+(expected if compact else source)).encode('utf-8')
    assert ast.dump(ast.parse(data))==ast.dump(ast.parse(header+source))
    compile(data,str(out),'exec')
    if compact:
        assert not any(t.type==tokenize.COMMENT for t in tokenize.generate_tokens(io.StringIO(data.decode('utf-8')).readline))
    report=json.loads(run.stdout)
    assert report['size']==len(data)
    assert report['sha256']==hashlib.sha256(data).hexdigest()
    assert report['uploaded'] is False


@pytest.mark.parametrize('compact', [False, True])
@pytest.mark.parametrize('config', [
    '{"brokerUrl":"SENTINEL_SECRET"',
    json.dumps({'brokerUrl':'mqtt://operator:SENTINEL_SECRET@192.0.2.1:1883','prefix':'fixture','device':'fixture-device'}),
])
def test_control_builder_does_not_leak_operator_secrets(tmp_path, compact, config):
    cfg=tmp_path/'operator.json';cfg.write_text(config)
    out=tmp_path/'app.py'
    cmd=[sys.executable,str(ROOT/'tools/build-robot-control.py'),'--config',str(cfg),'--out',str(out)]
    if compact:cmd.append('--compact')
    run=subprocess.run(cmd,capture_output=True,text=True)
    assert run.returncode!=0
    assert 'SENTINEL' not in run.stdout+run.stderr
    assert not out.exists()
