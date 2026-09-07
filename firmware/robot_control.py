"""Small cooperative OTA application. No hardware effects at import."""
try:
  import ujson as json
except ImportError:
  import json

OTA_APP_PROTOCOL=1
OTA_BUILD_ID='mbot-motor-control-v1'
CAPS=('move_forward','move_backward','dc_motor','servo','wait',
    'stop','display_text','set_led','read_sensors','status')
COLORS=('red','green','blue','yellow','cyan','purple','white','orange','off')

def number(p,key,default,low,high):
  v=p.get(key,default)
  if type(v) not in (int,float) or not low<=v<=high:
    raise ValueError(key)
  p[key]=v

def validate(blocks):
  if type(blocks) is not list or not 1<=len(blocks)<=32:
    raise ValueError('blocks')
  out=[]
  for b in blocks:
    if type(b) is not dict:
      raise ValueError('block')
    p=dict(b)
    nested=p.pop('params',{})
    if type(nested) is not dict or ('params' in b and any(k not in ('type','params','_id','run_id') for k in b)):
      raise ValueError('params')
    if any(k in nested for k in ('type','params','run_id')):
      raise ValueError('params')
    p.update(nested)
    p.pop('_id',None)
    t=p.get('type')
    allowed=('type','run_id')
    if t in ('move_forward','move_backward','dc_motor'):
      number(p,'speed',20,-50 if t=='dc_motor' else 0,50)
      number(p,'duration',1,0,5)
      allowed += ('speed','duration')
      if t=='dc_motor':
        if p.get('port') not in ('M1','M2','M3','M4'):
          raise ValueError('port')
        allowed += ('port',)
    elif t=='servo':
      if p.get('port') not in ('S1','S2','S3','S4'):
        raise ValueError('port')
      number(p,'angle',90,0,180)
      number(p,'speed',0,0,0)
      allowed += ('port','angle','speed')
    elif t=='wait':
      number(p,'duration',1,0,60)
      allowed += ('duration',)
    elif t=='display_text':
      if type(p.get('text')) is not str or len(p['text'])>128:
        raise ValueError('text')
      number(p,'size',16,8,32)
      allowed += ('text','size')
    elif t=='set_led':
      if p.get('color') not in COLORS:
        raise ValueError('color')
      allowed += ('color',)
    elif t not in ('stop','status','read_sensors'):
      raise ValueError('unsupported')
    if any(k not in allowed for k in p):
      raise ValueError('parameter')
    out.append(p)
  return out

