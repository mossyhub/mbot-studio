"""Actual firmware protocol over pipes; synthetic bytes, no broker/hardware.

Adapted from the independent recording-contract differential reproduction.
"""
import json
import pathlib
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import test_robot_recordings as recordings

with tempfile.TemporaryDirectory(prefix='recording-contract-') as root:
    m, ctx, clock, io, client = recordings.recording_rig(pathlib.Path(root))
    for line in sys.stdin:
        try:
            command = json.loads(line)
            start = len(client.events)
            if command.get('payload') is not None:
                client.callback(('mbot-studio/robot/' + command.get('topic', 'asset')).encode(), command['payload'].encode())
            for _ in range(command.get('ticks', 100)):
                m.ota_step(ctx)
            events = [{'topic': t.decode(), 'data': e} for t, e in client.events[start:]]
            print(json.dumps({'events': events, 'assets': m._app.recordings.assets,
                              'transfer': m._app.recordings.transfer is not None,
                              'busy': m._app.asset_busy()}), flush=True)
        except Exception as error:
            print(json.dumps({'bridge_error': repr(error)}), flush=True)
