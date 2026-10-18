import mqtt from 'mqtt';
import { DriveHold } from './drive-hold.js';
import { RobotDiagnostics } from './robot-diagnostics.js';
import { randomUUID } from 'node:crypto';
import { encodeProgram, selectProgramProfile, LEGACY_PROGRAM_PROFILE } from './program-encoding.js';
import { RecordingTransfer, recordingMetadata } from './recording-transfer.js';

const MOTION_TYPES = new Set(['move_forward', 'move_backward', 'turn_left', 'turn_right',
  'set_speed', 'move_until', 'dc_motor', 'dc_motor_position', 'servo']);
// A capability must be advertised AND understood here. New types require an
// explicit classification, not an assumption that an unfamiliar type is safe.
const COOPERATIVE_TYPES = new Set([...MOTION_TYPES, 'wait', 'stop', 'display_text', 'say',
  'set_led', 'set_variable', 'change_variable', 'math_operation', 'repeat',
  'repeat_forever', 'if_obstacle', 'if_sensor_range', 'if_predicate',
  'if_else_predicate', 'repeat_until', 'while_block', 'wait_until']);
// cooperative-v1 advertises statement types; its reporter grammar is fixed.
const COOPERATIVE_REPORTERS = new Set(['var_get', 'sensor_distance', 'op_add',
  'op_sub', 'op_mul', 'op_div', 'op_gt', 'op_lt', 'op_eq', 'op_and', 'op_or', 'op_not']);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// robot_control.py is a different, smaller runtime than RobotEngine. This is
// deliberately not derived from advertised CAPS: AV extensions require the
// validated AV build, never just a motor build advertising extra capabilities.
const MOTOR_CONTROL_FIELDS = {
  move_forward: ['speed', 'duration'], move_backward: ['speed', 'duration'],
  dc_motor: ['port', 'speed', 'duration'], servo: ['port', 'angle', 'speed'],
  turn_left: ['angle'], turn_right: ['angle'], wait: ['duration'],
  stop: [], display_text: ['text', 'size'], set_led: ['color'],
};
const MOTOR_CONTROL_RUNTIME_TYPES = new Set(['read_sensors', 'status']);
const AV_CONTROL_FIELDS = {
  ...MOTOR_CONTROL_FIELDS,
  play_tone: ['frequency', 'duration'], play_sound: ['sound'],
  play_recording: ['recording', 'duration'],
  set_volume: ['volume'], stop_sound: [], display_animation: ['frames', 'interval'],
};

function admissionError(message, status = 400, code = 'COOPERATIVE_INVALID') {
  return Object.assign(new Error(message), { status, code });
}

/**
 * MQTT Service - Bridges the web app with the mBot2 robot
 * Singleton pattern so the same connection is shared across the app
 */
export class MqttService {
  static instance = null;
  client = null;
  connected = false;
  listeners = new Map();
  topicPrefix = process.env.MQTT_TOPIC_PREFIX || 'mbot-studio';

  // Robot presence tracking — separate from MQTT broker connection
  robotLastSeen = null;     // timestamp of last message FROM the robot
  robotState = 'unknown';   // last known state: ready, running, stopped, idle, offline
  robotStatusMetadata = {};
  robotStatusLastSeen = null;
  static ROBOT_TIMEOUT = 15000; // 15 seconds without heartbeat → robot offline

  // Assumed hardware state tracking per port (for stateless actuators)
  // Map<port, { assumedState: string, lastAction: string, timestamp: number, confidence: 'high'|'low'|'none' }>
  hardwareStates = new Map();

  static getInstance() {
    if (!MqttService.instance) {
      MqttService.instance = new MqttService();
    }
    return MqttService.instance;
  }

  constructor({ diagnostics, driveClock, mqttConnect = mqtt.connect, recordingRegistry = null, recordingTransferOptions } = {}) {
    this.diagnostics = diagnostics || new RobotDiagnostics({ persist: false });
    this.mqttConnect = mqttConnect;
    this.timeoutRecordedFor = null;
    this.driveHold = new DriveHold(this, { now: driveClock });
    this.recordingRegistry = recordingRegistry;
    this.recordingTransfer = new RecordingTransfer(this, recordingTransferOptions);
  }

