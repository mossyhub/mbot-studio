# Studio controls and program connection fixes

## Changes

- New My Robot DC action blocks respect the identified AV runtime's -50..50 power bounds. Configured direction is retained. Saved and imported programs are not rewritten; invalid values still require editing and fail validation.
- Live left/right buttons send one native angle-30 command without the unsupported speed field. The requested angle is not a calibrated chassis heading.
- Disconnected editor stacks are explicitly labeled as not running. The readiness message counts disconnected blocks. Connect to program appends the entire chosen stack to the start chain, preserving order and values, without executing it.

## Evidence and limits

Regression-first Chromium tests reproduced invalid claw defaults and live turn payloads, and the misleading empty/ready state for disconnected stacks. The corrected tests cover runtime transitions, imported values, both turn directions, and explicit connection of a multi-block stack.

The full local gate passed 232 Node tests and 122 Chromium tests; 3 cloud-AI browser tests were skipped in local mode. Python suites are invoked by the Node suite. Tests used Node 22, matching CI, and host Chromium; Node 18 cannot load the current MQTT test broker dependency.

On the pre-fix deployed application, eight consecutive nonmoving wait programs submitted from Chromium received matching real-device completion events, without browser errors. This does not rule out intermittent transport faults. The disconnected-stack behavior is reproducible, but is not established as the cause of every reported failed Run. Cameras were unavailable, so command execution events are not physical movement or claw-position proof.
