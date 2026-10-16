# Hold-to-drive Live Control

The directional pad has a separate leased-control path, not a stream of queued Program blocks or repeated native angle turns. Holding a button requests continuous drive; releasing it sends Stop. Pointer cancellation, lost focus, hidden/unloaded pages, socket loss, emergency Stop and robot identity changes invalidate the hold. Reconnecting never resumes movement.

## Contract

- Requires fresh cooperative AV firmware advertising `drive_hold`, with an armed robot and known boot identity. Older firmware retains explicitly labeled tap controls.
- Browser sends `drive_start` with a new `hold_id`, one direction (`forward`, `backward`, `left`, `right`) and speed 30. It renews every 200ms only while held, and sends `drive_stop` on release. Neither start nor renew enters the ordinary direct-command queue.
- Server admits one socket owner. A 500ms owner lease expires without browser renewals. It forwards start/renew/stop on `robot/drive`, with the current boot identity. A renewed or stopped ID must belong to the active owner. Emergency Stop invalidates ownership.
- Robot has an independent 700ms lease. `renew` only extends a still-active matching hold; it cannot restart a stopped or expired hold. Commands are QoS0 and not retained. Native wheel drive is invoked once on start, not on each renewal.
- Firmware reports `robot/drive_status` with hold ID, boot, and `started`, `stopped`, or `rejected`. Started/stopped mean the relevant native call returned, not camera-observed motion.

These are cooperative software safety deadlines, not hard-real-time actuator cutoffs. Vendor/native calls or network processing can add latency. A hardware power switch remains the independent stop mechanism. Keep the movement area clear.

## Verification requirements

Use isolated Chromium tests for pointer, keyboard and lifecycle events; server ownership/expiry tests; firmware clock-wrap, late-renewal, busy, fault and Stop tests. Build the exact source with the staged application builder; preserve the previous confirmed artifact. Install via resident-loader OTA, verify selected SHA and the advertised capability, then exercise a nonmoving hold, release, silence expiry, ordinary Program recovery and bounded observed motion before confirming. No USB/vendor firmware replacement is needed.