  publishRecorded(topic, payload, onResult = null) {
    const data = JSON.parse(payload);
    const intentId = this.diagnostics.record('publish_intent', {
      topic: topic.replace(`${this.topicPrefix}/`, ''), payload: data, identity: this.robotStatusMetadata,
    });
    try {
      this.client.publish(topic, payload, { qos: 0, retain: false }, error => {
        this.diagnostics.record('publish_result', { intentId, run_id: data.run_id ?? null,
          outcome: error ? 'transport_error' : 'transport_callback', errorCode: error?.code ?? null });
        onResult?.(error);
      });
    } catch (error) {
      this.diagnostics.record('publish_result', { intentId, outcome: 'publish_threw', errorCode: error.code ?? null });
      throw error;
    }
  }

  checkRobotTimeout() {
    if (this.robotLastSeen && Date.now() - this.robotLastSeen >= MqttService.ROBOT_TIMEOUT && this.timeoutRecordedFor !== this.robotLastSeen) {
      this.timeoutRecordedFor = this.robotLastSeen;
      this.diagnostics.record('robot_timeout', { inferred: true, lastSeen: this.robotLastSeen,
        thresholdMs: MqttService.ROBOT_TIMEOUT, brokerConnected: this.connected, cause: 'unknown' });
    }
  }

  getDiagnostics() {
    this.checkRobotTimeout();
    return { ...this.diagnostics.snapshot(), current: this.getRobotStatus() };
  }

