# Directional chassis turn calibration

## Contract

The `chassis_turn_calibrated_v1` capability means Program `turn_left` and
`turn_right` angles are approximate **target chassis angles, 0–180° inclusive**.
It is an explicit capability gate, not inferred from the unchanged AV build name.

The owner-approved current-chassis mapping is:

| Direction | Native magnitude per displayed 90° | Evidence |
| --- | ---: | --- |
| Left | 215 | Provisional: the owner observed a slight overshoot at native 220, then selected 215. The revised 215 setting is not physically verified. |
| Right | 198 | Owner-observed successful quarter-turn at native 198 on this chassis/setup. |

Firmware alone converts the target once, immediately at the native call:

- Left: `mbot2.turn(-(angle * 215 / 90))`
- Right: `mbot2.turn(angle * 198 / 90)`

Zero is a no-op. Each positive target uses one native call with the vendor's
unchanged default speed. No silent splitting, clamping, extra speed parameter,
or vendor calibration write is introduced. Native blocking calls may delay Stop
until the driver returns.

These are empirical, approximate, surface-dependent corrections for the current
chassis, not precision heading control or sensor feedback. Payload, traction,
surface and turn history can change actual rotation. The **180° half-turn is an
extrapolation, not physically verified**, as are targets above the 90° reference.
The displayed maximum is deliberately 180°, not 360°: it keeps the mapped native
request below the vendor algorithm switch above 720 native degrees. This bound
is not a claim of physical half-turn accuracy.

## Editor, server and preview

- The editor uses a pure runtime overlay: calibrated turns show **target angle**
  with 0–180 bounds and a tooltip describing the calibration and uncertainty.
- Old/unknown runtimes show **native angle** and retain their prior contracts:
  the generic unknown-runtime catalog remains 1–360, AV `turn_angle_360` remains
  0–360, and older AV without either capability remains 0–30.
- Source JSON, saved programs, parameters wrappers, lowering and MQTT wire angles
  remain unchanged target values. Loading a program or receiving a runtime status
  never rewrites its angles. An old value above 180 remains visible and stored,
  but calibrated admission rejects it with an explicit-edit explanation. Even
  old values inside the range must be reviewed for the new target semantics;
  there is no automatic conversion or migration of old native-angle programs.
- AI references use the advertised turn contract and never propose calibrated
  360° turns or pre-scale source angles to native values.
- The Python preview alone emits the signed, once-scaled native reference call;
  it is not sent back as the Program wire format. It is a linear reference, not
  the cooperative scheduler/OTA application, and lacks remote Stop/retry service.

## Runtime evidence

The server retains the actual firmware `turn_calibration` status object alongside
capabilities. It includes `reference`, `reference_degrees`, `native_per90`,
`factors`, per-direction `provisional`, `max_angle`, and `extrapolated_above`.
Sparse same-boot status retains this metadata; new boot/application identity
clears it rather than inheriting another runtime's calibration claim.

Host tests use intercepted HTTP/WebSocket/MQTT transports and native Python
stand-ins. They verify contracts and one-call mapping, not physical accuracy.
Passing tests, a generated preview and execution completion are not substitutes
for an owner-observed physical trial. This change alone makes no deployment or
installed-firmware claim.
