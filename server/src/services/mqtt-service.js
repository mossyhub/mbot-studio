import mqtt from 'mqtt';

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

        resolve();
      });

      this.client.on('message', (topic, message) => {
        const shortTopic = topic.replace(`${this.topicPrefix}/`, '');
        const payload = message.toString();

        // Track robot presence — any message from the robot means it's alive
        if (shortTopic === 'robot/status' || shortTopic === 'robot/sensors' || shortTopic === 'robot/log') {
          this.robotLastSeen = Date.now();
          // Parse robot state from status messages
          if (shortTopic === 'robot/status') {
            try {
              const data = JSON.parse(payload);
              if (data.status) {
                this.robotState = data.status;
                console.log(`🤖 Robot state: ${data.status}`);
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
    if (!this.connected) {
      console.warn('MQTT not connected, command not sent');
      return false;
    }

    const topic = `${this.topicPrefix}/robot/command`;
    const payload = JSON.stringify(command);
    this.client.publish(topic, payload);
    console.log(`📤 Command sent: ${command.type}`);
    return true;
  }

  /**
   * Send a full program to the robot for autonomous execution
   */
  sendProgram(program) {
    if (!this.connected) {
      console.warn('MQTT not connected, program not sent');
      return false;
    }

    const topic = `${this.topicPrefix}/robot/program`;
    const payload = JSON.stringify({ program, timestamp: Date.now() });
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
   * Request sensor data from the robot
   */
  requestSensors() {
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
    const stopCmd = JSON.stringify({ type: 'emergency_stop' });
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

  /**
   * Set the assumed state for a hardware port (after an action is executed)
   */
  setHardwareState(port, state, actionName = null) {
    this.hardwareStates.set(port, {
      assumedState: state,
      lastAction: actionName,
      timestamp: Date.now(),
      confidence: 'high', // Just set — confidence starts high
    });
    console.log(`🔧 Port ${port} assumed state: "${state}" (action: ${actionName || 'manual'})`);
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
    });
    console.log(`🏠 Port ${port} homed to "${homeState}"`);
  }

  /**
   * Check if the actual robot hardware is online
   * (received a message within the timeout window)
   */
  isRobotOnline() {
    if (!this.robotLastSeen) return false;
    return (Date.now() - this.robotLastSeen) < MqttService.ROBOT_TIMEOUT;
  }

  /**
   * Get detailed robot status for the API
   */
  getRobotStatus() {
    return {
      mqttConnected: this.connected,
      robotOnline: this.isRobotOnline(),
      robotState: this.isRobotOnline() ? this.robotState : 'offline',
      robotLastSeen: this.robotLastSeen,
    };
  }
}
