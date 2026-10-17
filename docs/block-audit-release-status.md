# Block audit release and acceptance

## Delivered scope

The audit covered all 73 baseline block types and their parameters. Repairs include explicit unsupported-field removal, wrapper-aware editing, truthful defaults, zero-valued hardware settings, typed reporter connections, AI runtime contracts/Python preview, Run/Stop submission fencing and recording readiness/cancellation. Recorded audio adds one block type.

Capability-gated indexed programs support 1,024 executed primitive steps with at most 32 distinct normalized commands, bounded wire size, holds and observation. This is not 1,024 arbitrary distinct commands.

## Device proof and limitations

Confirmed application `6ec5dda52965395c713a0b2a7d55c1c804ce62aeeb15a5cf8140bbbddafdb155` passed real 33/256/1,024-step nonmoving runs, cancellation, immediate fresh-run recovery, recording transfer/playback/deletion and restart checks. A deployed-browser test used actual Chromium MediaRecorder with synthetic microphone audio through local conversion, device hash verification, block insertion, Run and correlated device completion. It did not test a physical microphone or independent human audibility.

Initial native stack failures were resolved by shallow disk dispatch and deferred outer-tick asset admission. However, a later real 8,064-byte user recording exposed unacceptable transfer latency and a timeout. Earlier successful short-clip acceptance did not establish acceptable performance across the full supported size range.

## Slow-transfer follow-up

Device instrumentation measured a 512-byte chunk spending 4,417 ms in Python admission, compared with 3 ms in application networking and 345 ms in its disk phase. Repeated retries multiplied the admission cost.

The revised firmware uses native byte-search/count operations to skip string bodies while still rejecting duplicate JSON fields and escaped-key duplicates. Native hexadecimal decoding replaces a per-character Python scan. Loader, Stop, ownership, packet limits and timeouts remain unchanged.

The same saved 8,064-byte “hello” recording synced and hash-verified in 19.8 seconds on candidate `7bf6597eec8a8c120ff93375b9d4440b1472394d4a7981f6b0ba86e22bee9420`; the previous run aborted after 206.8 seconds. Bounded playback, Stop, fresh-run recovery and remote deletion also passed. These are observed transfer times, not guaranteed latency bounds.

The UI follow-up shows acknowledged bytes/total, transfer phase and persistent terminal errors beside Sync. Known transfer errors return explicit 409 responses instead of generic 500. Progress is acknowledgment-based, not estimated from bytes submitted to the broker. Final deployment and confirmation handles are recorded in the associated pull request.

## Separate maintenance finding

Existing production dependency advisories, including a critical transitive dependency, remain separate maintenance work. They were not silently upgraded as part of these block/runtime changes.
