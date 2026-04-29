import { Router } from 'express';
import { MqttService } from '../services/mqtt-service.js';
import { TelemetryService } from '../services/telemetry-service.js';
import { blocksToMicroPython, blockToMqttCommand, resolveDcMotorPosition, positionPercentToStateName } from '../services/code-generator.js';
import { loadConfig } from './config.js';
import { validateBlocks, validateCommand } from '../services/validation.js';

export const robotRoutes = Router();

/**
 * Recursively resolve dc_motor_position blocks in a block tree to concrete dc_motor commands.
 * Tracks position per-port so sequential moves within a program accumulate correctly.
 * Updates MQTT hardware state for the final position of each port.
 */
function resolvePositionBlocks(blocks, robotConfig, mqtt, positionTracker) {
  return blocks.map(block => {
    // Recurse into nested block arrays (repeat, if_obstacle, etc.)
    const resolved = { ...block };
    for (const key of ['do', 'then', 'else']) {
      if (Array.isArray(resolved[key])) {
        resolved[key] = resolvePositionBlocks(resolved[key], robotConfig, mqtt, positionTracker);
      }
    }

    if (resolved.type !== 'dc_motor_position') return resolved;

    const port = resolved.port;
    // Get current tracked position: check our local tracker first, then MQTT state
    let currentPct = positionTracker[port];
    if (typeof currentPct !== 'number') {
      const hwState = mqtt.getHardwareState(port);
      currentPct = typeof hwState.positionPercent === 'number' ? hwState.positionPercent : 0;
    }

    const result = resolveDcMotorPosition(resolved, robotConfig, currentPct);
    if (!result || result.duration <= 0) {
      // Already at target — emit a no-op wait instead of skipping (preserves block count)
      return { type: 'wait', duration: 0.01 };
    }

    const targetPct = Math.max(0, Math.min(100, Number(resolved.position ?? 0)));
    positionTracker[port] = targetPct;

    // Update MQTT hardware state
    const stateName = positionPercentToStateName(port, targetPct, robotConfig);
    mqtt.setHardwareState(port, stateName, `position_${targetPct}%`, targetPct);

    return { type: 'dc_motor', port: result.port, speed: result.speed, duration: result.duration };
  });
}

/**
 * POST /api/robot/command
 * Send a single command to the robot (live mode)
 */
robotRoutes.post('/command', (req, res) => {
  const { command } = req.body;
  const mqtt = MqttService.getInstance();

  const commandValidation = validateCommand(command);
  if (!commandValidation.ok) {
    return res.status(400).json({ error: commandValidation.error });
  }

  if (!mqtt.isConnected()) {
    return res.status(503).json({
      error: 'Robot not connected',
      hint: 'Make sure MQTT broker is running and robot is connected to WiFi',
    });
  }

  let cmd = commandValidation.value;

  // Resolve dc_motor_position to a concrete dc_motor command using tracked state
  if (cmd.type === 'dc_motor_position') {
    const robotConfig = loadConfig();
    const hwState = mqtt.getHardwareState(cmd.port);
    const currentPct = typeof hwState.positionPercent === 'number' ? hwState.positionPercent : 0;
    const resolved = resolveDcMotorPosition(cmd, robotConfig, currentPct);
    if (!resolved || resolved.duration <= 0) {
      return res.json({ sent: false, info: 'Already at target position' });
    }
    const targetPct = Math.max(0, Math.min(100, Number(cmd.position ?? 0)));
    cmd = { type: 'dc_motor', port: resolved.port, speed: resolved.speed, duration: resolved.duration };
    // Update tracked state
    const stateName = positionPercentToStateName(resolved.port, targetPct, robotConfig);
    mqtt.setHardwareState(resolved.port, stateName, `position_${targetPct}%`, targetPct);
  }

  const mqttCmd = blockToMqttCommand(cmd);
  const sent = mqtt.sendCommand(mqttCmd);

  res.json({ sent, command: mqttCmd });
});

/**
 * POST /api/robot/program
 * Send a full program to the robot for execution
 */