  async connect() {
    if (!this.diagnostics.persist) this.diagnostics = new RobotDiagnostics();
    const brokerUrl = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';

    return new Promise((resolve, reject) => {
      this.client = this.mqttConnect(brokerUrl, {
        clientId: `mbot-studio-server-${Date.now()}`,
        clean: true,
        queueQoSZero: false,
        connectTimeout: 5000,
        reconnectPeriod: 5000,
      });

      this.client.on('connect', () => {
        this.connected = true;
        this.diagnostics.record('broker_connect');
        if (!this.diagnosticTimer) {
          this.diagnosticTimer = setInterval(() => this.checkRobotTimeout(), 1000);
          this.diagnosticTimer.unref();
        }
        console.log(`📡 Connected to MQTT broker at ${brokerUrl}`);

        // Subscribe to robot status topics
        this.client.subscribe(`${this.topicPrefix}/robot/status`);
        this.client.subscribe(`${this.topicPrefix}/robot/sensors`);
        this.client.subscribe(`${this.topicPrefix}/robot/log`);
        this.client.subscribe(`${this.topicPrefix}/robot/repl/result`);
        this.client.subscribe(`${this.topicPrefix}/robot/execution`);
        this.client.subscribe(`${this.topicPrefix}/robot/drive_status`);
        this.client.subscribe(`${this.topicPrefix}/robot/asset_status`, { qos: 0 });
        this.client.subscribe(`${this.topicPrefix}/ota/+/request`, { qos: 0 });

        resolve();
      });

      this.client.on('message', (topic, message, packet = {}) => {
        const shortTopic = topic.replace(`${this.topicPrefix}/`, '');
        const payload = message.toString();
        const otaDevice = /^ota\/([^/]+)\/request$/.exec(shortTopic)?.[1];
        if (otaDevice && (!this.robotStatusMetadata.device || otaDevice === this.robotStatusMetadata.device)) {
          this.recordingTransfer.invalidate('OTA request observed');
          this.robotStatusLastSeen = null;
        }
        if (['robot/status', 'robot/sensors', 'robot/execution', 'robot/log'].includes(shortTopic)) {
          let data;
          try { data = JSON.parse(payload); } catch { data = { text: payload, malformedJson: true }; }
          const previous = this.diagnostics.lastKnown.status?.payload;
          if (shortTopic === 'robot/status' && data?.boot && previous?.boot && data.boot !== previous.boot) {
            this.diagnostics.record('boot_change', { previousBoot: previous.boot, boot: data.boot, build: data.build, sha256: data.sha256 });
          }
          this.checkRobotTimeout();
          this.diagnostics.record('incoming', { topic: shortTopic, payload: data });
        }

        // Track robot presence — any message from the robot means it's alive
        if (shortTopic === 'robot/status' || shortTopic === 'robot/sensors' || shortTopic === 'robot/log' || shortTopic === 'robot/repl/result' || shortTopic === 'robot/execution') {
          this.robotLastSeen = Date.now();
          // Parse robot state from status messages
          if (shortTopic === 'robot/status') {
            try {
              const data = JSON.parse(payload);
              if (isObject(data)) {
                const old = this.robotStatusMetadata;
                const application = typeof data.application === 'string' && data.application
                  ? data.application : old.application;
                // A new app/boot cannot inherit old capability or motion grants.
                if (application !== old.application || (typeof data.boot === 'string' && data.boot !== old.boot)) {
                  this.robotStatusMetadata = application ? { application } : {};
                  this.robotStatusLastSeen = null;
                }
                for (const key of ['capabilities', 'motion_enabled', 'armed', 'self_managed_homing', 'build', 'boot', 'sha256', 'device', 'turn_calibration']) {
                  if (Object.hasOwn(data, key)) this.robotStatusMetadata[key] = data[key];
                }
                // Sparse lifecycle messages keep metadata visible but do not renew
                // admission freshness. Only a complete capability status does that.
                if (!this.isCooperativeApp() || ['capabilities', 'motion_enabled', 'armed'].every(key => Object.hasOwn(data, key))) {
                  this.robotStatusLastSeen = Date.now();
                }
                if (data.status) {
                  this.robotState = data.status;
                  console.log(`🤖 Robot state: ${data.status}`);
                }
              }
            } catch { /* ignore parse errors */ }
          }
        }

        if (shortTopic === 'robot/status') this.driveHold.checkStatus();
        if (shortTopic === 'robot/status') this.recordingTransfer.checkStatus();
        if (shortTopic === 'robot/asset_status' && message.length <= 2048) {
          try { this.recordingTransfer.handleAck(JSON.parse(payload), packet); } catch { /* malformed asset ACK */ }
        }
        if (shortTopic === 'robot/drive_status') {
          try { this.driveHold.deviceStatus(JSON.parse(payload)); } catch { /* malformed device status */ }
        }

        // Notify all listeners
        for (const [, callback] of this.listeners) {
          try {
            callback(shortTopic, payload);
          } catch (e) {
            console.error('MQTT listener error:', e);
          }
        }
      });

      this.client.on('error', (err) => {
        this.connected = false;
        this.robotStatusLastSeen = null;
        this.driveHold.invalidate('MQTT error');
        this.recordingTransfer.invalidate('MQTT error', false);
        this.diagnostics.record('broker_error', { code: err.code ?? null });
        reject(err);
      });

      this.client.on('offline', () => {
        this.connected = false;
        this.robotStatusLastSeen = null;
        this.driveHold.invalidate('MQTT offline');
        this.recordingTransfer.invalidate('MQTT offline', false);
        this.diagnostics.record('broker_offline');
      });
      this.client.on('close', () => {
        this.connected = false;
        this.robotStatusLastSeen = null;
        this.driveHold.invalidate('MQTT closed');
        this.recordingTransfer.invalidate('MQTT closed', false);
        this.diagnostics.record('broker_close');
      });

      // Timeout after 5 seconds
      setTimeout(() => {
        if (!this.connected) {
          reject(new Error('MQTT connection timeout'));
        }
      }, 5000);
    });
  }

  /**
   * Send a command to the robot
   */
  sendCommand(command) {
    this.recordingTransfer.rejectCompetingCommand();
    if (command?.type === 'play_recording') throw admissionError('Recorded audio requires Program preparation', 422, 'COOPERATIVE_UNSUPPORTED');
    this.driveHold.rejectCompetingCommand();
    if (this.isCooperativeApp() &&
        !['mbot-motor-control-v1', 'mbot-av-control-v1'].includes(this.robotStatusMetadata.build) &&
        ['read_sensors', 'status', 'get_status'].includes(command?.type)) {
      // Runtime operations, not executable statement capabilities. An empty
      // program admission still enforces a fresh, online cooperative status.
      this.validateCooperativeProgram([]);
    } else {
      this.validateCooperativeProgram([command], { commandEnvelope: true });
    }
    if (!this.connected) {
      console.warn('MQTT not connected, command not sent');
      return false;
    }

    const topic = `${this.topicPrefix}/robot/command`;
    const payload = JSON.stringify(this.isCooperativeApp()
      ? { ...command, run_id: command.run_id || randomUUID() } : command);
    this.validateCooperativePayload(payload);
    this.publishRecorded(topic, payload);
    console.log(`📤 Command sent: ${command.type}`);
    return true;
  }

