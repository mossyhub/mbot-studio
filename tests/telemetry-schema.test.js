import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelemetryService } from '../server/src/services/telemetry-service.js';

test('keeps actual orientation, quad colors, raw values and sensor errors without synthesizing gyro axes', () => {
  const service = new TelemetryService();
  const raw = {
    yaw: -5, pitch: 0, roll: -7, line_status: 1,
    color: { L1: 'red', L2: 'black', R1: 'white', R2: 'unknown' },
    color_L1: 'red', color_L2: 'black', color_R1: 'white', color_R2: 'unknown',
    errors: { distance: 'vendor read failed', line_status: { code: 'unsupported' } },
    sampling: true, quad_methods: ['get_color'],
  };
  service.updateSensors(raw);
  const result = service.getTelemetry();
  for (const [key, value] of Object.entries(raw)) assert.deepEqual(result.sensors[key], value, key);
  for (const axis of ['x', 'y', 'z']) assert.equal(result.sensors[`gyro_${axis}`], null);
  assert.deepEqual(service.gyroHistory, []);
  assert.deepEqual(result.history.distance, []);
});

test('next snapshot does not carry forward readings or errors missing from that scan', () => {
  const service = new TelemetryService();
  service.updateSensors({ yaw: 24, color: { L1: 'red' }, errors: { distance: 'failed' } });
  service.updateSensors({ battery: 42 });
  const result = service.getTelemetry();
  assert.equal(result.sensors.yaw ?? null, null);
  assert.equal(result.sensors.color, null);
  assert.equal(result.sensors.errors, undefined);
  assert.equal(result.sensors.battery, 42);
});