robotRoutes.post('/program', (req, res) => {
  const { program } = req.body;
  const mqtt = MqttService.getInstance();

  const programValidation = validateBlocks(program, 'program');
  if (!programValidation.ok) {
    return res.status(400).json({ error: programValidation.error });
  }

  if (!mqtt.isConnected()) {
    return res.status(503).json({
      error: 'Robot not connected',
      hint: 'Make sure MQTT broker is running and robot is connected to WiFi',
    });
  }

  // Prepend home actions for hardware with homeState
  let finalProgram = programValidation.value;
  try {
    const robotConfig = loadConfig();
    if (robotConfig?.additions?.length) {
      const homeBlocks = [];
      for (const hw of robotConfig.additions) {
        if (!hw.homeState || !hw.actions) continue;
        const homeAction = hw.actions.find(a => a.targetState === hw.homeState);
        if (!homeAction) continue;
        if (hw.type === 'servo') {
          homeBlocks.push({ type: 'servo', port: hw.port, angle: homeAction.angle ?? 90 });
        } else if (hw.type === 'dc_motor') {
          const dir = homeAction.motorDirection || 'forward';
          const spd = homeAction.speed || 50;
          homeBlocks.push({ type: 'dc_motor', port: hw.port, speed: dir === 'reverse' ? -spd : spd, duration: homeAction.duration || 1 });
        }
      }
      if (homeBlocks.length > 0) {
        finalProgram = [...homeBlocks, ...finalProgram];
      }
    }

    // Apply turn multiplier from config (converts body degrees → encoder degrees)
    const turnMult = robotConfig?.turnMultiplier || 1;
    if (turnMult !== 1) {
      finalProgram = finalProgram.map(block => {
        if ((block.type === 'turn_left' || block.type === 'turn_right') && block.angle) {
          return { ...block, angle: Math.round(block.angle * turnMult) };
        }
        return block;
      });
    }

    // Resolve dc_motor_position blocks to concrete dc_motor commands.
    // Track position per-port through the program so sequential moves accumulate correctly.
    const positionTracker = {};
    finalProgram = resolvePositionBlocks(finalProgram, robotConfig, mqtt, positionTracker);
  } catch { /* ignore config errors */ }

  const sent = mqtt.sendProgram(finalProgram);
  res.json({ sent, blockCount: finalProgram.length });
});

/**
 * POST /api/robot/upload
 * Generate MicroPython code and send it to the robot for standalone execution
 */
robotRoutes.post('/upload', (req, res) => {
  const { program } = req.body;
  const programValidation = validateBlocks(program, 'program');
  if (!programValidation.ok) {
    return res.status(400).json({ error: programValidation.error });
  }
  const robotConfig = loadConfig();
  const code = blocksToMicroPython(programValidation.value, robotConfig);
  const mqtt = MqttService.getInstance();

  if (!mqtt.isConnected()) {
    // Return the code even if robot isn't connected (user can copy it)
    return res.json({
      uploaded: false,
      code,
      hint: 'Robot not connected. You can copy this code and upload it manually via mBlock.',
    });
  }

  // Send the generated code to the robot
  mqtt.sendCommand({ type: 'upload_code', code });

  res.json({ uploaded: true, code });
});

/**
 * POST /api/robot/stop
 * Emergency stop
 */
robotRoutes.post('/stop', (req, res) => {
  const mqtt = MqttService.getInstance();
  mqtt.emergencyStop();
  res.json({ stopped: true });
});

/**
 * GET /api/robot/status
 * Get robot connection status — distinguishes broker connection from actual robot presence
 */
robotRoutes.get('/status', (req, res) => {
  const mqtt = MqttService.getInstance();
  res.json(mqtt.getRobotStatus());
});

/**
 * GET /api/robot/hardware-state
 * Get assumed state for all tracked hardware ports
 */
robotRoutes.get('/hardware-state', (req, res) => {
  const mqtt = MqttService.getInstance();
  res.json({ states: mqtt.getHardwareStates() });
});

/**
 * POST /api/robot/hardware-state/reset
 * Reset all hardware states to "unknown"
 */
robotRoutes.post('/hardware-state/reset', (req, res) => {
  const mqtt = MqttService.getInstance();
  mqtt.resetHardwareStates();
  res.json({ success: true });
});

/**
 * POST /api/robot/hardware-state/home
 * Home a specific hardware port — run the home action and set assumed state
 */