  /**
   * Send a full program to the robot for autonomous execution
   */
  sendProgram(program, runId = null, timestamp = Date.now()) {
    this.recordingTransfer.rejectCompetingCommand();
    this.driveHold.rejectCompetingCommand();
    if (this.isCooperativeApp() && this.robotStatusMetadata.build === 'mbot-av-control-v1') {
      const prepared = this.prepareProgram(program, runId || randomUUID(), timestamp);
      const snapshot = JSON.parse(prepared.payload);
      const blocks = Array.isArray(snapshot.program) ? snapshot.program : snapshot.program.commands;
      const recordings = new Map(blocks.filter(block => block.type === 'play_recording').map(block => {
        const id = (block.params || block).recording;
        return [id, this.resolveRecording(id)];
      }));
      if (recordings.size) {
        const registry = this.recordingRegistry;
        return this.recordingTransfer.run([...recordings.keys()], async id => ({
          ...recordings.get(id), audio: await registry.read(id),
        }), session => {
          // Re-admit the immutable submitted plan, not mutable caller objects.
          const current = this.prepareProgram(snapshot.program, snapshot.run_id, snapshot.timestamp);
          this.recordingTransfer.assertSession(session);
          this.publishRecorded(`${this.topicPrefix}/robot/program`, current.payload);
          return true;
        });
      }
      this.publishRecorded(`${this.topicPrefix}/robot/program`, prepared.payload);
      return true;
    }
    this.validateCooperativeProgram(program);
    if (!this.connected) {
      console.warn('MQTT not connected, program not sent');
      return false;
    }

    const topic = `${this.topicPrefix}/robot/program`;
    const payload = JSON.stringify({ program, timestamp: Date.now(),
      ...(this.isCooperativeApp() ? { run_id: runId || randomUUID() } : {}),
    });
    this.validateCooperativePayload(payload);
    this.publishRecorded(topic, payload);
    console.log(`📤 Program sent (${program.length} blocks)`);
    return true;
  }

  /**
   * Send robot configuration to the robot
   */
  sendConfig(config) {
    if (!this.connected) return false;

    const topic = `${this.topicPrefix}/robot/config`;
    this.client.publish(topic, JSON.stringify(config));
    return true;
  }

  /**
   * Send code to the robot's REPL for execution
   */
  sendRepl(code, id = null) {
    if (this.isCooperativeApp()) {
      throw admissionError('Unsupported cooperative operation: REPL', 422, 'COOPERATIVE_UNSUPPORTED');
    }
    if (!this.connected) return false;
    const payload = JSON.stringify({ code, id: id || `repl_${Date.now()}` });
    this.client.publish(`${this.topicPrefix}/robot/repl`, payload);
    console.log(`🔧 REPL sent (${code.length} chars)`);
    return true;
  }

  /**
   * Send a diagnostic command to the robot
   */
  sendDiagnostic() {
    return this.sendCommand({ type: 'run_diagnostic' });
  }

  /**
   * Request sensor data from the robot
   */
  requestSensors() {
    if (this.isCooperativeApp()) return this.sendCommand({ type: 'read_sensors' });
    if (!this.connected) return false;
    this.publishRecorded(`${this.topicPrefix}/robot/command`, JSON.stringify({ type: 'read_sensors' }));
    return true;
  }

  /**
   * Emergency stop
   */
  emergencyStop() {
    this.recordingTransfer.invalidate('Emergency Stop');
    this.driveHold.invalidate('Emergency stop');
    if (!this.connected) return false;
    // Cooperative apps handle Stop only on the dedicated topic; a command-topic
    // duplicate becomes an unsupported program and can cancel the next run.
    const cooperative = this.isCooperativeApp();
    const stopCmd = JSON.stringify({ type: 'emergency_stop',
      ...(cooperative ? { run_id: randomUUID() } : {}),
    });
    this.publishRecorded(`${this.topicPrefix}/robot/emergency`, stopCmd);
    if (!cooperative) this.publishRecorded(`${this.topicPrefix}/robot/command`, stopCmd);
    console.log('🛑 EMERGENCY STOP sent');
    return true;
  }

