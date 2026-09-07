# Motor-control learning for camera-free Studio

These observations guide the next calibration trial. **They are not automatic motion defaults or a precise distance controller.** Studio has no camera integration; bench cameras are external measurement tools. Do not copy camera-guided success claims into Studio's execution status.

## What the bench established

| Control | Observed behavior | Limit |
|---|---|---|
| Forward 15 for 0.3 s | Approximately 3 px chassis displacement | One short pulse; too little to infer a speed curve |
| Forward 30 for 0.5 s | Approximately 34 px additional displacement | Elevated chassis tracking, not corrected metric distance |
| Reverse 30 for 0.5 s | Approximately 39 px in the opposite direction | Reverse is not an exact inverse of forward |
| M1 positive/negative power | Closes/opens the attached claw | No force or position feedback |
| M1 ±50 for 2 s | Visible partial closure and reopening | Not full stroke or a percentage-position calibration |
| S1 110 → 135 | Raises the attached elbow | Commanded angle is not measured joint angle |
| Native signed turn calls | Both turn directions physically worked | Tracked-chassis yaw was much less than requested angle; slip is not a fixed conversion factor |

The owner's mat grid is 0.5 inch (12.7 mm), excluding diagonal guide lines. The observed nearby image grid pitch was about 12.5 px, but raised-marker parallax remains uncorrected. Therefore pixel travel must not be silently promoted to centimeters or fed into an automatic distance-to-duration conversion.

## Grasp and placement rules

1. Align the jaw closure axis with stable opposing faces of the object. Enclose it with the full useful pad length before closing; corner contact can push it away.
2. Grip near the base or another stable, object-specific height. An upright block, thin triangle, and tipped block require different approach heights.
3. Tightening longer cannot correct bad alignment. This claw is mechanically weak; neither a completed motor call nor a momentary lift proves payload retention.
4. Plan placement around the **center** of the target square and the object's footprint, leaving margin. Merely overlapping an edge is not a centered placement.
5. Opening, withdrawing, and verifying the object remains supported are separate outcomes. A release command alone is not proof of placement.
6. Do not blindly replay the inverse of a retreat or dance. Track slip, payload changes and forward/reverse asymmetry invalidate exact open-loop pose restoration.

## Sensors and reported state

- The ultrasonic sensor is chassis-mounted. Arm-dependent readings can involve reflections or obstruction, not sensor rotation.
- 300 cm readings occurred while approaching visible nearby objects. Preserve the raw reading but never treat it alone as proof of clear space or as proof of a failed sensor.
- Sensor scans are on demand. Partial scans (`sampling: true`), complete snapshots, stale data and offline state need distinct UI states.
- Device events mean the driver path executed; actuator state without feedback remains an estimate.

## Building a useful motor model

Collect repeated trials separately for forward/reverse, power, duration, surface, battery band, payload and arm pose. Record actual displacement/heading and settling error, not only requested values. Fit only within the measured range, retain uncertainty and validate on held-out runs. Use the resulting model for planned command batches; reserve cameras for calibration and critical outcome validation rather than steering every tiny increment. Until repeatability is measured, keep user-saved calibration intact and do not invent centimeters-per-second or grip percentages.

## Firmware acceptance boundary

The last confirmed on-device turn-capable artifact before charging was `864b9ab86452bc913009484b18419e895980d5b62e13a9aeb69e49bfeccd959c`. Local sound/animation changes passed host tests but **have not passed device startup or audiovisual acceptance**. Earlier candidate activation returned to the confirmed application; the cause remains unresolved. Later loss of connectivity was explained by the owner's dead-battery report, not proof that all preceding candidate failures were battery-related.

No firmware installation, robot movement, or live device testing is part of the charging-break software work.
