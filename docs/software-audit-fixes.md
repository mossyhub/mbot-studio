# Software audit fixes

This change addresses reproducible browser/backend defects without changing the robot firmware.

## Changes

- Live Control's **Go!** button sends the typed command, like Enter.
- Leaving Live Control cancels pending AI work. A late response from that abandoned request cannot submit a movement program after STOP on another tab. Cancellation cannot retract commands already delivered to the broker or robot.
- Unapplied AI suggestions no longer replace the current project's Python preview.
- Dragging statement blocks between disconnected scripts applies removal and insertion together, before empty scripts are removed, so a shifted destination index cannot lose the block.
- An explicitly empty hardware configuration remains empty instead of restoring default claw servos.
- Explicit zero servo angles and zero motor test speed/duration are preserved.
- `ENABLE_REPL=false` also blocks the HTTP REPL endpoint.
- Malformed configuration containers are rejected before persistence; valid extension metadata is preserved.
- Firmware settings are inserted literally, including dollar signs, quotes, backslashes, and line breaks. This changes bundle generation, not the installed firmware.
- An explicit `offline` status is reported as offline rather than refreshing the online flag.
- Generated Python handles comment-only nested suites, literal string reporter operands, negative floor, and reporters in servo-angle/display-text/display-size slots correctly.
- Docker's health check uses IPv4 loopback, matching the server's default bind address.

## Tests and build

Development requires Node.js 20+ and Python 3 (`python3`) for generated-source checks.

```sh
npm ci
npm run test:unit
npx playwright install chromium
npm run test:local
```

`test:local` forces deterministic offline AI. Playwright's test harness starts an isolated broker/simulator, uses temporary configuration storage, and rebuilds the frontend before testing. The simulator is not CyberPi firmware. Unit tests use real server modules and an isolated local broker, or parse/compile generated Python and evaluate only whitelisted hardware-free expressions.

A custom installed Chromium can be selected with `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. Normally Playwright uses its own browser installation. GitHub runs both test suites before publishing the Docker image.

## Known limitations left unchanged

- Disconnected scripts still use shared browser storage rather than project/profile-scoped storage. Correcting this needs a deliberate persistence/migration design.
- Motor-position planning still has automatic-homing and conditional-branch state problems. Standalone position generation and return-action durations also need separate work.
- Turn calibration is inconsistent across transports and nested programs.
- Structured telemetry does not yet map the firmware's heading/line-status fields.
- Generated Python still has problems with `stop this script`, variable keywords/name collisions, and reporter inputs to `set_speed`. The latter needs a decision about preserving independent motor semantics, not a guessed rewrite.
- Additional malformed block/source-generation edge cases remain; this is not a complete compiler validation or security overhaul.
- No robot motion, sensor values, physical calibration, Wi-Fi connectivity, USB/mLink flashing, or emergency braking is certified by these software tests. No firmware file is changed by this release.
