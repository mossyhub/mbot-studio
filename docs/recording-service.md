# Recording storage and HTTP integration

## Server integration

`server/src/index.js` initializes one recording service, installs its trusted registry in MQTT, and mounts the raw recording routes before the general JSON parser. Storage initialization must complete before the HTTP server listens. The following shows the integration contract:

```js
import { RecordingService } from './services/recording-service.js';
import { createRecordingRoutes } from './routes/recordings.js';
const recordings = new RecordingService({ dataDir: process.env.DATA_DIR, syncAdapter });
await recordings.initialize();
mqttService.setRecordingRegistry(recordings);
app.use('/api/robot/recordings', createRecordingRoutes({ service: recordings }));
// THEN express.json and generic /api/robot routes.
```

Do not import/start the server or MQTT merely to construct the service/router. Route-local `express.raw({type:()=>true,limit:1048576,inflate:false})` owns POST `/` bytes. Mount it before a catch-all parser or `/api/robot` router. Existing JSON middleware does not consume audio MIME, but earlier recording mounting also ensures unsupported JSON produces a recording-specific error. Keep existing deployment access controls; these endpoints add no new authentication scheme. Recordings are private local DATA_DIR files, not a public/static directory, AI upload, or cloud conversion.

## HTTP

- `POST /api/robot/recordings?name=...` raw bytes, Content-Type audio/webm (optional codecs parameter), audio/ogg, audio/mp4, audio/wav (also audio/x-wav/audio/wave). Name defaults to Recording; optional name is 1–80 Unicode codepoints, no controls. No user filename/path. Returns 201 `{id,name,durationMs,bytes,ready:false}` for a new asset. Same encoded hash deduplicates, preserving original metadata; an already-device-verified duplicate can return ready:true.
- `GET /api/robot/recordings` → `{recordings:[metadata]}`.
- `GET /api/robot/recordings/:id/audio` → MP3 `audio/mpeg`, no-store, nosniff; serves only integrity-verified bytes.
- `DELETE /api/robot/recordings/:id` → `{id,deleted:true,deviceDeleted:true}` in the integrated service, only after the current device acknowledges deletion or confirms absence. Offline, timeout or failed deletion preserves the local clip so it can be retried. Standalone storage without a device adapter explicitly returns `deviceDeleted:false`; it does not claim flash deletion.
- `POST /api/robot/recordings/:id/sync` → current verified metadata when configured; otherwise 503. No implicit transfer on storage. UI must expose explicit sync (or parent must integrate a capability/idle-admitted sync workflow) before requiring ready=true to insert a block; storage alone never earns readiness.
- Structured failures `{error,code}`; bounded uploads413, unsupported type/HTTP compression415, bad audio/name/ID400, quota/busy/integrity/device admission409, missing404, unavailable local ffmpeg503, transcoder timeout504. Unexpected errors are sanitized500 without filesystem paths or ffmpeg stderr.

## Exact local codec/bounds

Per later physical-proof instruction: **MPEG1 MP3, mono32kHz, CBR32kbps, no ID3/Xing/Info**, not the initial16kHz proposal. ffmpeg uses `-map_metadata -1 -write_xing 0 -id3v2_version 0`. Input is fully decoded to mono32kHz signed16 PCM with bounded stdout before encoding; >192000 decoded bytes (3s) is rejected rather than truncated, including streaming WebM without duration metadata. `durationMs` is ceil(decoded PCM samples /32000*1000), excludes MP3 frame/encoder padding. Exactly3s is accepted despite padding; one-second output is4176bytes in tested ffmpeg. Source upload≤1MiB, final MP3≤24KiB, max8 assets, no eviction. Content ID is lowercase64-character SHA256 of final MP3, metadata is immutable after deduplication.

Every ffmpeg child uses execFile/no shell, fixed local filenames, explicit input demuxer, `file,pipe` protocol allowlist, no stdin, one decode thread, bounded stdout/stderr,10s timeout and SIGKILL. Original and PCM files are deleted; only MP3+metadata remain after atomic directory rename. Temp directories live under DATA_DIR/recordings/tmp and are removed in finally on success/rejection/timeout. A process/host crash can leave a private orphan temp directory; administrators may remove these **only while the service is stopped**. Files0600, directories0700. Atomic rename is not a power-loss fsync guarantee.

One writer per resolved DATA_DIR in this single Node process; concurrent create/delete/sync gets409 instead of an unbounded queue. Use exactly one service singleton per DATA_DIR. Multiple server processes sharing a volume are not supported by this lock. Startup validates local assets; invalid disk assets never become registry entries. getAsset always revalidates digest/length and restricts filenames to canonical IDs.

## Registry used by transfer/program lowering

`await recordings.initialize()` before injecting it into MQTT:

- synchronous `get(id)` → frozen `{id,sha256:id,size:bytes,duration_ms:durationMs}` or null for an unknown valid ID. Metadata comes from validated local files/create, never an HTTP program.
- async `read(id)` → fresh integrity-checked Buffer.
- async `getAsset(id)` → `{metadata:{id,name,durationMs,bytes,ready},audio:Buffer}`. Metadata frozen, byte buffer is a new disk read; callers may mutate their copy without modifying the stored clip.
- async `list()`, `create({audio:Buffer,contentType,name})`, `delete(id)`, `sync(id)`.

Program transfer must snapshot and rehash read() bytes, use trusted registry duration only, reserve ownership through final publication, and revalidate live admission immediately before every device publish. Local list/get do not transfer and remain usable disconnected.

## Injected sync/readiness adapter

Constructor `syncAdapter` may be omitted. Otherwise:

```js
{
  getStatus() { return { connected, idle, bootId, capabilities }; },
  getVerification(id) { return { verified: true, id, sha256: id, bootId }; },
  async sync({ metadata, audio }, { bootId }) { /* real transfer owner */ }
}
```

getStatus/getVerification are synchronous trusted callbacks. Missing receipt or thrown callbacks fail readiness closed. Receipt must mean device-confirmed complete hash/length verification for exactly this current live boot, not publish/transport ACK. Service computes ready from connected=true, nonempty current bootId, recorded_audio_v1 and matching verified receipt id+SHA+boot. Ready is never restored from disk. Disconnection, boot mismatch or capability withdrawal suppresses it. Adapter must also clear its receipt on deletion/flash change and any lifecycle invalidation; never advertise cached ACKs across reboot.

Sync requires connected, idle, recorded_audio_v1 and boot before invoking adapter and matching current verified identity afterward. **Adapter MUST repeat admission at its actual publish boundary**, own reservation and per-chunk identity fencing, cancel on Stop/disconnect/OTA/reboot, and produce getVerification only after final firmware hash validation. Passing the service's initial checks is not transport permission. If program Run performs sync itself, inject getStatus/getVerification only to expose its verified readiness, with optional explicit sync delegated to that same owner. No live MQTT/device operations are implemented in this module.

## Verification / remaining integration

Focused tests: `FFMPEG_PATH=/path/to/ffmpeg node --test tests/recording-service.test.js tests/recording-routes.test.js`; ffprobe must be beside that executable or FFPROBE_PATH set. System ffmpeg/ffprobe on PATH also work. Tests generate artificial audio in disposable scratch DATA_DIRs and exercise actual ffmpeg and loopback HTTP. No recording fixture audio is committed.

Docker production installs ffmpeg in its Alpine image; the GitHub test job installs ffmpeg explicitly. Automated tests cover the real startup/router/storage integration with isolated transport and disposable data. Source tests and native-call acknowledgements do not establish audible playback; device acceptance and the exact deployed revisions belong in release evidence.
