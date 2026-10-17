"""Small cooperative OTA application. No hardware effects at import."""
try:
  import ujson as json
except ImportError:
  import json
try:
  import ubinascii as binascii
except ImportError:
  import binascii

OTA_APP_PROTOCOL=1
OTA_BUILD_ID='mbot-av-control-v1'
DIAGNOSTIC_REVISION='native-boundary-v1'
CAPS=('move_forward','move_backward','dc_motor','servo','wait',
    'stop','display_text','set_led','read_sensors','status','turn_left','turn_right',
    'play_tone','play_sound','set_volume','stop_sound','display_animation','drive_hold',
    'drive_tap','motor_power_100','turn_angle_360','program_indexed_v1')
COLORS=('red','green','blue','yellow','cyan','purple','white','orange','off')

def asset_id(value):
  return type(value) is str and len(value)==64 and all(c in '0123456789abcdef' for c in value)

def number(p,key,default,low,high):
  v=p.get(key,default)
  if type(v) not in (int,float) or not low<=v<=high:
    raise ValueError(key)
  p[key]=v

def validate(blocks):
  if type(blocks) is not list or not 1<=len(blocks)<=32:
    raise ValueError('blocks')
  out=[]
  animation_duration=0
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
      # Forward/backward use vendor RPM; DC motor uses signed percent power.
      number(p,'speed',20,-100 if t=='dc_motor' else 0,100)
      number(p,'duration',1,0,5)
      allowed += ('speed','duration')
      if t=='dc_motor':
        if p.get('port') not in ('M1','M2','M3','M4'):
          raise ValueError('port')
        allowed += ('port',)
    elif t in ('turn_left','turn_right'):
      # One native turn may block until return; never split or repeat it.
      number(p,'angle',0,0,360)
      allowed += ('angle',)
    elif t=='servo':
      if p.get('port') not in ('S1','S2','S3','S4'):
        raise ValueError('port')
      number(p,'angle',90,0,180)
      number(p,'speed',0,0,0)
      allowed += ('port','angle','speed')
    elif t=='play_tone':
      number(p,'frequency',440,100,2000)
      number(p,'duration',0.5,0,2)
      allowed += ('frequency','duration')
    elif t=='play_recording':
      if not asset_id(p.get('recording')):raise ValueError('recording')
      number(p,'duration',None,0.001,3)
      allowed += ('recording','duration')
    elif t=='play_sound':
      if p.get('sound') not in ('hello','beeps','laugh','score'):
        raise ValueError('sound')
      allowed += ('sound',)
    elif t=='set_volume':
      if type(p.get('volume')) is not int or not 0<=p['volume']<=60:
        raise ValueError('volume')
      allowed += ('volume',)
    elif t=='wait':
      number(p,'duration',1,0,60)
      allowed += ('duration',)
    elif t=='display_animation':
      frames=p.get('frames')
      if type(frames) is not list or not 1<=len(frames)<=12:
        raise ValueError('frames')
      if any(type(frame) is not str or len(frame)>128 for frame in frames):
        raise ValueError('frames')
      number(p,'interval',0.5,0.15,2)
      animation_duration += len(frames)*p['interval']
      if animation_duration>12:raise ValueError('animation_duration')
      allowed += ('frames','interval')
    elif t=='display_text':
      if type(p.get('text')) is not str or len(p['text'])>128:
        raise ValueError('text')
      number(p,'size',16,8,32)
      allowed += ('text','size')
    elif t=='set_led':
      if p.get('color') not in COLORS:
        raise ValueError('color')
      allowed += ('color',)
    elif t not in ('stop','status','read_sensors','stop_sound'):
      raise ValueError('unsupported')
    if any(k not in allowed for k in p):
      raise ValueError('parameter')
    if t=='display_animation':
      # Expand during whole-program validation, never during native dispatch.
      for frame in p['frames']:
        out.append({'type':'display_text','text':frame,'size':24})
        out.append({'type':'wait','duration':p['interval']})
    else:out.append(p)
    if len(out)>32:raise ValueError('blocks')
  return out

def validate_indexed(program):
  if (type(program) is not dict or len(program)!=3
      or any(k not in ('format','commands','order') for k in program)
      or program.get('format')!='indexed-v1'):
    raise ValueError('format')
  source=program['commands']
  if type(source) is not list or not 1<=len(source)<=32:
    raise ValueError('commands')
  if any(type(b) is not dict or b.get('type') in ('display_animation','status','read_sensors')
      or any(k in b for k in ('params','_id','run_id')) for b in source):
    raise ValueError('primitive')
  order=program['order']
  if type(order) is not str or not 2<=len(order)<=2048 or len(order)%2:
    raise ValueError('order')
  try:tape=binascii.unhexlify(order)
  except Exception:raise ValueError('order')
  if max(tape)>=len(source):raise ValueError('index')
  commands=validate(source)
  for command in commands:command.pop('run_id',None)
  # Match server compensated admission; never round an over-budget hold down
  # or retain an expanded list of command dictionaries.
  holds=correction=0
  for index in tape:
    value=commands[index].get('duration',0)-correction
    total=holds+value
    correction=(total-holds)-value
    holds=total
    if holds>120:raise ValueError('duration')
  return commands,tape