  /**
   * Register a listener for robot messages
   */
  onMessage(id, callback) {
    this.listeners.set(id, callback);
  }

  /**
   * Remove a listener
   */
  removeListener(id) {
    this.listeners.delete(id);
  }

  isConnected() {
    return this.connected;
  }

  isCooperativeApp() {
    return this.robotStatusMetadata.application === 'cooperative-v1';
  }

  getProgramProfile() {
    if (!this.connected || !this.isRobotOnline() || !this.robotStatusLastSeen ||
        Date.now() - this.robotStatusLastSeen >= MqttService.ROBOT_TIMEOUT) return LEGACY_PROGRAM_PROFILE;
    return selectProgramProfile(this.robotStatusMetadata);
  }

  setRecordingRegistry(registry) {
    this.recordingTransfer.invalidate('Recording registry changed');
    this.recordingRegistry = registry;
  }

  resolveRecording(id) {
    return recordingMetadata(this.recordingRegistry?.get(id), id);
  }

  prepareProgram(program, runId, timestamp = Date.now(), sourceMap) {
    if (!this.isCooperativeApp() || this.robotStatusMetadata.build !== 'mbot-av-control-v1') {
      throw admissionError('Program encoding requires confirmed AV runtime', 422, 'COOPERATIVE_UNSUPPORTED');
    }
    if (!this.connected || !this.isRobotOnline() || !this.robotStatusLastSeen ||
        Date.now() - this.robotStatusLastSeen >= MqttService.ROBOT_TIMEOUT) {
      throw admissionError('Cooperative robot status is stale or offline', 503, 'COOPERATIVE_OFFLINE');
    }
    return encodeProgram(program, { profile: this.getProgramProfile(), runId, timestamp, sourceMap,
      validateBlock: block => this.validateCooperativeProgram([block]) });
  }

  validateCooperativePayload(payload) {
    // Control.put rejects the entire MQTT payload above 8192 bytes, including
    // JSON escaping, UTF-8 and the server's timestamp/run_id envelope.
    if (this.isCooperativeApp() &&
        ['mbot-motor-control-v1', 'mbot-av-control-v1'].includes(this.robotStatusMetadata.build) &&
        Buffer.byteLength(payload, 'utf8') > 8192) {
      throw admissionError('Motor-control MQTT payload exceeds 8192 bytes');
    }
  }

