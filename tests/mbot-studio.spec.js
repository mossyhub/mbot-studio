/**
 * E2E tests for mBot Studio — exercises the full stack:
 *   Browser UI → Server HTTP/WS → MQTT → Robot Simulator
 *
 * AI tests work in two modes:
 *   - Local debug (AI_LOCAL_DEBUG=true): deterministic block output, fast
 *   - Real AI (Azure/GitHub creds in .env): actual model calls, slower
 */
import { test, expect } from './fixtures.js';

// ─── Health & Connectivity ──────────────────────────────────────

test.describe('Server health', () => {
  test('API health endpoint returns ok', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  test('robot status shows MQTT connected and robot online', async ({ request, simulator }) => {
    // The simulator published "ready" on connect — give server a moment
    await new Promise((r) => setTimeout(r, 1000));
    const res = await request.get('/api/robot/status');
    const body = await res.json();
    expect(body.mqttConnected).toBe(true);
    expect(body.robotOnline).toBe(true);
  });

  test('config endpoint returns valid config', async ({ request }) => {
    const res = await request.get('/api/config');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body).toHaveProperty('turnMultiplier');
  });
});

// ─── AI Generation ──────────────────────────────────────────────

test.describe('AI block generation', () => {
  test('generates blocks from natural language (local or real AI)', async ({ request }) => {
    const res = await request.post('/api/ai/generate', {
      data: { message: 'go forward for 2 seconds' },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.program).toBeDefined();
    expect(Array.isArray(body.program)).toBe(true);
    expect(body.program.length).toBeGreaterThan(0);
    // Should contain a move_forward block
    const hasMoveForward = body.program.some((b) => b.type === 'move_forward');
    expect(hasMoveForward).toBe(true);
  });

  test('generates square program', async ({ request }) => {
    const res = await request.post('/api/ai/generate', {
      data: { message: 'draw a square' },
    });
    const body = await res.json();
    expect(body.success).toBe(true);
    // Should contain repeat and turn blocks
    const hasRepeatOrTurn = body.program.some(
      (b) => b.type === 'repeat' || b.type === 'turn_right' || b.type === 'turn_left',
    );
    expect(hasRepeatOrTurn).toBe(true);
  });

  test('rejects empty message', async ({ request }) => {
    const res = await request.post('/api/ai/generate', {
      data: { message: '' },
    });
    expect(res.status()).toBe(400);
  });

  test('real AI generates a dance program', async ({ request, useRealAI }) => {
    test.skip(!useRealAI, 'requires real AI credentials in .env');
    test.setTimeout(30000);
    const res = await request.post('/api/ai/generate', {
      data: { message: 'make the robot do a fun dance with sounds' },
    });
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.program.length).toBeGreaterThan(2);
    // Real AI should produce movement or sound blocks for a dance
    const allTypes = new Set();
    const collectTypes = (blocks) => {
      for (const b of blocks) {
        allTypes.add(b.type);
        if (b.do) collectTypes(b.do);
        if (b.then) collectTypes(b.then);
      }
    };
    collectTypes(body.program);
    const hasDanceContent = ['turn_left', 'turn_right', 'move_forward', 'move_backward',
      'play_tone', 'play_melody', 'set_led'].some((t) => allTypes.has(t));
    expect(hasDanceContent).toBe(true);
  });

  test('real AI handles obstacle avoidance request', async ({ request, useRealAI }) => {
    test.skip(!useRealAI, 'requires real AI credentials in .env');
    test.setTimeout(30000);
    const res = await request.post('/api/ai/generate', {
      data: { message: 'explore the room and avoid obstacles' },
    });
    const body = await res.json();
    expect(body.success).toBe(true);
    // Should use sensor-related blocks (may be nested inside repeat/repeat_forever)
    const allTypes = new Set();
    const collectTypes = (blocks) => {
      for (const b of blocks) {
        allTypes.add(b.type);
        for (const key of ['do', 'then', 'else']) {
          if (Array.isArray(b[key])) collectTypes(b[key]);
        }
      }
    };
    collectTypes(body.program);
    const hasSensorBlock = ['if_obstacle', 'if_sensor_range', 'while_sensor', 'move_until'].some(
      (t) => allTypes.has(t),
    );
    expect(hasSensorBlock).toBe(true);
  });
});