class Recordings:
  """Pure phase scheduler; only outer ota_step may dispatch filesystem IO."""
  def __init__(self,root='/flash/mbot_voice'):
    self.root=root
    self.assets={}
    self.ids=[]
    self.transfer=None
    self.last=None
    self.ready=False
    self.error=None
    self.error_stage='operation'
    self.job=self.initialize()
    self.request=None
    self.reply_id=''
    self.cleanup=False
    self.temp_dirty=True  # Startup has not yet ruled out orphaned temp files.
    self.at=None
    self.action=self.io_result=self.io_error=None

  def path(self,name):
    return self.root+'/'+name

  def metadata(self,value):
    if (type(value) is not dict or len(value)!=4 or
        any(k not in ('id','sha256','size','duration_ms') for k in value) or
        not asset_id(value.get('id')) or value.get('sha256')!=value['id'] or
        type(value.get('size')) is not int or not 1<=value['size']<=24576 or
        type(value.get('duration_ms')) is not int or not 1<=value['duration_ms']<=3000):
      raise ValueError('metadata')
    return value

  def verify(self,meta,name):
    import hashlib
    digest=hashlib.sha256()
    offset=0
    while offset<meta['size']:
      yield ('read',self.path(name),'rb',offset,min(512,meta['size']-offset))
      data=self.io_result
      if not data:raise ValueError('size')
      digest.update(data)
      offset+=len(data)
    yield ('stat',self.path(name))
    if self.io_result[6]!=meta['size']:raise ValueError('size')
    if binascii.hexlify(digest.digest()).decode()!=meta['sha256']:raise ValueError('sha256')

  def initialize(self):
    try:yield ('mkdir',self.root)
    except OSError:
      yield ('stat',self.root)
      if not self.io_result[0]&0x4000:raise
    yield ('listdir',self.root)
    names=self.io_result
    self.ids=[name[:-4] for name in names if name.endswith('.mp3') and asset_id(name[:-4])]
    if len(self.ids)>8:raise ValueError('quota')
    for name in ('upload.part','metadata.part'):
      if name in names:
        yield ('remove',self.path(name))
    for ident in self.ids:
      try:
        yield ('read',self.path(ident+'.json'),'r',0,513)
        meta=self.metadata(json.loads(self.io_result))
        if meta['id']!=ident:raise ValueError('metadata')
        for action in self.verify(meta,ident+'.mp3'):yield action
        self.assets[ident]=meta
      except (OSError,ValueError):pass
    self.temp_dirty=False
    self.ready=True

  def cancel(self):
    # No disk IO here: invoked from MQTT cancellation paths too.
    self.transfer=self.last=self.request=None
    self.job=None
    self.cleanup=self.cleanup or self.temp_dirty or not self.ready
    self.at=None
    self.action=self.io_result=self.io_error=None

  def clean(self):
    for name in ('upload.part','metadata.part'):
      try:yield ('remove',self.path(name))
      except OSError as error:
        if error.args[0]!=2:raise
    self.temp_dirty=False
    self.cleanup=False

  def operation(self,r):
    op=r['op']
    ident=r.get('id')
    if op=='begin':
      # Already validated at the outer admission boundary.
      meta={k:r[k] for k in ('id','sha256','size','duration_ms')}
      if ident in self.assets and self.assets[ident]!=meta:raise ValueError('metadata_conflict')
      if self.transfer is not None:
        if self.transfer['transfer_id']!=r['transfer_id'] or self.transfer['meta']!=meta:raise ValueError('busy')
        return
      if ident not in self.ids and len(self.ids)>=8:raise ValueError('quota')
      yield ('statvfs',self.root)
      space=self.io_result
      if space[1]*space[4]<262144+meta['size']+2*space[1]:raise ValueError('space')
      self.temp_dirty=True  # Set before create: a failing IO may leave a file.
      yield ('create',self.path('upload.part'))
      self.transfer={'transfer_id':r['transfer_id'],'meta':meta,'offset':0,'last_chunk':None}
      self.last=None
    elif op in ('status','delete'):
      if self.transfer is not None:raise ValueError('busy')
      if op=='status':
        meta=self.assets.get(ident)
        if meta is None:raise ValueError('missing')
        for action in self.verify(meta,ident+'.mp3'):yield action
      else:
        if ident not in self.ids and ident not in self.assets:raise ValueError('missing')
        self.assets.pop(ident,None)
        for extension in ('.json','.mp3'):
          try:yield ('remove',self.path(ident+extension))
          except OSError as error:
            if error.args[0]!=2:raise
        if ident in self.ids:self.ids.remove(ident)
        self.last=None
    elif op=='abort':
      if self.transfer is not None and self.transfer['transfer_id']!=r['transfer_id']:raise ValueError('owner')
      self.transfer=self.last=None
      # IO errors are thrown into this generator on the following tick.
      for name in ('upload.part','metadata.part'):
        try:yield ('remove',self.path(name))
        except OSError as error:
          if error.args[0]!=2:raise
      self.temp_dirty=False
      self.cleanup=False
    elif op=='finish' and self.transfer is None and self.last is not None and self.last['transfer_id']==r['transfer_id']:
      return
    else:
      transfer=self.transfer
      if transfer is None or transfer['transfer_id']!=r['transfer_id']:raise ValueError('owner')
      meta=transfer['meta']
      if op=='chunk':
        data=binascii.unhexlify(r['data'])
        if r['offset']!=transfer['offset']:
          if transfer['last_chunk']==(r['offset'],data):return
          raise ValueError('offset')
        if transfer['offset']+len(data)>meta['size']:raise ValueError('size')
        yield ('write',self.path('upload.part'),'r+b',transfer['offset'],data)
        transfer['offset']+=len(data)
        transfer['last_chunk']=(r['offset'],data)
      elif op=='finish':
        if transfer['offset']!=meta['size']:raise ValueError('size')
        for action in self.verify(meta,'upload.part'):yield action
        yield ('write',self.path('metadata.part'),'w',0,json.dumps(meta))
        # Metadata is the commit marker. Both renames stay in our directory.
        yield ('rename',self.path('upload.part'),self.path(meta['id']+'.mp3'),meta['id'])
        yield ('rename',self.path('metadata.part'),self.path(meta['id']+'.json'))
        self.temp_dirty=False
        self.assets[meta['id']]=meta
        self.last=transfer
        self.transfer=None

  def ack(self,r,error=None):
    transfer=self.transfer or self.last
    ident=r.get('id',transfer['meta']['id'] if transfer else self.reply_id)
    offset=transfer['offset'] if transfer and transfer['transfer_id']==r['transfer_id'] else 0
    if r['op']=='status' and error is None:offset=self.assets[ident]['size']
    if r['op']=='delete':offset=0
    data={'op':r['op'],'transfer_id':r['transfer_id'],'boot':r['boot'],
      'ok':error is None,'offset':offset,'id':ident}
    if error is not None:
      data['error']=str(error)[:64]
      data['error_stage']=self.error_stage[:16]
    return data

  def step(self):
    self.action=None
    if self.cleanup and self.job is None:self.job=self.clean()
    if self.job is None:return None
    error,self.io_error=self.io_error,None
    try:
      if error is not None:self.action=self.job.throw(error)
      else:
        self.error_stage='operation'
        self.action=next(self.job)
    except StopIteration:
      self.job=None
      request,self.request=self.request,None
      if request is not None:return self.ack(request)
      if not self.ready and not self.cleanup and self.error is None:self.job=self.initialize()
    except Exception as error:
      request,self.request=self.request,None
      self.job=None
      if request is None:
        self.error=str(error)[:64]
        return None
      ack=self.ack(request,error)
      if request['op'] in ('begin','chunk','finish') and str(error) not in ('busy','owner','offset','quota','metadata_conflict'):
        self.cancel()
      return ack

  def execute(self,action):
    # Native filesystem entry points must be as shallow as IO.execute: no
    # scheduler/generator frames remain. Exactly one bounded phase per tick.
    import os
    op,path=action[0],action[1]
    if op=='mkdir':return os.mkdir(path)
    if op=='stat':return os.stat(path)
    if op=='statvfs':return os.statvfs(path)
    if op=='listdir':return os.listdir(path)
    if op=='remove':return os.remove(path)
    if op=='rename':
      os.rename(path,action[2])
      # Account the committed data before a Stop can discard the next phase.
      if len(action)>3:
        if action[3] not in self.ids:self.ids.append(action[3])
        self.assets.pop(action[3],None)
      return
    if op=='create':
      with open(path,'wb'):pass
    elif op in ('read','write'):
      with open(path,action[2]) as stream:
        stream.seek(action[3])
        if op=='read':return stream.read(action[4])
        if stream.write(action[4])!=len(action[4]):raise OSError('short_write')
    else:raise ValueError('disk_action')

