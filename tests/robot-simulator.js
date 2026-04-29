/**
 * Robot Simulator — a protocol-level mock of an mBot2 on the MQTT bus.
 *
 * Subscribes to command/program/emergency topics, acknowledges with
 * status messages, and publishes fake sensor telemetry.  Records every
 * command received so tests can assert on the sequence.
 */
import mqtt from 'mqtt';

export class RobotSimulator {
  constructor(brokerUrl, topicPrefix = 'mbot-studio') {
    this.brokerUrl = brokerUrl;
    this.prefix = topicPrefix;
    this.client = null;
    this.connected = false;

    /** Every command/program block received, in order */
    this.commandLog = [];
    /** Current simulated sensor values */
    this.sensors = {
      distance: 45,
      line_status: 0,
      battery: 85,
      loudness: 20,
      brightness: 60,
      yaw: 0,
    };
    /** Whether to auto-publish telemetry on an interval */
    this._telemetryInterval = null;
    this._programRunning = false;
  }

  // ── lifecycle ──────────────────────────────────────────────────

  async connect() {
    return new Promise((resolve, reject) => {
      this.client = mqtt.connect(this.brokerUrl, {
        clientId: `mbot2-sim-${Date.now()}`,
        clean: true,
        connectTimeout: 5000,
      });

      this.client.on('connect', () => {
        this.connected = true;
        const subs = [
          `${this.prefix}/robot/command`,
          `${this.prefix}/robot/program`,
          `${this.prefix}/robot/emergency`,
          `${this.prefix}/robot/repl`,
        ];
        this.client.subscribe(subs, () => {
          // Announce ready
          this._publishStatus('ready');
          resolve();
        });
      });

      this.client.on('message', (topic, msg) => this._onMessage(topic, msg));

      this.client.on('error', (err) => {
        this.connected = false;
        reject(err);
      });

      setTimeout(() => {
        if (!this.connected) reject(new Error('Simulator MQTT timeout'));
      }, 5000);
    });
  }

  async disconnect() {
    this.stopTelemetry();
    if (this.client) {
      await new Promise((resolve) => this.client.end(false, {}, resolve));
      this.connected = false;
    }
  }

  // ── incoming message handling ──────────────────────────────────

  _onMessage(topic, msg) {
    const short = topic.replace(`${this.prefix}/`, '');
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      return;
    }

