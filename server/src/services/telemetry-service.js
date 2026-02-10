/**
 * Telemetry Service — Caches and enriches live robot data
 * Receives raw sensor data from MQTT, computes derived values,
 * and provides structured telemetry for the UI.
 */

export class TelemetryService {
  static instance = null;

  // Latest raw sensor snapshot from the robot
  latestSensors = null;
  sensorTimestamp = null;

  // Derived/computed values
  batteryHistory = [];       // last N battery readings for trend
  distanceHistory = [];      // last N distance readings for sparkline
  gyroHistory = [];          // last N gyro readings for orientation display

  // Limits for history arrays
  static MAX_HISTORY = 60;   // ~60 seconds of data at 1Hz

  // Alerts / thresholds
  alerts = [];
  static BATTERY_LOW = 20;
  static BATTERY_CRITICAL = 10;
  static OBSTACLE_CLOSE = 15;  // cm

  static getInstance() {
    if (!TelemetryService.instance) {
      TelemetryService.instance = new TelemetryService();
    }
    return TelemetryService.instance;
  }

  /**
   * Process an incoming sensor snapshot from the robot
   */
  updateSensors(sensorData) {
    this.latestSensors = sensorData;
    this.sensorTimestamp = Date.now();

    // Push histories
    if (sensorData.battery !== undefined && sensorData.battery >= 0) {
      this.batteryHistory.push({ value: sensorData.battery, time: this.sensorTimestamp });
      if (this.batteryHistory.length > TelemetryService.MAX_HISTORY) this.batteryHistory.shift();
    }

    if (sensorData.distance !== undefined && sensorData.distance >= 0) {
      this.distanceHistory.push({ value: sensorData.distance, time: this.sensorTimestamp });
      if (this.distanceHistory.length > TelemetryService.MAX_HISTORY) this.distanceHistory.shift();
    }

    if (sensorData.gyro_z !== undefined) {
      this.gyroHistory.push({ x: sensorData.gyro_x, y: sensorData.gyro_y, z: sensorData.gyro_z, time: this.sensorTimestamp });
      if (this.gyroHistory.length > TelemetryService.MAX_HISTORY) this.gyroHistory.shift();
    }

    // Compute alerts
    this.computeAlerts(sensorData);
  }

  /**
   * Check for alert conditions
   */
  computeAlerts(data) {
    const newAlerts = [];

    if (data.battery !== undefined && data.battery >= 0) {
      if (data.battery <= TelemetryService.BATTERY_CRITICAL) {
        newAlerts.push({ type: 'critical', category: 'battery', message: `Battery critical: ${data.battery}%`, icon: '🪫' });
      } else if (data.battery <= TelemetryService.BATTERY_LOW) {
        newAlerts.push({ type: 'warning', category: 'battery', message: `Battery low: ${data.battery}%`, icon: '🔋' });
      }
    }

    if (data.distance !== undefined && data.distance >= 0 && data.distance < TelemetryService.OBSTACLE_CLOSE) {
      newAlerts.push({ type: 'warning', category: 'obstacle', message: `Object nearby: ${data.distance}cm`, icon: '⚠️' });
    }

    if (data.is_shaking) {
      newAlerts.push({ type: 'info', category: 'motion', message: 'Robot is shaking!', icon: '📳' });
    }

    this.alerts = newAlerts;
  }

  /**
   * Get full telemetry payload for the UI
   */
  getTelemetry() {
    const sensors = this.latestSensors || {};
    const age = this.sensorTimestamp ? Date.now() - this.sensorTimestamp : null;
    const stale = age !== null && age > 10000; // >10s = stale

    return {
      // Timestamp info
      timestamp: this.sensorTimestamp,
      age,
      stale,

      // === Sensors ===
      sensors: {
        // Navigation
        distance: sensors.distance ?? null,
        line_left: sensors.line_left ?? null,
        line_right: sensors.line_right ?? null,
        color: sensors.color ?? null,

        // IMU / Orientation
        gyro_x: sensors.gyro_x ?? null,
        gyro_y: sensors.gyro_y ?? null,
        gyro_z: sensors.gyro_z ?? null,
        accel_x: sensors.accel_x ?? null,
        accel_y: sensors.accel_y ?? null,
        accel_z: sensors.accel_z ?? null,

        // Motion detection
        is_shaking: sensors.is_shaking ?? false,
        shake_strength: sensors.shake_strength ?? 0,
        tilt_left: sensors.tilt_left ?? false,
        tilt_right: sensors.tilt_right ?? false,
        tilt_forward: sensors.tilt_forward ?? false,
        tilt_backward: sensors.tilt_backward ?? false,
        face_up: sensors.face_up ?? true,

        // Environment
        loudness: sensors.loudness ?? null,
        brightness: sensors.brightness ?? null,

        // System
        battery: sensors.battery ?? null,
        timer: sensors.timer ?? null,
        button_a: sensors.button_a ?? false,
        button_b: sensors.button_b ?? false,
      },

      // === Actuator states ===
      actuators: {
        servos: sensors.servos || {},
        motors: sensors.motors || {},
      },

      // === Alerts ===
      alerts: this.alerts,

      // === History (for sparklines/trends) ===
      history: {
        battery: this.batteryHistory.slice(-20).map(h => h.value),
        distance: this.distanceHistory.slice(-20).map(h => h.value),
      },
    };
  }

  /**
   * Reset all cached data
   */
  reset() {
    this.latestSensors = null;
    this.sensorTimestamp = null;
    this.batteryHistory = [];
    this.distanceHistory = [];
    this.gyroHistory = [];
    this.alerts = [];
  }
}
