"""Nonmoving commissioning app. No hardware imports, commands or private keys.

The loader calls one bounded step per service cycle. A successful return is
health, NOT confirmation; the operator must explicitly confirm its SHA256.
The returned identity is diagnostic data, not independently authenticated.
Loader hello/status reports selected SHA256 and health with the boot ID.
"""
OTA_APP_PROTOCOL = 1
OTA_BUILD_ID = "mbot-ota-diagnostic-v1"
_steps = 0
_identity = None


def ota_init(context):
    global _steps, _identity
    if context.protocol != 1 or context.disarmed is not True:
        raise ValueError("diagnostic_context")
    _steps = 0
    _identity = (context.device, context.boot, context.sha256)


def ota_step(context):
    global _steps
    if _identity != (context.device, context.boot, context.sha256):
        raise ValueError("diagnostic_identity")
    _steps = (_steps % 1000000) + 1
    return {"build": OTA_BUILD_ID, "device": context.device,
            "boot": context.boot, "sha256": context.sha256,
            "steps": _steps, "disarmed": True, "healthy": True}