  /** Capability admission only: publishing never proves device execution. */
  validateCooperativeProgram(program, { commandEnvelope = false } = {}) {
    // Objects are a versioned Program protocol, never a legacy bypass. This
    // guard precedes even the non-cooperative return and rechecks live grants.
    if (!Array.isArray(program)) {
      if (commandEnvelope || this.getProgramProfile().encoding !== 'indexed-v1') {
        throw admissionError('Indexed Program requires program_indexed_v1 capability', 422, 'COOPERATIVE_UNSUPPORTED');
      }
      this.prepareProgram(program, '00000000-0000-4000-8000-000000000000');
      return;
    }
    if (!this.isCooperativeApp()) {
      const pending = [...program], seen = new Set();
      while (pending.length) {
        const block = pending.pop();
        if (!isObject(block) || seen.has(block)) continue;
        seen.add(block);
        if (block.type === 'play_recording') throw admissionError('Recording requires confirmed AV runtime', 422, 'COOPERATIVE_UNSUPPORTED');
        for (const key of ['do', 'then', 'else']) {
          const children = (block.params || block)[key];
          if (Array.isArray(children)) pending.push(...children);
        }
      }
      return;
    }
    if (!this.isRobotOnline() || !this.robotStatusLastSeen ||
        Date.now() - this.robotStatusLastSeen >= MqttService.ROBOT_TIMEOUT) {
      throw admissionError('Cooperative robot status is stale or offline', 503, 'COOPERATIVE_OFFLINE');
    }
    const avControl = this.robotStatusMetadata.build === 'mbot-av-control-v1';
    const motorControl = this.robotStatusMetadata.build === 'mbot-motor-control-v1' || avControl;
    const controlFields = avControl ? AV_CONTROL_FIELDS : MOTOR_CONTROL_FIELDS;
    if (motorControl &&
        (!Array.isArray(program) || program.length < 1 || program.length > 32)) {
      throw admissionError('Motor-control program must contain 1..32 flat blocks');
    }
    const capabilities = this.robotStatusMetadata.capabilities;
    // robot_control.py COLORS differs from the broader RobotEngine palette.
    const ledColors = motorControl
      ? ['red', 'green', 'blue', 'yellow', 'cyan', 'purple', 'white', 'orange', 'off']
      : ['red', 'green', 'blue', 'yellow', 'cyan', 'magenta', 'white', 'off'];
    let blockCount = 0;
    let expandedCount = 0;
    let animationDuration = 0;
    let reporterCount = 0;
    const reporter = (value, depth = 1) => {
      if (depth > 8 || ++reporterCount > 256) throw admissionError('Cooperative reporter limit (256 nodes, depth 8)');
      if (!isObject(value) || !COOPERATIVE_REPORTERS.has(value.type)) {
        throw admissionError(`Unsupported cooperative reporter: ${value?.type}`, 422, 'COOPERATIVE_UNSUPPORTED');
      }
      for (const child of Object.values(value)) {
        if (child !== null && typeof child === 'object') reporter(child, depth + 1);
      }
    };
    const visit = (blocks, depth = 1) => {
      if (!Array.isArray(blocks) || depth > 8 || blocks.length > 256) {
        throw admissionError('Cooperative program must contain arrays of at most 256 blocks, depth 8');
      }
      for (const block of blocks) {
        if (!isObject(block) || typeof block.type !== 'string') throw admissionError('Cooperative block.type is required');
        if (++blockCount > 256) throw admissionError('Cooperative program exceeds 256 blocks');
        const supported = motorControl
          ? Object.hasOwn(controlFields, block.type) ||
            (commandEnvelope && MOTOR_CONTROL_RUNTIME_TYPES.has(block.type))
          : COOPERATIVE_TYPES.has(block.type);
        if (!supported || !Array.isArray(capabilities) || !capabilities.includes(block.type)) {
          throw admissionError(`Unsupported cooperative command: ${block.type}`, 422, 'COOPERATIVE_UNSUPPORTED');
        }
        if (MOTION_TYPES.has(block.type)) {
          if (this.robotStatusMetadata.motion_enabled !== true) {
            throw admissionError('Cooperative motion is disabled', 409, 'COOPERATIVE_MOTION_DISABLED');
          }
          if (this.robotStatusMetadata.armed !== true) {
            throw admissionError('Cooperative motion is not armed', 409, 'COOPERATIVE_NOT_ARMED');
          }
        }
        let params = block;
        if (Object.hasOwn(block, 'params')) {
          if (!isObject(block.params) || Object.hasOwn(block.params, 'type') ||
              Object.keys(block).some(key => !['type', 'params', 'run_id', 'timestamp', '_id'].includes(key))) {
            throw admissionError('Invalid cooperative command params wrapper');
          }
          params = block.params;
        }
        if (motorControl) {
          const fields = controlFields[block.type] || [];
          const envelope = ['type', '_id', 'run_id', ...(commandEnvelope ? ['timestamp'] : [])];
          const allowed = params === block ? [...envelope, ...fields] : fields;
          if (Object.keys(params).some(key => !allowed.includes(key)) ||
              (params !== block && Object.keys(block).some(key => ![...envelope, 'params'].includes(key)))) {
            throw admissionError(`Unknown motor-control ${block.type} parameter`);
          }
          if ((Object.hasOwn(block, '_id') && typeof block._id !== 'string') ||
              (Object.hasOwn(block, 'run_id') && (typeof block.run_id !== 'string' || [...block.run_id].length > 128)) ||
              (Object.hasOwn(block, 'timestamp') && (typeof block.timestamp !== 'number' || !Number.isFinite(block.timestamp)))) {
            throw admissionError('Invalid motor-control command envelope');
          }
          if (block.type === 'display_text' && !Object.hasOwn(params, 'text')) {
            throw admissionError('Motor-control display_text text is required');
          }
          if (block.type === 'set_led' && !Object.hasOwn(params, 'color')) {
            throw admissionError('Motor-control LED color is required');
          }
          if (['servo', 'dc_motor'].includes(block.type)) {
            const ports = block.type === 'servo' ? ['S1', 'S2', 'S3', 'S4'] : ['M1', 'M2', 'M3', 'M4'];
            if (!ports.includes(params.port)) throw admissionError(`Invalid motor-control ${block.type} port`);
          }
        }
        // Literal bounds from RobotEngine._validate or the small build's
        // robot_control.validate. No coercion; omissions keep device defaults.
        const boundedNumber = (key, low, high) => {
          if (Object.hasOwn(params, key) &&
              (typeof params[key] !== 'number' || !Number.isFinite(params[key]) ||
               params[key] < low || params[key] > high)) {
            throw admissionError(`Cooperative ${block.type} ${key} must be a number in ${low}..${high}`);
          }
        };
        if (motorControl) {
          if (['move_forward', 'move_backward', 'dc_motor'].includes(block.type)) {
            const maxPower = capabilities.includes('motor_power_100') ? 100 : 50;
            boundedNumber('speed', block.type === 'dc_motor' ? -maxPower : 0, maxPower);
            boundedNumber('duration', 0, 5);
          }
          if (block.type === 'servo') {
            boundedNumber('angle', 0, 180);
            boundedNumber('speed', 0, 0);
          }
          // Targets stay unchanged on the wire; calibrated firmware maps once at IO.
          if (['turn_left', 'turn_right'].includes(block.type)) {
            if (capabilities.includes('chassis_turn_calibrated_v1')) {
              if (Object.hasOwn(params, 'angle') && (typeof params.angle !== 'number' ||
                  !Number.isFinite(params.angle) || params.angle < 0 || params.angle > 180)) {
                throw admissionError(`Cooperative ${block.type} target angle must be a number in 0..180; stored values are preserved. Explicitly edit incompatible native-angle programs; no automatic scaling, clamping or splitting.`);
              }
            } else {
              boundedNumber('angle', 0, capabilities.includes('turn_angle_360') ? 360 : 30);
            }
          }
        }
        if (avControl) {
          if (block.type === 'play_recording') {
            if (!capabilities.includes('recorded_audio_v1')) throw admissionError('Recording capability unavailable', 422, 'COOPERATIVE_UNSUPPORTED');
            const metadata = this.resolveRecording(params.recording);
            if (params.duration !== metadata.duration_ms / 1000) throw admissionError('Recording duration must match trusted metadata');
          }
          let expanded = 1;
          if (block.type === 'display_animation') {
            if (!Array.isArray(params.frames) || params.frames.length < 1 || params.frames.length > 12 ||
                params.frames.some(frame => typeof frame !== 'string' || [...frame].length > 128)) {
              throw admissionError('AV animation requires 1..12 literal frames of at most 128 characters');
            }
            boundedNumber('interval', 0.15, 2);
            animationDuration += params.frames.length * (params.interval ?? 0.5);
            if (animationDuration > 12) throw admissionError('AV total animation duration exceeds 12 seconds');
            // Firmware expands each frame into display_text + wait. Preserve the
            // original wire blocks and device-reported expanded execution indices.
            expanded = params.frames.length * 2;
          }
          expandedCount += expanded;
          if (expandedCount > 32) throw admissionError('AV program exceeds 32 expanded blocks');
          if (block.type === 'play_tone') {
            boundedNumber('frequency', 100, 2000);
            boundedNumber('duration', 0, 2);
          }
          if (block.type === 'play_sound' && !['hello', 'beeps', 'laugh', 'score'].includes(params.sound)) {
            throw admissionError('Unsupported AV sound');
          }
          if (block.type === 'set_volume' &&
              (!Number.isInteger(params.volume) || params.volume < 0 || params.volume > 60)) {
            throw admissionError('AV volume must be an integer in 0..60');
          }
        }
        if (block.type === 'wait') boundedNumber('duration', 0, 60);
        if (['display_text', 'say'].includes(block.type)) {
          boundedNumber('size', 8, motorControl ? 32 : 64);
          const maxText = motorControl ? 128 : 256;
          if (Object.hasOwn(params, 'text') &&
              (typeof params.text !== 'string' || [...params.text].length > maxText)) {
            throw admissionError(`Cooperative text must be a literal up to ${maxText} characters`);
          }
        }
        if (block.type === 'repeat' && Object.hasOwn(params, 'times') &&
            (!Number.isInteger(params.times) || params.times < 0 || params.times > 50)) {
          throw admissionError('Cooperative repeat times must be an integer in 0..50');
        }
        if (block.type === 'set_led' && Object.hasOwn(params, 'color') &&
            !ledColors.includes(params.color)) {
          throw admissionError('Unsupported cooperative LED color');
        }
        // Small-app fields are literals only, and its programs are flat. The
        // strict field table above rejects all reporter and child-block slots.
        if (motorControl) continue;
        for (const [key, value] of Object.entries(params)) {
          if (['do', 'then', 'else'].includes(key)) visit(value, depth + 1);
          else if (value !== null && typeof value === 'object') reporter(value);
        }
      }
    };
    visit(program);
    if (avControl && !commandEnvelope) {
      // Flat validation remains bounded at 32, even on newer firmware; larger
      // plans enter through the explicit indexed envelope or prepareProgram.
      encodeProgram(program, { profile: LEGACY_PROGRAM_PROFILE,
        runId: '00000000-0000-4000-8000-000000000000', timestamp: Date.now() });
    }
  }