class Control:
  def __init__(self,ctx,a):
    self.ctx,self.io,self.clock=ctx,a['io'],a['clock']
    self.factory=a['mqtt_factory']
    self.network_ready=a.get('network_ready',lambda:True)
    self.prefix=ROBOT_TOPIC_PREFIX+'/robot/'
    self.client=self.pending=self.blocks=self.timer=None
    self.retry=self.reported=None
    self.lost=False
    self.emergency=False
    self.stop_pending=None
    self.run_id,self.index=None,0
    self.action=None
    self.sensor_index=None
    self.outgoing=[]
    self.io.stop()

  def put(self,topic,payload):
    if topic==(self.prefix+'emergency').encode():
      self.emergency=True
      return
    if self.emergency:return
    # Only validated standalone command stops bypass the bounded mailbox.
    if topic==(self.prefix+'command').encode() and len(payload)<=8192:
      try:
        request=json.loads(payload)
        if type(request) is dict and 'program' not in request and 'blocks' not in request:
          run_id=request.get('run_id')
          command=request.get('command',request)
          if type(command) is dict and command.get('type')=='stop':
            command=dict(command)
            command.pop('timestamp',None)
            if run_id is not None and (type(run_id) is not str or len(run_id)>128):
              raise ValueError('run_id')
            validate([command])
            self.stop_pending=payload
            return
      except Exception:pass
    if self.pending is None and self.stop_pending is None:
      if topic in ((self.prefix+'command').encode(),(self.prefix+'program').encode()):
        self.pending=payload if len(payload)<=8192 else b'null'

  def publish(self,suffix,data):
    if len(self.outgoing)>=32:raise OSError('outgoing_full')
    self.outgoing.append((suffix,data))

  def event(self,event,kind='program',error=None):
    d={'type':kind,'event':event,'run_id':self.run_id,'boot':self.ctx.boot,'build':OTA_BUILD_ID,'block_path':[self.index] if kind=='block' else [],'details':{}}
    if kind=='block':d['path']=[self.index]
    if error is not None:
      d['error']=str(error)[:128]
      d['details']={'error':d['error']}
    self.publish('execution',d)

  def status(self):
    self.publish('status',{'status':'running' if self.blocks else 'ready',
      'application':'cooperative-v1','capabilities':list(CAPS),
      'motion_enabled':True,'armed':self.client is not None,
      'self_managed_homing':True,'device':self.ctx.device,
      'boot':self.ctx.boot,'sha256':self.ctx.sha256,'build':OTA_BUILD_ID})
    self.reported=self.clock.ticks_ms()

  def cancel(self):
    self.pending=self.blocks=self.timer=None
    self.stop_pending=None
    self.action=('stop',None)

  def complete(self):
    self.event('completed','block')
    self.index += 1
    if self.index==len(self.blocks):
      self.blocks=None
      self.event('completed')
      self.status()

  def step(self):
    now=self.clock.ticks_ms()
    network=True
    try:
      if self.client is None:
        if not self.network_ready():return
        if self.retry is not None and self.clock.ticks_diff(now,self.retry)<2000:
          return
        self.client=self.factory((ROBOT_DEVICE+'-control').encode(),ROBOT_MQTT_BROKER,
          port=globals().get('ROBOT_MQTT_PORT',1883),keepalive=30)
        self.client.set_callback(self.put)
        self.client.connect(clean_session=True)
        for name in ('command','program','emergency'):
          self.client.sock.settimeout(1)
          self.client.subscribe((self.prefix+name).encode(),qos=0)
        self.status()
        if self.lost:
          self.event('failed',error='network')
          self.lost=False
      self.client.check_msg()
      network=False
      if self.reported is None or self.clock.ticks_diff(now,self.reported)>=5000:
        self.status()
      if self.emergency:
        self.emergency=False
        self.cancel()
        self.event('canceled')
        self.status()
        return
      if self.stop_pending is not None:
        payload=self.stop_pending
        if self.blocks is not None:self.event('canceled')
        self.cancel()
        self.pending=payload
      if self.timer is not None:
        start,duration,motor=self.timer
        if self.clock.ticks_diff(now,start)>=duration:
          if motor:self.action=('stop',None)
          self.timer=None
          self.complete()
        return
      if self.blocks is None and self.pending is not None:
        payload,self.pending=self.pending,None
        self.run_id=None
        request=json.loads(payload)
        if type(request) is not dict:raise ValueError('request')
        self.run_id=request.get('run_id')
        if self.run_id is not None and (type(self.run_id) is not str or len(self.run_id)>128):
          self.run_id=None
          raise ValueError('run_id')
        if 'program' in request:
          plan=request['program']
        elif 'blocks' in request:
          plan=request['blocks']
        else:
          command=request.get('command',request)
          if type(command) is not dict:raise ValueError('command')
          command=dict(command)
          command.pop('timestamp',None)
          plan=[command]
        self.blocks=validate(plan)
        self.index=0
        self.event('started')
      if self.blocks is not None:
        b=self.blocks[self.index]
        t=b['type']
        self.event('started','block')
        motor=t in ('move_forward','move_backward','dc_motor')
        duration=b.get('duration',0)
        if t=='stop':self.action=('stop',None)
        elif t=='status':self.status()
        elif t=='read_sensors':self.action=('sensors',None)
        elif t!='wait' and (not motor or duration>0):self.action=('execute',b)
        if duration>0:
          self.timer=(self.clock.ticks_ms(),int(duration*1000),motor)
        else:self.complete()
      elif self.reported is None or self.clock.ticks_diff(now,self.reported)>=5000:
        self.status()
    except OSError:
      self.disconnect(now)
    except Exception as e:
      if network:
        self.disconnect(now)
        return
      try:
        self.cancel()
        self.event('failed','block',e)
        self.event('failed',error=e)
      except Exception:
        self.disconnect(now)

  def disconnect(self,now):
    self.lost=self.lost or self.run_id is not None
    client,self.client=self.client,None
    self.retry=now
    self.emergency=False
    # Pending cancellations own their original identity across reconnects.
    self.outgoing=[item for item in self.outgoing
      if item[1].get('type')=='program' and item[1].get('event')=='canceled']
    try:
      self.cancel()
    finally:
      if client:
        try:client.sock.close()
        except Exception:pass


