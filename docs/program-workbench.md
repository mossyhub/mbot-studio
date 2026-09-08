# Program workbench

Program is a block-building workspace first. The AI helper can be opened when needed without discarding the current program. Run and emergency Stop remain visible; Python is explicitly labeled a source preview, not the payload sent by Run.

## Connected AV robot

The audited catalog contains 73 unique block types. The Robot-ready subset contains 35 types: 15 native action types plus 20 server-lowered control/reporter/alias types. This count measures supported block grammar with valid parameters, not 35 independent physical tests.

For `mbot-av-control-v1`, the library uses the installed command bounds and a Robot-ready filter. All blocks remain available for inspection/editing; visibility is not a promise of runtime support. Saved values are not silently clamped or discarded. Unsupported imported blocks are reported by read-only whole-program preflight before Run.

The server can lower finite repeat loops, numeric variables, supported arithmetic/comparison/boolean expressions, and statically decidable if/else into the installed robot's flat command sequence. This is compile-time processing, not a new device interpreter. Variables must be initialized and cannot read live sensors. `say` lowers to a centered LCD label, not spoken speech. Both branches are validated before publication, including unselected branches and zero-repeat bodies. Source must fit 256 nodes/depth 8, repeat counts 0–50, at most 256 total iterations and 4096 evaluator steps. Requested timed holds are limited to 120 seconds; native driver overhead is not part of that estimate. Expansion must fit the existing 32-instruction and 8192-byte wire bounds; text animations consume two instructions per frame.

Native actions include timed forward/backward, bounded native turns, attached DC/servo commands, wait, motor/audio stop, text, LED color, volume, tone, supported sound presets, and text-frame animation. Native turn angles are driver requests, not calibrated chassis headings. Audio/turn driver calls may block until return; software Stop cannot preempt a blocked native call.

Dynamic sensor reporters, indefinite loops, independent continuous wheel speeds, and unsupported visual/audio effects are not implemented by this firmware. Use Live Control's explicit Refresh sensors for snapshots; those snapshots are not substituted for Program expressions. Command-only status/sensor requests are not silently promoted to Program statements.

## Interaction fixes

Regression coverage exercises canceled drags, near-target drops, reporter compatibility and occupied sockets, nested operator labels, zoom-correct placement, keyboard block selection, and persistence of connected trees. A canceled drag must not secretly attach to the last highlighted target. Moving a reporter must not overwrite an occupied expression subtree.

## Evidence boundaries

Baseline real-site tests used actual Program palette controls and Run, not direct MQTT injection. Correlated device events confirmed eight completed programs and cancellation of a wait followed by a successful new program. Trials included text/tone/LED output, forward/backward pulses, S1 commands and M1 pulses.

Independent camera evidence shows LCD text changes and arm elevation changes. Recorded audio has a dominant 878.91 Hz peak during the commanded 880 Hz tone window. Low-power claw pulses returning successfully do not establish useful open/close travel or grip strength. Short drive pulse completion is not calibrated displacement. Camera frames and raw execution evidence remain private, outside the repository.

Battery snapshots during this pass reported 70%, then 60%; these are coarse device readings, not a measured discharge curve. Firmware remained the confirmed AV application; these editor/server changes do not require replacing the resident OTA loader.

Host tests, device acceptance, physical observations, source publication and deployment are separate verification steps. Do not infer that every catalog entry runs from a successful Python compilation or from a single successful Program run.