  /**
   * Set the assumed state for a hardware port (after an action is executed)
   */
  setHardwareState(port, state, actionName = null, positionPercent = null) {
    const entry = {
      assumedState: state,
      lastAction: actionName,
      timestamp: Date.now(),
      confidence: 'high', // Just set — confidence starts high
    };
    if (typeof positionPercent === 'number') {
      entry.positionPercent = Math.round(Math.max(0, Math.min(100, positionPercent)));
    }
    this.hardwareStates.set(port, entry);
    const pctInfo = typeof positionPercent === 'number' ? ` (${entry.positionPercent}%)` : '';
    console.log(`🔧 Port ${port} assumed state: "${state}"${pctInfo} (action: ${actionName || 'manual'})`);
  }

  /**
   * Get the assumed state for a specific hardware port
   */
  getHardwareState(port) {
    return this.hardwareStates.get(port) || {
      assumedState: 'unknown',
      lastAction: null,
      timestamp: null,
      confidence: 'none',
      positionPercent: null,
    };
  }

  /**
   * Get all hardware assumed states as a plain object (for AI prompts)
   */
  getHardwareStates() {
    const states = {};
    for (const [port, state] of this.hardwareStates) {
      states[port] = state;
    }
    return states;
  }

  /**
   * Reset all hardware states to "unknown" (e.g., on power cycle)
   */
  resetHardwareStates() {
    this.hardwareStates.clear();
    console.log('🔧 All hardware states reset to unknown');
  }

