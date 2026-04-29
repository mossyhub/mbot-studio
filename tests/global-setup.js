/**
 * Playwright global setup — starts the test harness (MQTT + server + simulator)
 * and builds the frontend so the server can serve it.
 */
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { TestHarness } from './test-harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default async function globalSetup() {
  // Build the frontend so the server can serve it from /
  const publicDir = path.resolve(__dirname, '../server/public');
  const indexHtml = path.join(publicDir, 'index.html');
  if (!fs.existsSync(indexHtml)) {
    console.log('[setup] Building frontend...');
    execSync('npm run build', {
      cwd: path.resolve(__dirname, '../web'),
      stdio: 'inherit',
    });

    // Vite outputs to web/dist by default, copy to server/public
    const distDir = path.resolve(__dirname, '../web/dist');
    if (fs.existsSync(distDir) && !fs.existsSync(publicDir)) {
      fs.cpSync(distDir, publicDir, { recursive: true });
    }
  }

  const harness = new TestHarness();
  await harness.start();

  // Store on globalThis so teardown can access it
  globalThis.__TEST_HARNESS__ = harness;

  // Write AI mode to a temp file so worker processes can read it
  // (globalThis doesn't survive across Playwright's process boundary)
  const stateFile = path.resolve(__dirname, '.harness-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ useRealAI: harness.useRealAI }));
}
