import mqtt from 'mqtt';
import { randomUUID } from 'node:crypto';

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

  async connect() {
    const brokerUrl = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';

    return new Promise((resolve, reject) => {
      this.client = mqtt.connect(brokerUrl, {
        clientId: `mbot-studio-server-${Date.now()}`,
        clean: true,
        connectTimeout: 5000,
        reconnectPeriod: 5000,
      });

      this.client.on('connect', () => {
        this.connected = true;
        console.log(`📡 Connected to MQTT broker at ${brokerUrl}`);

        // Subscribe to robot status topics
        this.client.subscribe(`${this.topicPrefix}/robot/status`);
        this.client.subscribe(`${this.topicPrefix}/robot/sensors`);
        this.client.subscribe(`${this.topicPrefix}/robot/log`);
        this.client.subscribe(`${this.topicPrefix}/robot/repl/result`);
        this.client.subscribe(`${this.topicPrefix}/robot/execution`);

        resolve();
      });

      this.client.on('message', (topic, message) => {
        const shortTopic = topic.replace(`${this.topicPrefix}/`, '');
        const payload = message.toString();

        // Track robot presence — any message from the robot means it's alive
        if (shortTopic === 'robot/status' || shortTopic === 'robot/sensors' || shortTopic === 'robot/log' || shortTopic === 'robot/repl/result') {
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
                for (const key of ['capabilities', 'motion_enabled', 'armed', 'self_managed_homing', 'build', 'boot', 'sha256', 'device']) {
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
        reject(err);
      });

      this.client.on('offline', () => {
        this.connected = false;
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
    if (this.isCooperativeApp() && ['read_sensors', 'status', 'get_status'].includes(command?.type)) {
      // Runtime operations, not executable statement capabilities. An empty
      // program admission still enforces a fresh, online cooperative status.
      this.validateCooperativeProgram([]);
    } else {
      this.validateCooperativeProgram([command]);
    }
    if (!this.connected) {
      console.warn('MQTT not connected, command not sent');
      return false;
    }

    const topic = `${this.topicPrefix}/robot/command`;
    const payload = JSON.stringify(this.isCooperativeApp()
      ? { ...command, run_id: command.run_id || randomUUID() } : command);
    this.client.publish(topic, payload);
    console.log(`📤 Command sent: ${command.type}`);
    return true;
  }

  /**
   * Send a full program to the robot for autonomous execution
   */
  sendProgram(program, runId = null) {
    this.validateCooperativeProgram(program);
    if (!this.connected) {
      console.warn('MQTT not connected, program not sent');
      return false;
    }

    const topic = `${this.topicPrefix}/robot/program`;
    const payload = JSON.stringify({ program, timestamp: Date.now(),
      ...(this.isCooperativeApp() ? { run_id: runId || randomUUID() } : {}),
    });
    this.client.publish(topic, payload);
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
    this.client.publish(`${this.topicPrefix}/robot/command`, JSON.stringify({ type: 'read_sensors' }));
    return true;
  }

  /**
   * Emergency stop
   */
  emergencyStop() {
    if (!this.connected) return false;
    // Publish to both command and a dedicated emergency topic for priority
    const stopCmd = JSON.stringify({ type: 'emergency_stop',
      ...(this.isCooperativeApp() ? { run_id: randomUUID() } : {}),
    });
    this.client.publish(`${this.topicPrefix}/robot/emergency`, stopCmd);
    this.client.publish(`${this.topicPrefix}/robot/command`, stopCmd);
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

  /** Capability admission only: publishing never proves device execution. */
  validateCooperativeProgram(program) {
    if (!this.isCooperativeApp()) return;
    if (!this.isRobotOnline() || !this.robotStatusLastSeen ||
        Date.now() - this.robotStatusLastSeen >= MqttService.ROBOT_TIMEOUT) {
      throw admissionError('Cooperative robot status is stale or offline', 503, 'COOPERATIVE_OFFLINE');
    }
    const capabilities = this.robotStatusMetadata.capabilities;
    // robot_control.py COLORS differs from the broader RobotEngine palette.
    const ledColors = this.robotStatusMetadata.build === 'mbot-motor-control-v1'
      ? ['red', 'green', 'blue', 'yellow', 'cyan', 'purple', 'white', 'orange', 'off']
      : ['red', 'green', 'blue', 'yellow', 'cyan', 'magenta', 'white', 'off'];
    let blockCount = 0;
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
        if (!COOPERATIVE_TYPES.has(block.type) || !Array.isArray(capabilities) || !capabilities.includes(block.type)) {
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
        // Literal bounds from RobotEngine._validate; no coercion or reporter
        // evaluation here. Omitted fields retain the engine's defaults.
        const boundedNumber = (key, low, high) => {
          if (Object.hasOwn(params, key) &&
              (typeof params[key] !== 'number' || !Number.isFinite(params[key]) ||
               params[key] < low || params[key] > high)) {
            throw admissionError(`Cooperative ${block.type} ${key} must be a number in ${low}..${high}`);
          }
        };
        if (block.type === 'wait') boundedNumber('duration', 0, 60);
        if (['display_text', 'say'].includes(block.type)) {
          boundedNumber('size', 8, 64);
          if (Object.hasOwn(params, 'text') &&
              (typeof params.text !== 'string' || [...params.text].length > 256)) {
            throw admissionError('Cooperative text must be a literal up to 256 characters');
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
        for (const [key, value] of Object.entries(params)) {
          if (['do', 'then', 'else'].includes(key)) visit(value, depth + 1);
          else if (value !== null && typeof value === 'object') reporter(value);
        }
      }
    };
    visit(program);
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
    return {
      ...this.robotStatusMetadata,
      mqttConnected: this.connected,
      robotOnline: this.isRobotOnline(),
      robotState: this.isRobotOnline() ? this.robotState : 'offline',
      robotLastSeen: this.robotLastSeen,
    };
  }
}
