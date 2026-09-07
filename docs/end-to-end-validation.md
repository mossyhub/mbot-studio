# End-to-end validation status

## Verified path

Current application: `firmware/robot_control.py`, built by `tools/build-robot-control.py`. The larger `robot_app.py`/`robot_engine.py` pair is a separate experimental application, not the installed motor runtime.

- Real CyberPi application OTA: transfer, digest verification, trial boot, confirmation and failed-candidate recovery.
- Timed drive motion followed by stopping: device events plus camera displacement observations from the commissioning runs.
- Browser Live Control S1 commands: actual device execution events plus side-camera arm-position changes. This is not calibrated angle feedback.
- Browser Live Control M1 pulses: actual device execution events. A complete physical claw open/close cycle remains unproven.
- Display text: device execution returned successfully, but overhead footage cannot resolve the exact LCD text.
- LED commands through the real web-server API: camera shows red, blue, then off.
- Explicit sensor scan: real battery, ultrasonic distance, microphone loudness, brightness, yaw/pitch/roll, four quad RGB channel values and raw legacy line status arrived without driver errors.
- Browser Refresh sensors: request traversed WebSocket → server → MQTT → CyberPi, and the complete fresh scan returned and rendered in the browser. Tests distinguish a fresh scan from the server's cached snapshot.
- OTA status while a wait runs, emergency cancellation, command-topic Stop priority, rejection of a program with an unsupported suffix before motion, and a subsequent successful program.

Sensor reads are snapshots, not a continuous stream. `sampling: false` marks the end of a scan; the command execution event acknowledges dispatch, not completion of every sensor read. Values are uncalibrated device readings. Raw line status is not a proven mapping of the four-channel floor sensor.

## Not restored by this minimal app

The existing editor is broader than the installed runtime. Unsupported operations are rejected; editor visibility is not a claim of implementation. In particular: left/right turns, free-running differential speed, nested loops/conditions, variable/reporters, arbitrary generated Python, sound/melodies, advanced display effects, and calibrated positional claw actions are not supported by this application. The servo accepts immediate angles, not speed-controlled sweeps.

The user's connected additions are one S1 elbow servo and one M1 DC claw. Unattached S2–S4/M2–M4 ports are not hardware failures. Existing configured claw actions request speed 100 while this commissioned application caps magnitude at 50; those saved actions are not validated by successful low-power pulse dispatch.

## Remaining proof

- Calibrate camera latency, displacement and angle measurements before asserting precise distance/angle.
- Establish mechanical limits and useful DC power for the claw before claiming open/close state; it has no position feedback.
- Restore other blocks incrementally with real native execution and a Stop/OTA regression after each change. Do not call a simulator or compiler pass physical verification.
- Sound APIs discovered by name are not yet proven nonblocking or safe for the cooperative runtime.
- Full web feature inventory is saved in private bench evidence (`feature-matrix.json`); it is a coverage backlog, not a pass report.

## Software gates

Regression tests cover the real HTTP/MQTT boundaries against isolated brokers, firmware state machines against host adapters, generated artifacts, and Playwright UI interactions. Cloud-AI tests are explicitly skipped in the local suite. See the release report for exact-tree counts. Hardware evidence and provisioning files remain outside the repository.