def native():
  import time
  import cyberpi
  import mbot2
  import mbuild
  try:
    from simple_mqtt import MQTTClient
  except ImportError:
    from umqtt.simple import MQTTClient

  class IO:
    def stop(self):
      try:mbot2.EM_stop()
      finally:mbot2.starter_shield.dc_motor_stop()
    def execute(self,b):
      t=b['type']
      if t=='move_forward':mbot2.forward(b['speed'])
      elif t=='move_backward':mbot2.backward(b['speed'])
      elif t=='dc_motor':mbot2.starter_shield.dc_motor_set_power(int(b['port'][1]),b['speed'])
      elif t=='servo':mbot2.starter_shield.servo_set_angle(int(b['port'][1]),b['angle'])
      elif t=='display_text':cyberpi.display.show_label(b['text'],b['size'],'center',index=0)
      elif b['color']=='off':cyberpi.led.off()
      else:cyberpi.led.show(' '.join([b['color']]*5))
    def sensors(self,index=0):
      # One vendor call per OTA tick, directly on this shallow stack.
      # Snapshots contain only this scan's readings, never fallback values.
      if index==0:self.sensor_data={'errors':{}}
      keys=('distance','battery','loudness','brightness','yaw','pitch','roll',
        'color_L1','color_L2','color_R1','color_R2','line_status')
      key=keys[index]
      try:
        if index==0:value=mbuild.ultrasonic2.get()
        elif index==1:value=cyberpi.get_battery()
        elif index==2:value=cyberpi.get_loudness()
        elif index==3:value=cyberpi.get_brightness()
        elif index==4:value=cyberpi.get_yaw()
        elif index==5:value=cyberpi.get_pitch()
        elif index==6:value=cyberpi.get_roll()
        elif index<11:value=mbuild.quad_rgb_sensor.get_color(('L1','L2','R1','R2')[index-7])
        else:value=mbuild.dual_rgb_sensor.get_line_sta()
        self.sensor_data[key]=value
      except Exception as error:
        self.sensor_data['errors'][key]=str(error)[:128]
      if index==len(keys)-1:
        # Names only: presence is not proof of a safe/nonblocking signature.
        # The legacy line API above is known; quad get_line_sta is discovery only.
        for field,module,attribute,allowed in (
          ('audio_methods',cyberpi,'audio',('play','play_until','play_tone',
            'play_tone_until','play_melody','play_music','play_music_until','stop','is_playing')),
          ('quad_methods',mbuild,'quad_rgb_sensor',('get_color','get_line_sta','get_offset_track','is_color'))):
          try:
            names=dir(getattr(module,attribute))
            self.sensor_data[field]=[name for name in allowed if name in names]
          except Exception as error:
            self.sensor_data['errors'][field]=str(error)[:128]
      data=dict(self.sensor_data)
      data['errors']=dict(self.sensor_data['errors'])
      data['sampling']=index<len(keys)-1
      return data
  return {'clock':time,'io':IO(),'mqtt_factory':MQTTClient,'network_ready':cyberpi.wifi.is_connect}

_app=None

def ota_init(context,adapters=None):
  global _app
  if context.protocol!=1 or context.disarmed is not True or context.device!=ROBOT_DEVICE:
    raise ValueError('context')
  _app=Control(context,native() if adapters is None else adapters)

def ota_step(context):
  if _app is None:raise ValueError('uninitialized')
  c=_app.ctx
  if (c.device,c.boot,c.sha256)!=(context.device,context.boot,context.sha256):
    _app.sensor_index=None
    _app.cancel()
    _app.action=None
    _app.io.stop()
    raise ValueError('identity')
  try:
    _app.step()
    action,_app.action=_app.action,None
    if _app.client is None or (action is not None and action[0]!='sensors'):
      _app.sensor_index=None
    if action is None and _app.sensor_index is not None:
      action=('sensors',None)
    if action is not None:
      try:
        if action[0]=='stop':_app.io.stop()
        elif action[0]=='sensors':
          if _app.sensor_index is None:_app.sensor_index=0
          data=_app.io.sensors(_app.sensor_index)
          _app.publish('sensors',data)
          _app.sensor_index=_app.sensor_index+1 if data.get('sampling') else None
        else:
          _app.io.execute(action[1])
          if _app.timer is not None:
            _,duration,motor=_app.timer
            _app.timer=(_app.clock.ticks_ms(),duration,motor)
      except Exception as error:
        _app.sensor_index=None
        # Drop speculative completions, not the preempted run's terminal event.
        _app.outgoing=[item for item in _app.outgoing
          if item[1].get('type')=='program' and item[1].get('event')=='canceled']
        _app.cancel()
        _app.action=None
        _app.io.stop()
        _app.event('failed',error=error)
    for _ in range(8):
      if _app.client is None or not _app.outgoing:break
      suffix,data=_app.outgoing[0]
      try:
        _app.client.sock.settimeout(1)
        _app.client.publish((_app.prefix+suffix).encode(),json.dumps(data).encode(),retain=False,qos=0)
        _app.outgoing.pop(0)
      except Exception:
        if _app.run_id is None:_app.run_id=data.get('run_id')
        _app.disconnect(_app.clock.ticks_ms())
        _app.action=None
        _app.io.stop()
        break
    if _app.client is None:_app.sensor_index=None
    # Retain correlation through final native IO and all queued publications.
    if _app.blocks is None and not _app.outgoing and not _app.lost:
      _app.run_id=None
  except Exception as error:
    print('MOTOR_APP_ERROR:',repr(error))
    try:
      import sys
      sys.print_exception(error)
    except Exception:pass
    raise
