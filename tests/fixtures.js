/**
 * Playwright fixtures — extends the base test with:
 *   - `simulator`: a fresh RobotSimulator connected to the shared MQTT broker
 *   - `useRealAI`: boolean indicating if real AI credentials are available
 *
 * Tests can use `test.skip(!useRealAI, 'needs real AI')` for AI-dependent tests.
 */
import { test as base } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { RobotSimulator } from './robot-simulator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readHarnessState() {
  try {
    const stateFile = path.resolve(__dirname, '.harness-state.json');
    return JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  } catch {
    return { useRealAI: false };
  }
}

export const test = base.extend({
  simulator: async ({}, use) => {
    const sim = new RobotSimulator('mqtt://127.0.0.1:18830', 'mbot-studio');
    await sim.connect();
    await use(sim);
    await sim.disconnect();
  },

  useRealAI: async ({}, use) => {
    await use(readHarnessState().useRealAI);
  },
});

export { expect } from '@playwright/test';
