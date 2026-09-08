# Robot diagnostics

Open **Program → Diagnostics** to inspect or download the server's retained evidence, even when the robot is offline. Refresh reads the server journal only: it does not request sensors, move the robot, or replay commands.

The recorder captures command/program/emergency publication intent, transport callback outcome, incoming device status/sensors/execution/logs, broker connection changes, inferred heartbeat timeouts and observed boot changes. Exported events carry receive times, session identity and command/run identity when present. Last-known sensor snapshots retain their original receipt time rather than becoming fresh after Studio restarts.

Publication intent means the server was about to publish. A transport callback is not a device acknowledgement. Only received robot execution messages are execution evidence; even successful driver completion is not physical motion proof. A timeout records missing recent traffic, not a diagnosed power failure.

Storage is bounded and lives under Studio's persistent DATA_DIR. Writes are asynchronous and atomically replace the journal; abrupt Studio/host loss can lose pending writes. Recorder health, pending state, retained limits and corruption/drop counters are included in the export. Robot power loss does not erase messages already received by Studio. This does not reconstruct events before the recorder was installed.

## Power-failure limitations

The installed `mbot-av-control-v1` firmware supplies battery **percentage**, not loaded voltage/current or a power-protection fault bit. A50% reading cannot rule out battery sag, nor prove it caused a shutdown. When the power rail disappears there may be no opportunity for firmware to send a final message.

The current firmware queues started/completed events around a native turn but transmits them only after native IO returns. A motor call that loses power or never returns can therefore leave no execution events. Server-side command intent fills the dispatch evidence gap, not the native-entry/voltage gap.

A future application-only OTA diagnostic can report a guarded boot reset-cause reading and flush a pre-native diagnostic before calling the driver, preserving shallow native call depth and Stop cancellation. That firmware is not installed by this server/UI change. No guessed ADC, voltage/register API, per-operation flash writes, watchdog weakening or automatic motion retry is introduced.

After another unexplained shutdown, preserve the diagnostic export and camera window. Note whether lights/screen went dark, whether the physical switch changed, and whether a manual restart was needed. Reset-cause after a manual restart may describe that restart rather than the original failure.
