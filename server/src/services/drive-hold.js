import { performance } from 'node:perf_hooks';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = message => { throw Object.assign(new Error(message), { status: 409, code: 'DRIVE_REJECTED' }); };

/** One socket owns a hold; acknowledgements mean submission, not device motion. */
export class DriveHold {
  constructor(mqtt, { now = () => performance.now() } = {}) {
    this.mqtt = mqtt;
    this.now = now;
    this.active = null;
    this.usedIds = new WeakMap();
  }

  submit(owner, message) {
    this.checkLease();
    this.checkStatus();
    if (!['drive_start', 'drive_tap', 'drive_renew', 'drive_stop'].includes(message?.type)) fail('Invalid drive type');
    const op = message.type.slice('drive_'.length);
    const { hold_id } = message;
    const beginsDrive = op === 'start' || op === 'tap';
    const fields = beginsDrive ? ['type', 'hold_id', 'direction', 'speed'] : ['type', 'hold_id'];
    if (typeof hold_id !== 'string' || !UUID.test(hold_id) ||
        Object.keys(message).some(key => !fields.includes(key))) fail('Invalid drive fields or hold_id UUID');
    if (beginsDrive) {
      if (this.active) fail('Drive already owned; release before starting');
      const capabilities = this.mqtt.robotStatusMetadata.capabilities;
      const maxPower = Array.isArray(capabilities) && capabilities.includes('motor_power_100') ? 100 : 50;
      if (!['forward', 'backward', 'left', 'right'].includes(message.direction) ||
          typeof message.speed !== 'number' || !Number.isFinite(message.speed) ||
          message.speed < 0 || message.speed > maxPower) fail(`Drive requires direction and speed in 0..${maxPower}`);
      this.validateStatus();
      if (op === 'tap' && !capabilities.includes('drive_tap')) fail('Drive tap unsupported');
      if (!['ready', 'idle', 'stopped'].includes(this.mqtt.robotState)) fail('Robot is busy or not ready');
      const used = this.usedIds.get(owner) || new Set();
      if (used.has(hold_id)) fail('Hold ID already consumed; use a fresh UUID');
      // Bound memory per connection without permitting evicted IDs to replay.
      if (used.size >= 4096) fail('Drive session limit reached; reconnect before a fresh press');
      used.add(hold_id);
      this.usedIds.set(owner, used);
      this.active = { owner, hold_id, op, speed: message.speed, boot: this.mqtt.robotStatusMetadata.boot };
      this.publish({ op, hold_id, boot: this.active.boot, direction: message.direction, speed: message.speed });
      this.renewLease();
    } else {
      if (!this.active || this.active.owner !== owner || this.active.hold_id !== hold_id) fail('No matching active drive owned by this socket');
      if (op === 'renew' && this.active.op === 'tap') fail('Tap cannot be renewed');
      this.publish({ op, hold_id, boot: this.active.boot });
      if (op === 'stop') this.invalidate('released', false);
      else this.renewLease();
    }
    return { type: 'drive_ack', hold_id, op };
  }

  publish(payload) {
    if (!this.mqtt.connected || !this.mqtt.client?.connected) fail('MQTT offline; drive not queued');
    const active = this.active;
    let submissionError;
    try {
      this.mqtt.publishRecorded(`${this.mqtt.topicPrefix}/robot/drive`, JSON.stringify(payload), error => {
        if (!error) return;
        submissionError = error;
        if (active && this.active === active) this.invalidate('Drive transport failed');
      });
      if (submissionError) throw submissionError;
    } catch (error) {
      this.invalidate('Drive transport failed', payload.op !== 'stop');
      throw error;
    }
  }

  validateStatus() {
    const mqtt = this.mqtt, status = mqtt.robotStatusMetadata;
    if (!mqtt.connected || !mqtt.client?.connected || !mqtt.isRobotOnline() ||
        !mqtt.robotStatusLastSeen || Date.now() - mqtt.robotStatusLastSeen >= mqtt.constructor.ROBOT_TIMEOUT) {
      fail('Robot status is stale or offline');
    }
    if (!mqtt.isCooperativeApp() || status.build !== 'mbot-av-control-v1' ||
        !Array.isArray(status.capabilities) || !status.capabilities.includes('drive_hold')) fail('Drive hold unsupported');
    if (typeof status.boot !== 'string' || !status.boot.trim() || status.boot.length > 128) fail('Drive requires boot identity');
    if (status.armed !== true || status.motion_enabled !== true) fail('Drive motion is disabled or not armed');
  }

  rejectCompetingCommand() {
    if (!this.active) return;
    this.invalidate('Command interrupted drive hold');
    fail('Active drive hold stopped; submit command again after release');
  }

  releaseOwner(owner) {
    if (this.active?.owner === owner) this.invalidate('Drive socket closed or failed');
  }

  renewLease() {
    // Tap is a device-bounded pulse, not a browser-renewed hold. This ceiling
    // includes native start delay; started events never extend ownership.
    const timeout = this.active.op === 'tap' ? 3000 : 500;
    this.active.deadline = this.now() + timeout;
    clearTimeout(this.timer);
    const active = this.active;
    const check = () => {
      if (this.active !== active) return;
      this.checkLease();
      if (this.active === active) {
        this.timer = setTimeout(check, Math.max(1, active.deadline - this.now()));
        this.timer.unref();
      }
    };
    this.timer = setTimeout(check, timeout);
    this.timer.unref();
  }

  checkLease() {
    if (this.active && this.now() >= this.active.deadline) this.invalidate('Drive owner lease expired');
  }

  checkStatus() {
    if (!this.active) return;
    try {
      this.validateStatus();
      if (this.active.boot !== this.mqtt.robotStatusMetadata.boot) fail('Robot boot changed');
      const caps = this.mqtt.robotStatusMetadata.capabilities;
      if (this.active.op === 'tap' && !caps.includes('drive_tap')) fail('Drive tap unsupported');
      if (this.active.speed > 50 && !caps.includes('motor_power_100')) fail('Motor power capability changed');
    } catch (error) { this.invalidate(error.message); }
  }

  deviceStatus(data) {
    if (this.active && data?.hold_id === this.active.hold_id && data.boot === this.active.boot &&
        ['rejected', 'stopped'].includes(data.event)) this.invalidate('Device ended drive hold');
  }

  invalidate(reason, stop = true) {
    const active = this.active;
    this.active = null;
    clearTimeout(this.timer);
    if (active && stop && this.mqtt.connected && this.mqtt.client?.connected) {
      try { this.publish({ op: 'stop', hold_id: active.hold_id, boot: active.boot }); }
      catch { /* Local ownership stays revoked; the device lease is the fallback. */ }
    }
  }
}
