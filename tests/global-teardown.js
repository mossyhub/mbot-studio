/**
 * Playwright global teardown — stops the test harness and cleans up state file.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default async function globalTeardown() {
  if (globalThis.__TEST_HARNESS__) {
    await globalThis.__TEST_HARNESS__.stop();
  }
  // Clean up state file
  const stateFile = path.resolve(__dirname, '.harness-state.json');
  try { fs.unlinkSync(stateFile); } catch {}
}
