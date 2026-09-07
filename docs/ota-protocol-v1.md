# OTA v1 — trusted-LAN commissioning protocol

Per the project owner's decision, there is no OTA authentication, signing, encryption requirement, or update key. Anyone able to publish on these MQTT topics can update the robot. Keep it on the intended LAN; don't expose it publicly. SHA-256 checks below detect incomplete/corrupt data, not unauthorized changes.

This updates application files, not ESP32/Makeblock native firmware. Initial app is nonmoving diagnostic code; legacy bundled main.py is not a compatible cooperative app. Startup installation remains a separate explicit operation.

## Wire

Topics `<prefix>/ota/<device>/{request,response,hello}`. QoS0 with application acknowledgements; retain=false. Device ID: ASCII letters/digits/_/- up to48chars. A fresh32hex boot ID distinguishes restarts. Sequence integers and transfer IDs prevent accidental stale/duplicate operations; these are not security controls.

Envelope `{v:1,device,boot,seq,op,body}`. body is a JSON STRING containing an object. Native JSON parsing, no hand-written character scanner. Limit envelope8192bytes; body6144chars; validate field types and allowed operation payloads. hello uses seq0/ophello and flat status fields plus protocol1, loader'1', next_seq. Response echoes request seq/op with body `{ok:true,result:{...}}` or `{ok:false,error:'bounded_code'}`.

One request outstanding per operator. New accepted requests consume sequential seq from1, including operation errors. Exact previous request retries return cached response. Mismatched sequence is rejected without consuming it. Client verifies device/boot/seq/op correlation, ignoring retained notifications; a status request establishes current reachability. Disconnect/timeout means outcome unknown, never successful upload. Boot wait default90seconds accommodates measured device startup; per-request retry timeouts are separate.

## Operations

- status `{}`
- begin `{transfer:32hex,size:1..131072 integer,sha256:64hex}`
- chunk `{transfer,offset:integer,data:lowerhex up to2048chars/1024bytes}`
- finish `{transfer}`
- abort `{transfer}`
- activate `{sha256}`
- confirm `{sha256}`
- rollback `{}`

Use exact payload keys. Begin selects inactive slot, never confirmed; persist candidate invalidation before writing. Reject begin while trial/transfer pending. Chunk writes sequentially, with exact matching duplicate ranges accepted. Finish reopens and checks full size/digest before recording candidate. Activation stages trial and responds restart:true; runtime sends reply before reset. Confirm requires selected healthy matching trial. Rollback abandons trial and selects last confirmed or empty recovery; it does not preserve unlimited version history.

## Core / persistence

`OtaEngine(root,device,boot)` supplies hello(), handle(raw-or-envelope), boot_selection(), status(), mark_healthy(). Constructor performs no network or code execution. Root must exist. Slot files app_a.py/app_b.py; descriptors {slot,sha256,size}.

Two bounded metadata records: `{generation,body,sha256}` where checksum is SHA256 of UTF8 `mbot-ota-meta-v1\n<device>\n<generation>\n<body>`. body records confirmed,candidate,trial. Native parsing and readback verify writes. If metadata exists but neither copy validates, fail closed without silently initializing over it. Both attempted records are synchronized before selecting trial; subsequent boot with attempted trial returns confirmed/recovery. This is tested logical redundancy, not physical power-cut durability certification.

## Runtime

Bootstrap inlines core and loader with WIFI_SSID,WIFI_PASSWORD,MQTT_BROKER,MQTT_PORT,MQTT_TOPIC_PREFIX,OTA_DEVICE. No OTA_KEY_HEX. Create/validate /flash/mbot_ota without erasing contents. Callback only queues bounded bytes; process messages in main loop. No legacy robot commands or arbitrary REPL subscription. Stop-only attempts on startup are best effort, not actuator-power certification.

Verify candidate bytes before execution. Cooperative app exports OTA_APP_PROTOCOL=1, ota_init(context), ota_step(context). Context has identity and disarmed state. WDT before candidate exec, fed by loader after service/step returns. Trial exception resets for rollback. Confirmed app exception must disable app and keep update service in recovery rather than an exception reboot loop. Native hangs and network calls need actual device testing. Same interpreter is not fault isolation. Initial app is trusted nonmoving diagnostic code; no movement tests implicit in installation.

## Tools and tests

OtaClient options {brokerUrl,prefix,device}; CLI config same fields, no key provisioning or owner-permission requirement. status/upload/activate/confirm/rollback explicit, no auto-confirm. Offline bootstrap file contains WiFi password and must stay outside Git despite unauthenticated OTA.

Tests use real core in temporary directories and an isolated broker; cross-language peer's reconstructed engine is a SOFTWARE restart. Separate on-device disposable checks establish MicroPython execution/performance without replacing boot files. Preserve evidence of prior authenticated prototype as historical, not current capabilities.
