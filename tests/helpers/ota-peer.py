"""Software integration peer: actual OTA engine + diagnostic source, no hardware.
JSON lines control loop represents restarts as new engines over a temp directory.
It is NOT a CyberPi runtime, MQTT implementation, or physical reset test.
"""
import sys,os,json,tempfile
sys.path.insert(0,os.path.join(os.path.dirname(__file__),'../../firmware'))
from ota_core import OtaEngine
from ota_loader import load_application,AppContext
root=tempfile.TemporaryDirectory()
def start():
    global engine
    engine=OtaEngine(root.name,'integration',os.urandom(16).hex())
    selected=engine.boot_selection()
    if selected:
        try:
            app=load_application(root.name,selected)
            context=AppContext('integration',engine.boot,selected['sha256'],'1',1,True)
            app['ota_init'](context);app['ota_step'](context);engine.mark_healthy()
        except Exception:
            engine=OtaEngine(root.name,'integration',os.urandom(16).hex())
            previous=engine.boot_selection()
            if previous:
                app=load_application(root.name,previous)
                context=AppContext('integration',engine.boot,previous['sha256'],'1',1,True)
                app['ota_init'](context);app['ota_step'](context);engine.mark_healthy()
    return engine.hello()
start()
for line in sys.stdin:
    command=json.loads(line)
    if command.get('hello'):
        output={'hello':engine.hello()}
    else:
        response=engine.handle(command['request'])
        body=json.loads(response['body'])
        output={'response':response}
        if body.get('ok') and body['result'].get('restart'):output['hello']=start()
    print(json.dumps(output),flush=True)
root.cleanup()
