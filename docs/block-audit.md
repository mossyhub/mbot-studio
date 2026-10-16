# Block contracts and audit

The editor catalog is larger than the installed robot runtime. “All blocks” includes editing/preview-only legacy blocks. A visible block is not proof the robot can execute it. Robot-ready filtering and Program preflight use the connected runtime's advertised commands plus the verified static lowerer.

## Audited baseline

The audit of revision `ee40fe764e858ef264a3550fb4f76dd95bf3ea11` enumerated 73 unique block types and 100 generic parameter definitions (99 after the installed AV overlay). Thirty-five types were usable in complete, valid contexts; 38 were intentionally unavailable. These counts describe that baseline, before adding recorded audio.

Coverage included 6,750 catalog/admission cases, all offered finite selectors, numeric endpoints, omitted/null values, 3,430 reporter/socket combinations, 1,464 server/firmware differential inputs, native-adapter stand-ins and real scheduler tests. Real React browser tests reproduced editing and hydration defects with all network traffic intercepted. These tests do not establish physical movement, sound or sensor behavior.

## Parameter contract findings

- Imported turn `speed` and unknown fields were retained but could not be removed; some incompatible fields were invisible. Repairs must be explicit, not silent execution-time stripping.
- Accepted `params` wrappers displayed palette defaults and editing mixed wrapper/top-level fields, invalidating previously accepted programs.
- Omitted values displayed palette creation defaults instead of runtime defaults. Explicit `null` and missing required fields looked valid.
- Hardware configuration treated zero as missing, and offered motor action durations beyond firmware admission.
- Reporter sockets permitted boolean-to-number and expression-to-literal-only connections.
- Repeat input bounds disagreed with the lowerer. Supported LED colors were absent. Text length metadata and invalid animation-frame contents were not surfaced.
- AI generation prompts taught unsupported turn/servo parameters, and successful preflight could still produce a contradictory Python preview.

## Execution findings

A positive motor duration below one millisecond could start a motor then complete without scheduling Stop. Ordinary programs could lose their Stop obligation after a native Stop failure. Independent review additionally exercised the real resident-loader boundary: a retry exception escaping the application could cause the loader to discard the application, preventing subsequent retries. Recovery tests must drive the real loader, not catch exceptions and manually call an abandoned application again.

Stop completion, native driver completion and physical observation are separate evidence. A cooperative deadline cannot interrupt an already blocked native driver.

## Larger programs

The `program_indexed_v1` capability selects up to **1,024 executed primitive steps** using at most **32 distinct normalized commands** and a compact order tape. It does not mean 1,024 arbitrary unique commands. Whole MQTT payloads remain bounded to 8,192 bytes; source size/depth, requested holds, animation duration and execution deadlines are separate constraints. Old firmware retains the 32-step contract.

Static repeats, variables and conditions are evaluated before transmission. Live sensors and unbounded loops are not silently replaced with cached values or blind movement. Source maps retain global executed indexes for error reporting and completion evidence.

## Recorded voice

Recorded audio requires an explicit installed-runtime capability. Browser capture needs microphone permission and a secure context (HTTPS or localhost). Browser media containers must be decoded/transcoded, not renamed to MP3. Assets are data, not executable Python and not resident-loader slots. Stored-on-server, verified-on-device, native playback completion and audible playback are distinct states.

## Release evidence

Combined-tree CI, deployed web revision, installed application digest and device acceptance must be recorded separately in the release notes. Intermediate test runs that overlap source changes are development evidence, not final release gates.
