/**
 * Start the test harness as a persistent background service.
 * Usage:
 *   node tests/start-harness.js          # uses real AI if .env has creds
 *   node tests/start-harness.js --local  # force local debug AI
 *
 * Keeps running until Ctrl+C. The Copilot test agent opens a browser
 * against this running instance.
 */
import { TestHarness } from './test-harness.js';

const forceLocal = process.argv.includes('--local');

const harness = new TestHarness({ forceLocalAI: forceLocal });

process.on('SIGINT', async () => {
  console.log('\n[harness] Shutting down...');
  await harness.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await harness.stop();
  process.exit(0);
});

try {
  await harness.start();
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  mBot Studio Test Harness Running                          ║
║                                                            ║
║  Web UI:       http://127.0.0.1:${String(harness.serverPort).padEnd(5)}                     ║
║  API:          http://127.0.0.1:${String(harness.serverPort).padEnd(5)}/api/health           ║
║  WebSocket:    ws://127.0.0.1:${String(harness.serverPort).padEnd(5)}/ws                    ║
║  MQTT broker:  mqtt://127.0.0.1:${String(harness.mqttPort).padEnd(5)}                    ║
║  AI mode:      ${(harness.useRealAI ? 'REAL (Azure/GitHub)' : 'LOCAL DEBUG').padEnd(42)}║
║  Simulator:    Connected (publishing telemetry)            ║
║                                                            ║
║  Press Ctrl+C to stop                                      ║
╚══════════════════════════════════════════════════════════════╝
`);
  // Start periodic telemetry so the UI has data to show
  harness.simulator.startTelemetry(2000);
} catch (err) {
  console.error('[harness] Failed to start:', err.message);
  process.exit(1);
}
