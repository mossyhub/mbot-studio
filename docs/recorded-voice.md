# Your voice on the robot

In Program → Sound, use the recording panel:

1. Click **Record** and allow microphone access. Capture stops after three seconds; Stop ends it sooner.
2. **Preview** plays in your browser only.
3. Name and save the clip. Conversion happens locally on the Studio server, not through an AI or cloud audio service.
4. Choose **Sync to robot**. Only a device-verified clip can be inserted with **Use clip**.
5. The resulting **play recording** block can be used in your program. Run verifies and transfers all referenced clips before starting any program actions.

Browser capture requires HTTPS or localhost and microphone permission. A normal remote LAN HTTP address cannot provide browser microphone capture. Existing clips can still be displayed; unsupported recording is explained rather than pretending it works.

## Limits and behavior

- Three seconds per clip; up to eight saved clips.
- Recordings use local server storage and a dedicated robot asset directory, separate from its resident OTA loader and application slots.
- Saved on the server is not the same as ready on the robot. Device readiness is tied to the current connection and boot; reconnecting may require another Sync.
- Cancel abandons pending browser recording/upload/sync work. An operation already committed on the server/device is not retroactively erased; Refresh shows its current state.
- Delete requires confirmed device removal before deleting the local copy in the integrated service. Offline deletion keeps the local clip for retry.
- Emergency Stop cancels execution and pending transfer. Native driver calls cannot be interrupted until they return; this is not an independent hardware cutoff.
- Existing programs referencing a deleted/missing clip remain unchanged and fail preflight explicitly. There is no fallback to a built-in sound.

The Python preview cannot reproduce the managed recording transfer/buffer lifecycle, so it explicitly withholds a standalone Python export for these programs. This does not prevent the verified Program execution path.

Native completion confirms that the driver returned, not that someone heard the recording. Device acceptance and listener confirmation are reported separately.
