# Block audit release status

## Software verification

The combined implementation passed397 Node tests (including the explicit Python suite) and322 browser tests, with3 browser skips and retries disabled. Production Docker build and isolated local audio conversion passed. The catalog audit covered all73 baseline block types; recorded audio adds one new type.

Implemented fixes include parameter repair/hydration/defaults, custom hardware settings, typed reporter connections, AI runtime contracts and Python preview, Run/Stop submission fencing, current-boot recording readiness, request-owned asset cancellation, and persistent native Stop recovery through the real resident loader.

## Device acceptance boundary

An earlier indexed candidate completed33,256 and1024 nonmoving steps with every global index accounted for, then canceled a long wait and successfully executed new work. A separate MP3 diagnostic started supplied MP3 bytes, returned in3ms, stopped successfully and retained loader continuity. Audible output was not independently confirmed because camera frames/audio were unavailable and no listener response was received.

The combined recording candidate booted and advertised its capabilities, but real asset BEGIN rejected with `maximum recursion depth exceeded`. Shallower filesystem dispatch alone did not resolve that failure. The final source additionally moves asset admission out of the MQTT callback into the outer cooperative tick; this correction is host-tested but **not yet installed/device-verified**.

The robot and OTA loader became unreachable before the final candidate could be installed. Do not equate a web deployment with firmware installation or claim end-to-end browser voice playback complete. Final firmware upload, transfer/playback/Stop acceptance and explicit OTA confirmation remain pending reconnection.

Original confirmed application remains the recovery reference: `8d0741170e7865ad656aea7cb5f883141a8bc838ffbc3d2ba7e7508f45eea9c6`. Last observed trial was `76d21db52047372095d5f0e4811a449c09914c01f4572bafff2a567fab3cee98`; its rollback request outcome could not be verified once the device disappeared. Final built candidate: `4f040460af01963f113ae6604585a5dfaa2c56127a7fa2636cbbb3f0739215e9`.

## Separate maintenance finding

The production dependency audit reports existing advisories, including a critical transitive dependency. They were not silently upgraded as part of the block/runtime changes. Dependency remediation and regression verification remain separate maintenance work.
