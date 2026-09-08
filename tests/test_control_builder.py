import ast,hashlib,io,json,subprocess,sys,tokenize

import pytest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
@pytest.mark.parametrize('compact', [False, True])
def test_control_builder_uses_exact_source_and_loader_contract(tmp_path, compact):
    cfg=tmp_path/'operator.json';cfg.write_text(json.dumps({'brokerUrl':'mqtt://192.0.2.1:1883','prefix':'fixture','device':'fixture-device'}))
    out=tmp_path/'control.py'
    cmd=[sys.executable,str(ROOT/'tools/build-robot-control.py'),'--config',str(cfg),'--out',str(out)]
    if compact:cmd.append('--compact')
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
