import hashlib,json,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def test_control_builder_uses_exact_source_and_loader_contract(tmp_path):
    cfg=tmp_path/'operator.json';cfg.write_text(json.dumps({'brokerUrl':'mqtt://192.0.2.1:1883','prefix':'fixture','device':'fixture-device'}))
    out=tmp_path/'control.py'
    cmd=[sys.executable,str(ROOT/'tools/build-robot-control.py'),'--config',str(cfg),'--out',str(out)]
    run=subprocess.run(cmd,capture_output=True,text=True)
    assert run.returncode==0,run.stderr
    data=out.read_bytes();report=json.loads(run.stdout)
    assert hashlib.sha256(data).hexdigest()==report['sha256']
    assert data.endswith((ROOT/'firmware/robot_control.py').read_bytes())
    ns={};exec(compile(data,str(out),'exec'),ns)
    assert ns['OTA_APP_PROTOCOL']==1
    assert ns['ROBOT_DEVICE']=='fixture-device'
    assert callable(ns['ota_init']) and callable(ns['ota_step'])
    assert ns['_app'] is None
    assert subprocess.run(cmd,capture_output=True).returncode!=0

def test_control_builder_does_not_leak_operator_secrets(tmp_path):
    cfg=tmp_path/'operator.json';cfg.write_text('{"brokerUrl":"SENTINEL_SECRET"')
    run=subprocess.run([sys.executable,str(ROOT/'tools/build-robot-control.py'),'--config',str(cfg),'--out',str(tmp_path/'app.py')],capture_output=True,text=True)
    assert run.returncode!=0
    assert 'SENTINEL' not in run.stdout+run.stderr