  /**
   * Initialize assumed states from a robot config (sets all to homeState or "unknown")
   */
  initHardwareStatesFromConfig(config) {
    if (!config?.additions) return;
    for (const addition of config.additions) {
      if (addition.feedbackType === 'none' && !this.hardwareStates.has(addition.port)) {
        // Only initialize if not already tracked
        this.hardwareStates.set(addition.port, {
          assumedState: 'unknown',
          lastAction: null,
          timestamp: Date.now(),
          confidence: 'none',
        });
      }
    }
  }

  /**
   * Home a specific hardware port — set its state to the homeState
   */
  homeHardware(port, homeState) {
    this.hardwareStates.set(port, {
      assumedState: homeState,
      lastAction: 'home',
      timestamp: Date.now(),
      confidence: 'high',
      positionPercent: 0,
    });
    console.log(`🏠 Port ${port} homed to "${homeState}" (0%)`);
  }

  /**
   * Check if the actual robot hardware is online
   * (received a message within the timeout window)
   */
  isRobotOnline() {
    if (!this.robotLastSeen || this.robotState === 'offline') return false;
    return (Date.now() - this.robotLastSeen) < MqttService.ROBOT_TIMEOUT;
  }

  /**
   * Get detailed robot status for the API
   */
  getRobotStatus() {
    this.checkRobotTimeout();
    return {
      ...this.robotStatusMetadata,
      mqttConnected: this.connected,
      robotOnline: this.isRobotOnline(),
      robotState: this.isRobotOnline() ? this.robotState : 'offline',
      robotLastSeen: this.robotLastSeen,
    };
  }
}