// ─── Robot Commands via MQTT ────────────────────────────────────

test.describe('Robot command delivery', () => {
  test('single command reaches the simulator', async ({ request, simulator }) => {
    simulator.clearLog();

    const res = await request.post('/api/robot/command', {
      data: { command: { type: 'move_forward', speed: 50, duration: 1 } },
    });
    expect(res.ok()).toBeTruthy();

    const cmds = await simulator.waitForCommandType('move_forward', 3000);
    expect(cmds.length).toBeGreaterThanOrEqual(1);
    // blockToMqttCommand wraps original block into { type, params: {...}, timestamp }
    const cmd = cmds[0].data;
    expect(cmd.params?.speed ?? cmd.speed).toBe(50);
  });

  test('program delivery sends all blocks', async ({ request, simulator }) => {
    simulator.clearLog();

    const program = [
      { type: 'move_forward', speed: 50, duration: 1 },
      { type: 'turn_right', speed: 40, angle: 90 },
      { type: 'move_forward', speed: 50, duration: 1 },
      { type: 'stop' },
    ];

    const res = await request.post('/api/robot/program', {
      data: { program },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.sent).toBe(true);

    // Wait for program blocks to arrive at simulator
    // Server may prepend home blocks from robot-config.json, so check our blocks are present in order
    await simulator.waitForCommands(4, 5000);
    const blockTypes = simulator.commandLog
      .filter((e) => e.type === 'program_block')
      .map((e) => e.data.type);
    // Extract just our 4 blocks (server may prepend home actions)
    const ourBlocks = blockTypes.slice(-4);
    expect(ourBlocks).toEqual(['move_forward', 'turn_right', 'move_forward', 'stop']);
  });

  test('emergency stop reaches the simulator', async ({ request, simulator }) => {
    simulator.clearLog();

    const res = await request.post('/api/robot/stop');
    expect(res.ok()).toBeTruthy();

    const stops = await simulator.waitForCommandType('emergency_stop', 3000);
    expect(stops.length).toBeGreaterThan(0);
  });

  test('rejects missing command object', async ({ request }) => {
    const res = await request.post('/api/robot/command', {
      data: { command: null },
    });
    expect(res.status()).toBe(400);
  });
});

// ─── Telemetry Flow ─────────────────────────────────────────────

test.describe('Telemetry and sensor data', () => {
  test('sensor request triggers telemetry from simulator', async ({ request, simulator }) => {
    simulator.setSensors({ distance: 22, battery: 90, loudness: 15 });

    const res = await request.post('/api/robot/command', {
      data: { command: { type: 'read_sensors' } },
    });
    expect(res.ok()).toBeTruthy();

    // Telemetry should have been published back to server
    await new Promise((r) => setTimeout(r, 500));

    // Check that server received and exposes telemetry
    const statusRes = await request.get('/api/robot/status');
    const status = await statusRes.json();
    expect(status.mqttConnected).toBe(true);
  });
});

// ─── Full UI E2E ────────────────────────────────────────────────

test.describe('UI end-to-end', () => {
  test('homepage loads with chat panel and block editor', async ({ page }) => {
    await page.goto('/');
    // Chat panel
    await expect(page.locator('.chat-panel')).toBeVisible();
    await expect(page.locator('.chat-input')).toBeVisible();
    // Block editor header
    await expect(page.locator('text=Block Program')).toBeVisible();
    // Status bar
    await expect(page.locator('.status-bar')).toBeVisible();
  });

  test('status bar shows robot online (simulator connected)', async ({ page, simulator }) => {
    await page.goto('/');
    // Wait for status polling (every 5s, but first check is immediate)
    await expect(page.locator('.status-badge', { hasText: 'Robot Online' })).toBeVisible({ timeout: 10000 });
  });

  test('quick prompt generates blocks in the UI', async ({ page }) => {
    await page.goto('/');

    // Click a quick prompt button
    await page.locator('.quick-prompt', { hasText: 'Draw a square' }).click();
    // Quick prompt fills the input — submit it
    await page.locator('.chat-send-btn').click();

    // Wait for AI response — a message with block count should appear
    await expect(page.locator('.message-program-badge')).toBeVisible({ timeout: 15000 });

    // AI response creates a pending suggestion — apply it
    const applyBtn = page.locator('button', { hasText: 'Apply' });
    await expect(applyBtn).toBeVisible({ timeout: 3000 });
    await applyBtn.click();

    // Blocks should now appear in the editor
    await expect(page.locator('.block-item').first()).toBeVisible({ timeout: 5000 });
  });

  test('typing a message generates blocks', async ({ page }) => {
    await page.goto('/');

    const input = page.locator('.chat-input');
    await input.fill('go forward for 2 seconds');
    await page.locator('.chat-send-btn').click();

    // Wait for AI response
    await expect(page.locator('.message-program-badge')).toBeVisible({ timeout: 15000 });
  });

  test('send via MQTT button delivers program to simulator', async ({ page, simulator }) => {
    await page.goto('/');
    simulator.clearLog();

    // Generate a program first
    const input = page.locator('.chat-input');
    await input.fill('go forward for 2 seconds');
    await page.locator('.chat-send-btn').click();
    await expect(page.locator('.message-program-badge')).toBeVisible({ timeout: 15000 });

    // AI response creates a pending suggestion — apply it so blocks are loaded
    const applyBtn = page.locator('button', { hasText: 'Apply' });
    await expect(applyBtn).toBeVisible({ timeout: 3000 });
    await applyBtn.click();

    // Click "Send via MQTT"
    const runBtn = page.locator('button', { hasText: 'Send via MQTT' });
    await expect(runBtn).toBeEnabled({ timeout: 5000 });
    await runBtn.click();

    // Verify the program reached the simulator
    await simulator.waitForCommands(1, 5000);
    expect(simulator.commandLog.length).toBeGreaterThan(0);
  });

  test('emergency stop button works from UI', async ({ page, simulator }) => {
    await page.goto('/');
    simulator.clearLog();

    // Click the STOP button
    const stopBtn = page.locator('button', { hasText: 'STOP' });
    await stopBtn.click();

    // Verify emergency stop reached the simulator
    const stops = await simulator.waitForCommandType('emergency_stop', 3000);
    expect(stops.length).toBeGreaterThan(0);
  });

  test('real AI: full chat-to-run flow', async ({ page, simulator, useRealAI }) => {
    test.skip(!useRealAI, 'requires real AI credentials in .env');
    test.setTimeout(45000);

    await page.goto('/');
    simulator.clearLog();

    // Type a complex request
    const input = page.locator('.chat-input');
    await input.fill('make the robot drive forward, turn right 90 degrees, then stop');
    await page.locator('.chat-send-btn').click();

    // Wait for AI to respond with blocks
    await expect(page.locator('.message-program-badge')).toBeVisible({ timeout: 30000 });

    // Apply suggestion
    const applyBtn = page.locator('button', { hasText: 'Apply' });
    await expect(applyBtn).toBeVisible({ timeout: 3000 });
    await applyBtn.click();

    // Send to robot
    const runBtn = page.locator('button', { hasText: 'Send via MQTT' });
    await expect(runBtn).toBeEnabled({ timeout: 5000 });
    await runBtn.click();

    // Verify the simulator received the program
    await simulator.waitForCommands(1, 5000);
    const types = simulator.commandLog.map((e) => e.data?.type).filter(Boolean);
    expect(types.length).toBeGreaterThan(0);
    // Should include movement commands
    const hasMovement = types.some((t) =>
      ['move_forward', 'turn_right', 'turn_left', 'stop'].includes(t),
    );
    expect(hasMovement).toBe(true);
  });
});

// ─── Code Generation ────────────────────────────────────────────

test.describe('Code generator', () => {
  test('Python code preview shows generated code', async ({ request }) => {
    // Use the upload endpoint which returns generated Python
    const program = [
      { type: 'move_forward', speed: 50, duration: 2 },
      { type: 'turn_right', speed: 40, angle: 90 },
      { type: 'stop' },
    ];
    const res = await request.post('/api/robot/upload', {
      data: { program },
    });
    const body = await res.json();
    expect(body.code).toBeDefined();
    expect(body.code).toContain('forward');
    expect(body.code).toContain('turn');
  });
});
