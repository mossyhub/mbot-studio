# Isolated editor fixtures

Sanitized snapshot of the pre-recorded-audio AV runtime contract and S1 arm / M1 claw configuration used in the editor acceptance audit. Retains the original ports, directions, values and action names needed by the regressions. Omits device/build digest identities, boot IDs, timestamps, notes, addresses and credentials. These are test inputs, not current robot-state claims or permission to run hardware.

Run `npx playwright test --config tests/editor-isolated.config.mjs` after installing the project's Playwright Chromium. Optional `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` selects a locally installed browser. No external fixture path, application server or MQTT global setup is used. Every HTTP and WebSocket request in these tests is intercepted.
