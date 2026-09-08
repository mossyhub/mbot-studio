# Screen and audio — real-device acceptance

## Installed result

Build `mbot-av-control-v1`, confirmed application SHA-256 `ff2cdaf6a9fed30589073ce36115cc44b4b1a25b7eef4d554d9bf6c5aacdde69`, 15,971 bytes. The production builder reproduces the installed artifact exactly:

```
python tools/build-robot-control.py --compact --config <private-config.json> --out <new-app.py>
```

The resident loader and its watchdog settings were not changed. The artifact was activated, exercised, explicitly confirmed, restarted, and exercised again. After restart, fresh sensor scans, OTA during a wait, ordinary Stop, emergency Stop, whole-program rejection and a subsequent valid program passed. Final command stopped sound and motors and displayed READY. No movement was used during the AV acceptance demo; prior supervised motion positioned the robot facing the side camera.

## Physical evidence

- Full-resolution side-camera crop `av-resume/lcd.jpg` clearly reads SCREEN / 123 from the initial known-good diagnostic.
- `av-resume/animation-frames.jpg`, derived from actual final-app video, visibly shows SOUND TEST, changing O_O / -_- / ^_^ face frames, ANIMATING, and READY after cancellation. The sparse contact sheet does not show every frame; continuous video is retained.
- Side camera includes an audio track. Initial recorded tone tests have strong spectral peaks near 440.14, 880.28 and 1320.41 Hz in separate commanded time windows. Final-app recording again contains corresponding 440/880/1320 Hz components. Harmonics exist (the 440 tone has a strong1320 harmonic), so a peak is not independently counted as another commanded sound.
- Preset hello and volume/stop API calls completed on the actual device and their sound window was recorded. Exact spoken-preset identity was not transcribed or independently judged by an audio listener; do not conflate that with the stronger measured-tone evidence.
- Full demo execution completed. A separate animation was running when OTA status responded healthy; emergency canceled that program, and a subsequent READY command succeeded.

Private evidence directory: `/hermes_work/mbot-calibration/av-resume/`. Videos: side.mp4 and overhead.mp4. Audio: final-audio.wav and final-audio-analysis.json. Correlated device events: acceptance.json and final-ready.json.

## Implementation and diagnosis boundaries

The larger original AV candidate repeatedly rolled back, including after charging. A nonmoving diagnostic compiled its source successfully in6609ms and captured maximum-recursion-depth failure from a nested initialization attempt. That diagnostic has additional call frames: it demonstrates stack sensitivity, but is not a direct traceback of every original startup failure.

Startup hardware stopping now runs at the first outer ota_step, before application networking or command execution, rather than inside the constructor. Failure preserves the initial-stop flag and prevents admission. Native stop still attempts encoder, DC and audio stopping. The first uncompressed version of that change still failed activation; removing only comments and blank lines outside strings produced an AST-identical artifact that booted and survived another restart. Timing/source-loading sensitivity is demonstrated, but the original failure is not attributed solely to recursion or solely to watchdog expiry. No watchdog weakening was used.

Compaction is optional and guarded by complete AST equality, including docstrings/string values, plus compilation and exclusive output creation. Tests cover comments within strings and blank lines within multiline strings.

## Supported AV scope and limits

- play_tone:100..2000Hz,0..2s; zero skips native audio.
- play_sound:hello,beeps,laugh,score allowlist; only hello exercised in this acceptance.
- set_volume:integer0..60;35 exercised.
- stop_sound:explicit audio stop; motor/emergency Stop also stops audio.
- display_text:existing text API.
- display_animation:bounded strings rendered as text frames, not arbitrary graphical/video playback. Up to12frames, bounded interval and total holds, max32 expanded program blocks. Frames can be canceled between native calls.

Native tone calls may block for up to the requested duration. A software Stop cannot preempt a blocked native driver. Camera-free Studio remains the intended command consumer; cameras here are external test instruments. Studio wiring is described in [Sound and screen controls](studio-av.md). It uses build-specific capability admission; the older motor-only application does not gain AV commands merely because Studio was updated.

## Host verification

291 Python tests plus6 subtests passed. Independent reviews covered the earlier AV delta and final startup change. Builder regression tests passed, and the parent reproduced the exact installed digest using the new --compact option. Host tests are separate from physical acceptance. These commissioning counts describe the firmware acceptance tree; Studio integration has separate browser/API regression tests and release verification.