robotRoutes.post('/hardware-state/home', (req, res) => {
  const { port, homeState, homeAction } = req.body;

  if (!port || typeof port !== 'string') {
    return res.status(400).json({ error: 'port is required and must be a string' });
  }
  if (!homeState || typeof homeState !== 'string') {
    return res.status(400).json({ error: 'homeState is required and must be a string' });
  }

  const mqtt = MqttService.getInstance();

  // If a home action command was provided, send it to the robot
  if (homeAction && mqtt.isConnected()) {
    mqtt.sendCommand(homeAction);
  }

  // Set the assumed state
  mqtt.homeHardware(port, homeState);
  res.json({ success: true, port, state: homeState });
});

/**
 * POST /api/robot/test-action
 * Execute a test action on a hardware port and update assumed state
 */
robotRoutes.post('/test-action', (req, res) => {
  const { port, action, type } = req.body;

  if (!port || typeof port !== 'string') {
    return res.status(400).json({ error: 'port is required and must be a string' });
  }
  if (!action || typeof action !== 'object') {
    return res.status(400).json({ error: 'action is required and must be an object' });
  }
  if (!type || (type !== 'servo' && type !== 'dc_motor')) {
    return res.status(400).json({ error: 'type must be "servo" or "dc_motor"' });
  }

  const mqtt = MqttService.getInstance();

  if (!mqtt.isConnected()) {
    return res.status(503).json({
      error: 'Robot not connected',
      hint: 'Make sure MQTT broker is running and robot is connected to WiFi',
    });
  }

  // Build the motor command from the action definition
  let command;
  if (type === 'servo') {
    command = { type: 'servo', port, angle: action.angle || 90 };
  } else {
    // DC motor — translate direction + speed into signed speed
    const dir = action.motorDirection || 'forward';
    const speed = action.speed || 50;
    const signedSpeed = dir === 'reverse' ? -speed : speed;
    command = { type: 'dc_motor', port, speed: signedSpeed, duration: action.duration || 1 };
  }

  const sent = mqtt.sendCommand(command);

  // Update assumed state if the action has a targetState
  if (sent && action.targetState) {
    // For DC motors, determine position percentage from the action's target state
    let positionPct = null;
    if (type === 'dc_motor') {
      const robotConfig = loadConfig();
      const hw = robotConfig?.additions?.find(a => a.port === port && a.type === 'dc_motor');
      if (hw?.homeState) {
        positionPct = action.targetState === hw.homeState ? 0 : 100;
      }
    }
    mqtt.setHardwareState(port, action.targetState, action.name, positionPct);
  }

  res.json({ sent, command, newState: action.targetState || null });
});

/**
 * POST /api/robot/repl
 * Send code to the robot's remote REPL for execution
 */
robotRoutes.post('/repl', (req, res) => {
  const { code, id } = req.body;
  const mqtt = MqttService.getInstance();

  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'Missing "code" field' });
  }

  if (!mqtt.isConnected()) {
    return res.status(503).json({ error: 'Robot not connected' });
  }

  const replId = id || `repl_${Date.now()}`;
  const sent = mqtt.sendRepl(code, replId);
  res.json({ sent, id: replId });
});

/**
 * POST /api/robot/diagnostic
 * Run motor diagnostic on the robot
 */
robotRoutes.post('/diagnostic', (req, res) => {
  const mqtt = MqttService.getInstance();

  if (!mqtt.isConnected()) {
    return res.status(503).json({ error: 'Robot not connected' });
  }

  const sent = mqtt.sendDiagnostic();
  res.json({ sent, message: 'Diagnostic started. Watch robot/log for results.' });
});

/**
 * GET /api/robot/telemetry
 * Get the latest enriched telemetry data (sensors, alerts, history)
 */
robotRoutes.get('/telemetry', (req, res) => {
  const telemetry = TelemetryService.getInstance();
  res.json(telemetry.getTelemetry());
});

/**
 * POST /api/robot/telemetry/reset
 * Reset telemetry history and caches
 */
robotRoutes.post('/telemetry/reset', (req, res) => {
  const telemetry = TelemetryService.getInstance();
  telemetry.reset();
  res.json({ success: true });
});