    if (short === 'robot/emergency') {
      this._handleEmergency();
    } else if (short === 'robot/command') {
      if (data.type === 'emergency_stop') {
        this._handleEmergency();
      } else if (data.type === 'read_sensors') {
        this._publishSensors();
      } else if (data.type === 'run_diagnostic') {
        this._handleDiagnostic();
      } else {
        this._handleCommand(data);
      }
    } else if (short === 'robot/program') {
      this._handleProgram(data.program || []);
    } else if (short === 'robot/repl') {
      this._handleRepl(data);
    }
  }

  _handleCommand(cmd) {
    this.commandLog.push({ type: 'command', data: cmd, timestamp: Date.now() });
    this._publishStatus('running');

    // Simulate execution time proportional to command duration/angle
    const delay = this._estimateCommandDuration(cmd);
    setTimeout(() => {
      if (!this._programRunning) {
        this._publishStatus('idle');
      }
    }, delay);
  }

  _handleProgram(blocks) {
    this._programRunning = true;
    this._publishStatus('running');

    // Log each block
    for (const block of blocks) {
      this.commandLog.push({ type: 'program_block', data: block, timestamp: Date.now() });
    }

    // Estimate total program duration
    let totalDelay = 0;
    for (const block of blocks) {
      totalDelay += this._estimateCommandDuration(block);
    }
    // Cap at 5 seconds for test speed
    totalDelay = Math.min(totalDelay, 5000);

    setTimeout(() => {
      this._programRunning = false;
      this._publishStatus('idle');
    }, totalDelay);
  }

  _handleEmergency() {
    this.commandLog.push({ type: 'emergency', data: { type: 'emergency_stop' }, timestamp: Date.now() });
    this._programRunning = false;
    this._publishStatus('stopped');
  }

  _handleRepl(data) {
    this.commandLog.push({ type: 'repl', data, timestamp: Date.now() });
    // Echo a result back
    const result = { id: data.id, output: `[sim] executed ${(data.code || '').length} chars`, error: null };
    this._publish('robot/repl/result', result);
  }

  _handleDiagnostic() {
    this.commandLog.push({ type: 'diagnostic', data: { type: 'run_diagnostic' }, timestamp: Date.now() });
    this._publishLog('Diagnostic: all systems OK (simulated)');
  }

  // ── duration estimation ────────────────────────────────────────

  _estimateCommandDuration(cmd) {
    const t = cmd.type || '';
    if (t === 'move_forward' || t === 'move_backward') {
      return Math.min((cmd.duration || 1) * 200, 2000); // scaled down
    }
    if (t === 'turn_left' || t === 'turn_right') {
      return Math.min((cmd.angle || 90) * 3, 1000);
    }
    if (t === 'wait') {
      return Math.min((cmd.duration || 1) * 200, 2000);
    }
    if (t === 'play_tone') {
      return Math.min((cmd.duration || 0.5) * 200, 1000);
    }
    if (t === 'servo' || t === 'dc_motor') {
      return 200;
    }
    if (t === 'repeat') {
      const times = cmd.times || 1;
      const inner = (cmd.do || []).reduce((sum, b) => sum + this._estimateCommandDuration(b), 0);
      return Math.min(times * inner, 3000);
    }
    return 100; // default
  }

  // ── publishing helpers ─────────────────────────────────────────

  _publish(subtopic, data) {
    if (!this.connected) return;
    this.client.publish(
      `${this.prefix}/${subtopic}`,
      JSON.stringify(data),
    );
  }

  _publishStatus(status) {
    this._publish('robot/status', { status });
  }

  _publishSensors() {
    this._publish('robot/sensors', { ...this.sensors });
  }

  _publishLog(message) {
    this._publish('robot/log', { message, timestamp: Date.now() });
  }

  // ── telemetry streaming ────────────────────────────────────────

  startTelemetry(intervalMs = 1000) {
    this.stopTelemetry();
    this._telemetryInterval = setInterval(() => {
      // Add slight jitter to sensor values for realism
      const jittered = { ...this.sensors };
      jittered.distance = Math.max(0, jittered.distance + (Math.random() - 0.5) * 2);
      jittered.loudness = Math.max(0, jittered.loudness + (Math.random() - 0.5) * 5);
      jittered.brightness = Math.max(0, jittered.brightness + (Math.random() - 0.5) * 3);
      this._publishSensors();
    }, intervalMs);
  }

  stopTelemetry() {
    if (this._telemetryInterval) {
      clearInterval(this._telemetryInterval);
      this._telemetryInterval = null;
    }
  }

  // ── test helpers ───────────────────────────────────────────────

  /** Set one or more sensor values for subsequent reads */
  setSensors(overrides) {
    Object.assign(this.sensors, overrides);
  }

  /** Clear the command log (call between tests) */
  clearLog() {
    this.commandLog = [];
  }

  /** Get only command entries of a specific type */
  getCommands(type) {
    return this.commandLog.filter((e) => e.data?.type === type);
  }

  /** Wait until at least `count` entries exist in the log (up to timeout) */
  async waitForCommands(count, timeoutMs = 5000) {
    const start = Date.now();
    while (this.commandLog.length < count) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timed out waiting for ${count} commands (got ${this.commandLog.length})`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return this.commandLog;
  }

  /** Wait until a command of a specific type appears */
  async waitForCommandType(type, timeoutMs = 5000) {
    const start = Date.now();
    while (!this.commandLog.some((e) => e.data?.type === type)) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timed out waiting for command type "${type}"`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return this.commandLog.filter((e) => e.data?.type === type);
  }
}
