# Sound and screen controls

The **Live Control → Sound & Screen** panel controls the CyberPi itself, not the browser's sound effects. It requires a connected robot advertising the validated `mbot-av-control-v1` capabilities. Nothing plays automatically when the page opens.

- **Text:** send up to 128 characters to the LCD, with a font size from 8 to 32.
- **Tone:** select 100–2000 Hz and a duration of 0–2 seconds. Zero duration produces no tone.
- **Preset sound:** hello, beeps, laugh, or score.
- **Volume:** explicitly apply a value from 0 to 60. The control is a requested setting, not measured speaker loudness.
- **Text animation:** one frame per line, up to 12 frames; frame interval 0.15–2 seconds. Total requested frame holds may not exceed 12 seconds. These are changing text frames, not video or arbitrary graphics.
- **Stop output:** uses emergency Stop, clearing unsent controls and stopping the program, motors and audio. Native calls may finish before Stop takes effect; this is not an independent hardware cutoff.

The program editor also supplies sound/display blocks. The server checks the entire program before transmission. Animations expand on the device into text-and-wait steps, so the expanded program must fit within 32 blocks and the full MQTT message within 8192 bytes. Unsupported presets, melodies and image commands are rejected rather than silently substituted.

The Activity Log distinguishes submission from device completion/failure. A completed driver call does not prove that a person heard a sound; commissioning evidence for actual audio and LCD behavior is recorded in [AV acceptance](av-acceptance.md).

## Firmware maintenance

The tested firmware is already installed on the commissioning robot. Studio deployment does not reflash it. For a later application update, use the compact builder described in the acceptance document, verify the digest, and retain OTA confirmation/rollback. Do not use the ordinary USB upload workflow to replace an existing resident OTA loader.