class AssetProtocol:
  def asset_busy(self):
    store=self.recordings
    return self.asset_pending is not None or (store is not None and (store.transfer is not None or store.request is not None or store.cleanup))

  def expire_asset(self):
    store=self.recordings
    if (store is not None and store.at is not None and
        (store.transfer is not None or store.request is not None or store.cleanup)):
      if self.clock.ticks_diff(self.clock.ticks_ms(),store.at)>=10000:
        self.asset_pending=None
        store.cancel()

class Control(AssetProtocol):
  def __init__(self,ctx,a):
    self.ctx,self.io,self.clock=ctx,a['io'],a['clock']
    self.identity=(ctx.device,ctx.boot,ctx.sha256)
    self.factory=a['mqtt_factory']
    self.network_ready=a.get('network_ready',lambda:True)
    self.prefix=ROBOT_TOPIC_PREFIX+'/robot/'
    self.ota_topic=(ROBOT_TOPIC_PREFIX+'/ota/'+ROBOT_DEVICE+'/request').encode()
    self.client=self.pending=self.blocks=self.timer=None
    self.tape=self.program_started=None
    self.indexed_run=False
    self.retry=self.reported=None
    self.lost=False
    self.emergency=False
    self.stop_pending=None
    self.run_id,self.index=None,0
    self.action=None
    self.native_pending=None
    self.sensor_index=None
    self.outgoing=[]
    self.initial_stop=True
    self.reset_cause={'raw':None,'constants':{}}
    self.battery_snapshot=None
    self.drive=None
    self.drive_at=None
    self.drive_started=False
    self.drive_stopping=None
    # Independent of Program/timer ownership; only successful Stop clears it.
    self.motor_stop_needed=False
    self.asset_pending=None
    self.recordings=Recordings() if getattr(self.io,'recording_available',False) else None

  def put(self,topic,payload):
    # Observe loader requests only to fail closed; never interpret/execute OTA.
    if topic==self.ota_topic:
      self.asset_pending=None
      if self.recordings is not None:self.recordings.cancel()
      recording=(getattr(self.io,'recording_buffer',None) is not None or
        (self.native_pending is not None and self.native_pending[0][1].get('type')=='play_recording'))
      if self.drive is not None or self.drive_stopping is not None or recording:
        self.cancel('ota')
        if recording:self.event('canceled',error='ota')
      return
    if topic==(self.prefix+'emergency').encode():
      self.asset_pending=None
      self.emergency=True
      return
    if self.emergency:return
    if topic==(self.prefix+'asset').encode():
      # One bounded raw slot; no JSON, schema, metadata or replies on MQTT stack.
      # Drop saturation/oversize and work received under another owner, never
      # queue it for execution after that owner releases native IO.
      if (type(payload) is bytes and len(payload)<=1600 and self.asset_pending is None
          and not self.initial_stop and self.client is not None and self.blocks is None
          and self.pending is None and self.native_pending is None and self.timer is None
          and self.action is None and self.stop_pending is None and self.sensor_index is None
          and not self.motor_stop_needed and self.drive is None and self.drive_stopping is None):
        self.asset_pending=payload
      return
    if topic==(self.prefix+'drive').encode():
      self.drive_request(payload)
      return
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
            if self.drive is not None or self.drive_stopping is not None:
              self.cancel('stop')
              return
            self.stop_pending=payload
            return
      except Exception:pass
    # Live drive owns all native IO. Never leave work for after release.
    if self.drive is not None or self.drive_stopping is not None:return
    if self.motor_stop_needed and self.timer is None:return
    if self.asset_busy():return
    if self.pending is None and self.stop_pending is None:
      if topic in ((self.prefix+'command').encode(),(self.prefix+'program').encode()):
        self.pending=payload if len(payload)<=8192 else b'null'

  def drive_event(self,request,event,reason=None):
    data={'hold_id':request['hold_id'],'boot':request['boot'],'event':event}
    if reason is not None:data['reason']=reason
    self.publish('drive_status',data)

  def drive_request(self,payload):
    self.expire_drive()
    request=None
    try:
      if len(payload)>1024:raise ValueError('size')
      request=json.loads(payload)
      if type(request) is not dict:raise ValueError('request')
      # ujson has no object_pairs_hook: count separators outside strings to
      # reject duplicate keys in this flat, primitive-only wire schema.
      quoted=escaped=False
      fields=0
      for char in payload:
        if quoted:
          if escaped:escaped=False
          elif char==92:escaped=True
          elif char==34:quoted=False
        elif char==34:quoted=True
        elif char==58:fields+=1
      if fields!=len(request):raise ValueError('duplicate')
      op=request.get('op')
      keys=('op','hold_id','boot','direction','speed') if op in ('start','tap') else ('op','hold_id','boot')
      if op not in ('start','tap','renew','stop') or len(request)!=len(keys) or any(k not in keys for k in request):
        raise ValueError('fields')
      if type(request['hold_id']) is not str or not 1<=len(request['hold_id'])<=64:
        raise ValueError('hold_id')
      if type(request['boot']) is not str or request['boot']!=self.ctx.boot:raise ValueError('boot')
      if op in ('start','tap'):
        if request['direction'] not in ('forward','backward','left','right'):raise ValueError('direction')
        number(request,'speed',None,0,100)
    except Exception:
      hold_id=request.get('hold_id') if type(request) is dict else None
      if type(hold_id) is not str or len(hold_id)>64:hold_id=''
      self.drive_event({'hold_id':hold_id,'boot':self.ctx.boot},'rejected','malformed')
      return
    if op in ('start','tap'):
      if (self.asset_busy() or self.initial_stop or self.client is None or self.drive is not None or self.drive_stopping is not None
          or self.motor_stop_needed
          or self.blocks is not None or self.pending is not None or self.native_pending is not None
          or self.timer is not None or self.action is not None or self.stop_pending is not None
          or self.sensor_index is not None):
        self.drive_event(request,'rejected','busy')
        return
      self.drive=request
      self.drive_at=self.clock.ticks_ms()
      self.drive_started=False
      self.action=('drive',request)
    elif self.drive is not None and request['hold_id']==self.drive['hold_id']:
      if op=='renew':
        if self.drive['op']=='tap':
          self.drive_event(request,'rejected','not_renewable')
          return
        # Pending starts cannot extend their original deadline. Ignore early
        # renewals: a rejection would incorrectly terminate the server owner.
        if self.drive_started:self.drive_at=self.clock.ticks_ms()
      elif op=='stop':self.cancel('released')
    else:self.drive_event(request,'rejected','inactive')

  def expire_drive(self):
    if self.drive is not None:
      tap=self.drive['op']=='tap' and self.drive_started
      if self.clock.ticks_diff(self.clock.ticks_ms(),self.drive_at)>=(400 if tap else 700):
        self.cancel('tap_completed' if tap else 'expired')

  def drive_stopped(self):
    self.motor_stop_needed=False
    stopped,self.drive_stopping=self.drive_stopping,None
    if stopped is not None:self.drive_event(stopped[0],'stopped',stopped[1])

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
    capabilities=list(CAPS)
    if (getattr(self.io,'recording_available',False) and self.recordings is not None
        and self.recordings.ready and self.recordings.error is None):
      capabilities+=['play_recording','recorded_audio_v1']
    self.publish('status',{'status':'running' if self.blocks else 'ready',
      'diagnostic_revision':DIAGNOSTIC_REVISION,'uptime_ms':self.clock.ticks_ms(),
      'reset_cause':self.reset_cause,
      'application':'cooperative-v1','capabilities':capabilities,
      'motion_enabled':True,'armed':self.client is not None,
      'self_managed_homing':True,'device':self.ctx.device,
      'boot':self.ctx.boot,'sha256':self.ctx.sha256,'build':OTA_BUILD_ID})
    self.reported=self.clock.ticks_ms()

  def diagnostic(self,event):
    return {'event':event,'diagnostic_revision':DIAGNOSTIC_REVISION,
      'boot':self.ctx.boot,'sha256':self.ctx.sha256,'build':OTA_BUILD_ID,
      'uptime_ms':self.clock.ticks_ms(),'run_id':self.run_id,'block_path':[self.index],
      'battery_snapshot':self.battery_snapshot}

  def cancel(self,reason='canceled'):
    self.asset_pending=None
    if self.recordings is not None:self.recordings.cancel()
    self.sensor_index=None
    if self.indexed_run:self.motor_stop_needed=True
    self.indexed_run=False
    if self.drive is not None:
      self.drive_stopping=(self.drive,reason)
      self.drive=None
      self.drive_at=None
      self.drive_started=False
    self.native_pending=None
    self.pending=self.blocks=self.timer=None
    self.tape=self.program_started=None
    self.stop_pending=None
    self.action=('stop',None)

  def expire_program(self):
    if (self.program_started is not None and
        self.clock.ticks_diff(self.clock.ticks_ms(),self.program_started)>=300000):
      self.cancel('elapsed')
      self.motor_stop_needed=True
      self.event('failed',error='elapsed')
      return True
    return False

  def expire_motor(self):
    if self.timer is not None and self.timer[2]:
      if self.clock.ticks_diff(self.clock.ticks_ms(),self.timer[0])>=self.timer[1]:
        self.timer=None
        self.action=('stop',True)
        return True
    return False

  def reject_busy(self):
    if self.blocks is None or self.pending is None:return
    try:request=json.loads(self.pending)
    except Exception:request=None
    compact=type(request) is dict and type(request.get('program')) is dict
    if self.tape is None and not compact:return
    self.pending=None
    run_id=request.get('run_id') if type(request) is dict else None
    if type(run_id) is not str or len(run_id)>128:run_id=None
    self.publish('execution',{'type':'program','event':'failed','run_id':run_id,
      'boot':self.ctx.boot,'build':OTA_BUILD_ID,'block_path':[],
      'error':'busy','details':{'error':'busy'}})

  def complete(self):
    if self.expire_program():return
    self.event('completed','block')
    self.index += 1
    if self.index==len(self.tape if self.tape is not None else self.blocks):
      self.blocks=None
      self.tape=self.program_started=None
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
        for name in ('command','program','emergency','drive','asset'):
          self.client.sock.settimeout(1)
          self.client.subscribe((self.prefix+name).encode(),qos=0)
        self.client.sock.settimeout(1)
        self.client.subscribe(self.ota_topic,qos=0)
        self.status()
        if self.lost:
          self.event('failed',error='network')
          self.lost=False
      self.client.check_msg()
      network=False
      now=self.clock.ticks_ms()
      if self.expire_program():return
      if self.reported is None or self.clock.ticks_diff(now,self.reported)>=5000:
        self.status()
      if self.emergency:
        self.emergency=False
        self.cancel('emergency')
        self.event('canceled')
        self.status()
        return
      if self.stop_pending is not None:
        payload=self.stop_pending
        if self.blocks is not None:self.event('canceled')
        self.cancel()
        self.pending=payload
      if self.drive is not None or self.drive_stopping is not None:return
      if self.asset_busy():return
      self.reject_busy()
      if self.native_pending is not None:return
      if self.timer is not None:
        start,duration,motor=self.timer
        if self.clock.ticks_diff(now,start)>=duration:
          if motor:self.action=('stop',True)
          self.timer=None
          if not motor:self.complete()
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
        if type(plan) is dict:
          if 'program' not in request or any(k not in ('program','run_id','timestamp') for k in request):
            raise ValueError('envelope')
          self.blocks,self.tape=validate_indexed(plan)
          self.indexed_run=True
          self.program_started=self.clock.ticks_ms()
        else:self.blocks=validate(plan)
        for command in self.blocks:
          if command['type']=='play_recording':
            store=self.recordings
            if not getattr(self.io,'recording_available',False) or store is None or not store.ready or store.error is not None:
              raise ValueError('recording_unavailable')
            meta=store.assets.get(command['recording'])
            if meta is None:raise ValueError('recording_missing')
            if command['duration']!=meta['duration_ms']/1000:raise ValueError('recording_duration')
        self.index=0
        self.event('started')
      if self.blocks is not None:
        b=self.blocks[self.tape[self.index] if self.tape is not None else self.index]
        t=b['type']
        self.event('started','block')
        motor=t in ('move_forward','move_backward','dc_motor')
        duration=b.get('duration',0)
        if t=='stop':self.action=('stop',None)
        elif t=='status':self.status()
        elif t=='read_sensors':self.action=('sensors',None)
        elif t!='wait' and (t!='play_tone' or duration>0) and (not motor or duration>0):
          self.action=('execute',b)
          return
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
      if (item[1].get('type')=='program' and item[1].get('event')=='canceled')
      or (item[0]=='drive_status' and item[1].get('event')=='stopped')]
    try:
      self.cancel('network')
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
    def __init__(self):
      self.recording_available=False
      self.recording_buffer=None
      self.recording_root='/flash/mbot_voice'
      # Never import an absent speaker module: import constructs a singleton
      # and starts vendor workers. Discovery inspects already-loaded objects.
      try:
        import sys
        module=sys.modules.get('driver.speaker')
        globals_module=sys.modules.get('global_objects')
        speaker=getattr(module,'speaker_obj',None)
        player=getattr(globals_module,'mp3_music_o',None)
        play=getattr(speaker,'__play_mp3',None)
        speed=getattr(speaker,'play_speed',None)
        source=getattr(module,'SOUNDS_TYPE_MP3_SOURCE',None)
        mode=getattr(player,'PLAYER_MODE_MP3',None)
        if (callable(play) and type(speed) is int and speed==100 and type(source) is int and source==5
            and type(mode) is int and mode==1 and callable(getattr(player,'play',None))
            and callable(getattr(player,'stop',None)) and callable(getattr(cyberpi.audio,'stop',None))):
          self.recording_play=play
          self.recording_speed,self.recording_source=speed,source
          self.recording_available=True
      except Exception:pass
    def drive(self,direction,speed):
      # Vendor: yuque.com/makeblock-help-center-en/mcode/cyberpi-api-shields
      # drive_power(EM1_power, EM2_power): percent, positive shaft CCW.
      # EM1 is left, EM2 right: mirrored shafts need opposite signs forward.
      # A single synchronous setpoint, NOT a timed/angle movement or sleep.
      left=-speed if direction in ('backward','left') else speed
      right=-speed if direction in ('forward','left') else speed
      mbot2.drive_power(left,right)
    def stop(self):
      try:mbot2.EM_stop()
      finally:
        try:mbot2.starter_shield.dc_motor_stop()
        finally:cyberpi.audio.stop()
      # Native may borrow this buffer; no cancellation/error path frees it.
      self.recording_buffer=None
    def execute(self,b):
      t=b['type']
      if t=='move_forward':mbot2.forward(b['speed'])
      elif t=='move_backward':mbot2.backward(b['speed'])
      elif t=='dc_motor':mbot2.starter_shield.dc_motor_set_power(int(b['port'][1]),b['speed'])
      elif t=='servo':mbot2.starter_shield.servo_set_angle(int(b['port'][1]),b['angle'])
      elif t=='display_text':cyberpi.display.show_label(b['text'],b['size'],'center',index=0)
      elif t=='play_tone':
        # Vendor call may block for duration (at most 2s); Stop cannot preempt it.
        if b['duration']>0:cyberpi.audio.play_tone(b['frequency'],b['duration'])
      elif t=='play_sound':cyberpi.audio.play(b['sound'])
      elif t=='play_recording':
        if not self.recording_available or self.recording_buffer is not None:raise ValueError('recording_unavailable')
        ident=b['recording']
        if not asset_id(ident):raise ValueError('recording')
        with open(self.recording_root+'/'+ident+'.json','r') as stream:meta=json.loads(stream.read(513))
        Recordings.metadata(None,meta)
        if meta['id']!=ident or b['duration']!=meta['duration_ms']/1000:raise ValueError('recording_duration')
        with open(self.recording_root+'/'+ident+'.mp3','rb') as stream:data=stream.read(24577)
        import hashlib
        if len(data)!=meta['size'] or binascii.hexlify(hashlib.sha256(data).digest()).decode()!=ident:raise ValueError('recording_digest')
        self.recording_buffer=data
        self.recording_play(self.recording_buffer,self.recording_speed,self.recording_source,False)
      elif t=='set_volume':cyberpi.audio.set_vol(b['volume'])
      elif t=='stop_sound':cyberpi.audio.stop()
      elif t in ('turn_left','turn_right'):
        if b['angle']>0:mbot2.turn(-b['angle'] if t=='turn_left' else b['angle'])
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
  if _app.identity!=(context.device,context.boot,context.sha256):
    _app.sensor_index=None
    _app.cancel('identity')
    _app.action=None
    _app.motor_stop_needed=True
    try:_app.io.stop()
    except Exception:return
    _app.drive_stopped()
    raise ValueError('identity')
  try:
    if _app.initial_stop:
      try:_app.io.stop()
      except Exception:return
      _app.initial_stop=False
      try:
        import machine
        for name in ('PWRON_RESET','HARD_RESET','WDT_RESET','DEEPSLEEP_RESET','SOFT_RESET'):
          value=getattr(machine,name,None)
          if value is not None:_app.reset_cause['constants'][name]=value
        _app.reset_cause['raw']=machine.reset_cause()
      except Exception as error:_app.reset_cause['error']=str(error)[:128]
      diagnostic=_app.diagnostic('boot')
      diagnostic['reset_cause']=_app.reset_cause
      _app.publish('log',diagnostic)
    if _app.emergency and _app.drive is not None:
      _app.emergency=False
      _app.cancel('emergency')
    _app.expire_drive()
    _app.expire_program()
    _app.expire_asset()
    # A Stop already received wins over a simultaneous completion deadline.
    if (_app.timer is not None and _app.timer[2] and
        _app.clock.ticks_diff(_app.clock.ticks_ms(),_app.timer[0])>=_app.timer[1]):
      if _app.emergency:
        _app.emergency=False
        _app.cancel('emergency')
        _app.event('canceled')
      elif _app.stop_pending is not None:
        payload=_app.stop_pending
        _app.event('canceled')
        _app.cancel('stop')
        _app.pending=payload
    due_stop=_app.expire_motor()
    stopping=(_app.drive_stopping is not None or
      (_app.motor_stop_needed and _app.timer is None))
    if stopping and not due_stop:
      _app.motor_stop_needed=True
      try:_app.io.stop()
      except Exception:return
      _app.drive_stopped()
      _app.action=None
    prepared=_app.native_pending
    if not stopping and not due_stop:_app.step()
    _app.expire_asset()
    if _app.asset_pending is not None:
      # MQTT has fully unwound. Parse/admit here, before any disk phase.
      payload,_app.asset_pending=_app.asset_pending,None
      request=None
      stage='json'
      try:
        request=json.loads(payload)
        stage='schema'
        if type(request) is not dict:raise ValueError('request')
        quoted=escaped=False
        fields=0
        for char in payload:
          if quoted:
            if escaped:escaped=False
            elif char==92:escaped=True
            elif char==34:quoted=False
          elif char==34:quoted=True
          elif char==58:fields+=1
        if fields!=len(request):raise ValueError('duplicate')
        op=request.get('op')
        keys=('op','transfer_id','boot')
        if op=='begin':keys+=('id','size','sha256','duration_ms')
        elif op=='chunk':keys+=('offset','data')
        elif op in ('status','delete'):keys+=('id',)
        elif op not in ('finish','abort'):raise ValueError('op')
        if len(request)!=len(keys) or any(k not in keys for k in request):raise ValueError('fields')
        if type(request['transfer_id']) is not str or not 1<=len(request['transfer_id'])<=64:raise ValueError('transfer_id')
        if request['boot']!=_app.ctx.boot:raise ValueError('boot')
        if 'id' in request and not asset_id(request['id']):raise ValueError('id')
        if op=='chunk':
          data=request['data']
          if type(request['offset']) is not int or not 0<=request['offset']<=24576:raise ValueError('offset')
          if type(data) is not str or not 2<=len(data)<=1024 or len(data)%2 or any(c not in '0123456789abcdefABCDEF' for c in data):raise ValueError('data')
        store=_app.recordings
        if store is None or not getattr(_app.io,'recording_available',False):raise ValueError('unsupported')
        stage='metadata'
        if op=='begin':store.metadata({k:request[k] for k in ('id','sha256','size','duration_ms')})
        stage='admission'
        if store.request==request:
          store.at=_app.clock.ticks_ms()
        elif (not store.ready or store.error is not None or store.job is not None or store.cleanup
            or _app.initial_stop or _app.client is None or _app.blocks is not None or _app.pending is not None
            or _app.native_pending is not None or _app.timer is not None or _app.action is not None
            or _app.stop_pending is not None or _app.sensor_index is not None or _app.motor_stop_needed
            or _app.drive is not None or _app.drive_stopping is not None):raise ValueError('busy')
        else:
          store.request=request
          store.job=store.operation(request)
          owner=store.transfer or store.last
          store.reply_id=request.get('id',owner['meta']['id'] if owner and owner['transfer_id']==request['transfer_id'] else '')
          if store.transfer is None or store.transfer['transfer_id']==request['transfer_id']:store.at=_app.clock.ticks_ms()
      except Exception as error:
        request=request if type(request) is dict else {}
        safe={}
        for key,limit in (('op',16),('transfer_id',64),('boot',128),('id',64)):
          value=request.get(key,'')
          safe[key]=value if type(value) is str and len(value)<=limit else ''
        safe.update({'ok':False,'offset':0,'error':str(error)[:64],'error_stage':stage})
        owner=_app.recordings.transfer if _app.recordings is not None else None
        if owner is not None and owner['transfer_id']==safe['transfer_id']:
          safe['id'],safe['offset']=owner['meta']['id'],owner['offset']
        _app.publish('asset_status',safe)
    if (_app.recordings is not None and not _app.motor_stop_needed and
        (_app.action is None or _app.action[0]!='stop')):
      store=_app.recordings
      ack=store.step()
      # The pure scheduler has returned; no generator/dispatch frames may
      # surround filesystem builtins on the native low-stack runtime.
      disk,store.action=store.action,None
      if disk is not None:
        store.error_stage='fs_'+disk[0]
        try:store.io_result=store.execute(disk)
        except Exception as error:store.io_error=error
      if store.request is not None:store.at=_app.clock.ticks_ms()
      if ack is not None:_app.publish('asset_status',ack)
    _app.expire_drive()
    action,_app.action=_app.action,None
    if prepared is not None and _app.native_pending is prepared and prepared[2]:
      action=prepared[0]
      _app.native_pending=None
    elif action is not None and action[0] in ('execute','drive'):
      diagnostic=_app.diagnostic('native_before')
      diagnostic['command']=dict(action[1])
      _app.native_pending=[action,diagnostic,False]
      _app.publish('log',diagnostic)
      _app.sensor_index=None
      action=None
    if _app.client is None or (action is not None and action[0]!='sensors'):
      _app.sensor_index=None
    if action is None and _app.sensor_index is not None:
      action=('sensors',None)
    if action is not None:
      try:
        if action[0]=='stop':
          _app.motor_stop_needed=True
          _app.io.stop()
          _app.drive_stopped()
          if action[1]:_app.complete()
        elif action[0]=='sensors':
          if _app.sensor_index is None:_app.sensor_index=0
          data=_app.io.sensors(_app.sensor_index)
          if _app.sensor_index==1 and 'battery' in data:
            _app.battery_snapshot={'value':data['battery'],'ticks_ms':_app.clock.ticks_ms()}
          _app.publish('sensors',data)
          _app.sensor_index=_app.sensor_index+1 if data.get('sampling') else None
        else:
          started=_app.clock.ticks_ms()
          if action[0]=='execute' and action[1]['type'] in ('move_forward','move_backward','dc_motor','play_recording','turn_left','turn_right'):
            # A setpoint may take effect even when its driver subsequently throws.
            _app.motor_stop_needed=True
          if action[0]=='drive':_app.io.drive(action[1]['direction'],action[1]['speed'])
          else:_app.io.execute(action[1])
          if action[0]=='execute' and action[1]['type'] in ('turn_left','turn_right'):
            # A successful blocking turn has returned; its exceptional path
            # retains the latch and Stops before diagnostics like other motors.
            _app.motor_stop_needed=False
          diagnostic=dict(prepared[1])
          diagnostic['event']='native_after'
          diagnostic['elapsed_ms']=_app.clock.ticks_diff(_app.clock.ticks_ms(),started)
          diagnostic['uptime_ms']=_app.clock.ticks_ms()
          _app.publish('log',diagnostic)
          if action[0]=='drive':
            # Tap gets its full bounded pulse only after successful native return.
            # Pending admission still uses the original 700ms receipt deadline.
            if action[1]['op']=='tap':_app.drive_at=_app.clock.ticks_ms()
            _app.drive_started=True
            _app.drive_event(action[1],'started')
          elif _app.expire_program():
            # Outer recovery below owns Stop, so its failure cannot replace
            # the elapsed terminal with a spurious native-command exception.
            pass
          else:
            b=action[1]
            seconds=b.get('duration',0)
            # Positive holds always get at least one scheduler millisecond.
            duration=max(1,int(seconds*1000)) if seconds>0 else 0
            if b['type']=='play_recording':duration=int(seconds*1000+0.5)
            if duration>0:
              _app.timer=(started if b['type']=='play_tone' else _app.clock.ticks_ms(),duration,
                b['type'] in ('move_forward','move_backward','dc_motor','play_recording'))
            else:_app.complete()
      except Exception as error:
        _app.sensor_index=None
        if action[0] in ('execute','drive'):
          diagnostic=dict(prepared[1])
          diagnostic.update({'event':'native_exception','error':str(error)[:128],
            'error_type':type(error).__name__,'uptime_ms':_app.clock.ticks_ms(),
            'elapsed_ms':_app.clock.ticks_diff(_app.clock.ticks_ms(),started)})
          if action[0]=='execute' and not _app.motor_stop_needed and not _app.indexed_run:
            # Preserve existing blocking-command diagnostics; nonblocking motor
            # setpoints must Stop before any network diagnostic can delay them.
            try:
              _app.client.sock.settimeout(1)
              _app.client.publish((_app.prefix+'log').encode(),json.dumps(diagnostic).encode(),retain=False,qos=0)
            except Exception:pass
        # Drop speculative completions, not the preempted run's terminal event.
        _app.outgoing=[item for item in _app.outgoing
          if item[1].get('type')=='program' and item[1].get('event')=='canceled']
        _app.cancel('native_error')
        _app.action=None
        if action[0]=='drive' or (action[0]=='execute' and _app.motor_stop_needed):
          # Queue locally: native drive may have moved before throwing. No
          # network diagnostic may delay Stop, including a failed Stop retry.
          _app.publish('log',diagnostic)
        if not any(item[1].get('type')=='program' and item[1].get('event')=='canceled'
            and item[1].get('run_id')==_app.run_id for item in _app.outgoing):
          _app.event('failed',error=error)
        try:
          _app.io.stop()
          _app.drive_stopped()
        except Exception:
          # Keep the stop obligation latched; retry before any network/work.
          _app.motor_stop_needed=True
          return
    for _ in range(8):
      _app.expire_drive()
      _app.expire_program()
      due_stop=_app.expire_motor()
      if _app.drive_stopping is not None or (_app.motor_stop_needed and _app.timer is None):
        _app.motor_stop_needed=True
        try:_app.io.stop()
        except Exception as error:
          if due_stop:
            _app.cancel('stop_error')
            _app.event('failed',error=error)
          return
        _app.drive_stopped()
        _app.action=None
        if due_stop:_app.complete()
      if _app.client is None or not _app.outgoing:break
      suffix,data=_app.outgoing[0]
      try:
        _app.client.sock.settimeout(1)
        _app.client.publish((_app.prefix+suffix).encode(),json.dumps(data).encode(),retain=False,qos=0)
        _app.outgoing.pop(0)
        if _app.native_pending is not None and data is _app.native_pending[1]:
          _app.native_pending[2]=True
      except Exception:
        if _app.run_id is None:_app.run_id=data.get('run_id')
        _app.disconnect(_app.clock.ticks_ms())
        _app.action=None
        _app.motor_stop_needed=True
        try:_app.io.stop()
        except Exception:return
        _app.drive_stopped()
        break
    _app.expire_drive()
    _app.expire_program()
    due_stop=_app.expire_motor()
    if _app.drive_stopping is not None or (_app.motor_stop_needed and _app.timer is None):
      _app.motor_stop_needed=True
      try:_app.io.stop()
      except Exception as error:
        if due_stop:
          _app.cancel('stop_error')
          _app.event('failed',error=error)
        return
      _app.drive_stopped()
      _app.action=None
      if due_stop:_app.complete()
    if _app.client is None:_app.sensor_index=None
    # Retain correlation through final native IO and all queued publications.
    if _app.blocks is None and not _app.outgoing and not _app.lost:
      _app.run_id=None
      _app.indexed_run=False
  except Exception as error:
    print('MOTOR_APP_ERROR:',repr(error))
    try:
      import sys
      sys.print_exception(error)
    except Exception:pass
    raise
