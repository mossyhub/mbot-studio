"""Trusted-LAN application OTA core (no authentication); no import-time I/O or hardware access.

Uses only MicroPython 1.11 primitives. The caller supplies an existing
root directory and must call boot_selection once before running an application.
"""
try:
    import ujson as json
except ImportError:
    import json
try:
    import uhashlib as hashlib
except ImportError:
    import hashlib
try:
    import ubinascii as binascii
except ImportError:
    import binascii
import os
try:
    import ure as re
except ImportError:
    import re


def _hex(data):
    return binascii.hexlify(data).decode('ascii')


def _digest(data):
    return hashlib.sha256(data).digest()


def _ishex(value, length):
    if type(value) is not str or len(value) != length:
        return False
    try:
        # Native validation, no Python per-character loop.
        return _hex(binascii.unhexlify(value)) == value
    except (ValueError, TypeError):
        return False


def _integer(value, low, high):
    return type(value) is int and low <= value <= high


def _keys(value, names):
    return type(value) is dict and set(value) == set(names)


def _object(text):
    # Native duplicate-key semantics; no Python scanner or recursive validation.
    if type(text) not in (str, bytes) or len(text) > 8192:
        raise ValueError('json_size')
    result = json.loads(text)
    if type(result) is not dict:
        raise ValueError('object_required')
    return result


class OtaError(Exception):
    pass


class OtaEngine:
    def __init__(self, root, device, boot):
        if (type(root) is not str or not root or
                type(device) is not str or not 1 <= len(device) <= 48 or
                re.match('^[A-Za-z0-9_-]+$', device) is None or '\n' in device or
                not _ishex(boot, 32)):
            raise ValueError('provisioning')
        self.root = root.rstrip('/')
        self._last_request = None
        self._last_response = None
        self.device = device
        self.boot = boot
        self.next_seq = 1
        self.confirmed = None
        self.candidate = None
        self.trial = None
        self.receiving = None
        self.healthy = False
        self.selected = None
        self._generation = 0
        self._fault = False
        self._boot_selected = False
        self._load_metadata()

    def _path(self, slot):
        return self.root + '/app_' + slot + '.py'

    def _descriptor(self, value):
        return (value is None or (_keys(value, ('slot', 'sha256', 'size')) and
                value['slot'] in ('a', 'b') and _ishex(value['sha256'], 64) and
                _integer(value['size'], 1, 131072)))

    def _read_metadata(self, path):
        with open(path, 'r') as stream:
            text = stream.read(4097)
        if len(text) > 4096:
            raise ValueError('metadata')
        record = _object(text)
        if (not _keys(record, ('generation', 'body', 'sha256')) or
                not _integer(record['generation'], 1, 2147483647) or
                type(record['body']) is not str or not _ishex(record['sha256'], 64)):
            raise ValueError('metadata')
        expected = _hex(_digest(('mbot-ota-meta-v1\n' + self.device + '\n' +
                         str(record['generation']) + '\n' + record['body']).encode('utf-8')))
        if expected != record['sha256']:
            raise ValueError('metadata')
        state = _object(record['body'])
        if (not _keys(state, ('confirmed', 'candidate', 'trial')) or
                not self._descriptor(state['confirmed']) or not self._descriptor(state['candidate'])):
            raise ValueError('metadata')
        trial = state['trial']
        if trial is not None and (not _keys(trial, ('slot', 'sha256', 'size', 'attempted')) or
                type(trial['attempted']) is not bool or
                not self._descriptor(dict(slot=trial['slot'], sha256=trial['sha256'], size=trial['size'])) or
                state['candidate'] != dict(slot=trial['slot'], sha256=trial['sha256'], size=trial['size'])):
            raise ValueError('metadata')
        if state['confirmed'] and state['candidate'] and state['confirmed']['slot'] == state['candidate']['slot']:
            raise ValueError('metadata')
        return record['generation'], state

    def _load_metadata(self):
        records = []
        exists = False
        for index in (0, 1):
            path = self.root + '/meta' + str(index) + '.json'
            try:
                os.stat(path)
            except OSError as error:
                if error.args and error.args[0] == 2:
                    continue
                raise ValueError('metadata_unreadable')
            exists = True
            try:
                records.append(self._read_metadata(path))
            except (OSError, ValueError, TypeError, KeyError):
                pass
        if exists and not records:
            raise ValueError('metadata_corrupt')
        if records:
            if len(records) == 2 and records[0][0] == records[1][0] and records[0][1] != records[1][1]:
                raise ValueError('metadata_conflict')
            generation, state = max(records, key=lambda item: item[0])
            self._generation = generation
            self.confirmed = state['confirmed']
            self.candidate = state['candidate']
            self.trial = state['trial']

    def _save(self, confirmed, candidate, trial):
        if self._fault:
            raise OtaError('storage_fault')
        state = dict(confirmed=confirmed, candidate=candidate, trial=trial)
        generation = self._generation + 1
        body = json.dumps(state)
        # Corruption checksum only, NOT authentication or security.
        checksum = _hex(_digest(('mbot-ota-meta-v1\n' + self.device + '\n' +
                    str(generation) + '\n' + body).encode('utf-8')))
        text = json.dumps(dict(generation=generation, body=body, sha256=checksum))
        try:
            # Both records are synchronized before success or any execution.
            # A failed second write prohibits further mutations this boot.
            for index in (0, 1):
                path = self.root + '/meta' + str(index) + '.json'
                temporary = path + '.tmp'
                with open(temporary, 'w') as stream:
                    stream.write(text)
                if self._read_metadata(temporary) != (generation, state):
                    raise ValueError('readback')
                os.rename(temporary, path)
                if self._read_metadata(path) != (generation, state):
                    raise ValueError('readback')
        except (OSError, ValueError, TypeError):
            self._fault = True
            self.healthy = False
            raise OtaError('storage_fault')
        self._generation = generation
        self.confirmed = confirmed
        self.candidate = candidate
        self.trial = trial

    def _verify_file(self, descriptor):
        digest = hashlib.sha256()
        size = 0
        with open(self._path(descriptor['slot']), 'rb') as stream:
            while True:
                data = stream.read(1024)
                if not data:
                    break
                size += len(data)
                if size > descriptor['size']:
                    raise OtaError('size')
                digest.update(data)
        if size != descriptor['size']:
            raise OtaError('size')
        if _hex(digest.digest()) != descriptor['sha256']:
            raise OtaError('digest')

    def status(self):
        return dict(confirmed=dict(self.confirmed) if self.confirmed else None,
                    candidate=dict(self.candidate) if self.candidate else None,
                    trial=dict(self.trial) if self.trial else None,
                    receiving=dict(self.receiving) if self.receiving else None,
                    healthy=self.healthy,
                    selected=dict(self.selected) if self.selected else None,
                    next_seq=self.next_seq)

    def _envelope(self, seq, op, body):
        text = json.dumps(body)
        return dict(v=1, device=self.device, boot=self.boot, seq=seq, op=op,
                    body=text)

    def hello(self):
        body = self.status()
        body['protocol'] = 1
        body['loader'] = '1'
        return self._envelope(0, 'hello', body)

    def handle(self, request):
        seq = 0
        op = 'error'
        try:
            if type(request) in (str, bytes):
                if len(request) > 8192:
                    raise OtaError('envelope')
                request = _object(request)
            if not _keys(request, ('v', 'device', 'boot', 'seq', 'op', 'body')):
                raise OtaError('envelope')
            if (type(request['v']) is not int or request['v'] != 1 or
                    request['device'] != self.device or request['boot'] != self.boot or
                    not _integer(request['seq'], 1, 2147483647) or
                    type(request['op']) is not str or not 1 <= len(request['op']) <= 16 or
                    re.match('^[a-z]+$', request['op']) is None or '\n' in request['op'] or
                    type(request['body']) is not str or len(request['body'].encode('utf-8')) > 6144):
                raise OtaError('envelope')
            if len(json.dumps(request).encode('utf-8')) > 8192:
                raise OtaError('envelope')
            seq = request['seq']
            op = request['op']
            request_tuple = (request['v'], request['device'], request['boot'], seq, op, request['body'])
            if seq == self.next_seq - 1 and request_tuple == self._last_request:
                return dict(self._last_response)
            if seq != self.next_seq:
                raise OtaError('sequence')
        except (OtaError, ValueError, TypeError) as error:
            code = str(error) if isinstance(error, OtaError) else 'envelope'
            return self._envelope(seq, op, dict(ok=False, error=code))
        self.next_seq += 1
        try:
            try:
                body = _object(request['body'])
            except (ValueError, TypeError):
                raise OtaError('schema')
            result = self._dispatch(op, body)
            response = dict(ok=True, result=result)
        except OtaError as error:
            response = dict(ok=False, error=str(error))
        except (OSError, ValueError, TypeError):
            response = dict(ok=False, error='storage')
        envelope = self._envelope(seq, op, response)
        self._last_request = request_tuple
        self._last_response = envelope
        return dict(envelope)

    def boot_selection(self):
        if self._fault:
            return None
        if self._boot_selected:
            return dict(self.selected) if self.selected else None
        self._boot_selected = True
        self.healthy = False
        if self.trial:
            if self.trial['attempted']:
                self._save(self.confirmed, None, None)
            else:
                attempted = dict(self.trial)
                attempted['attempted'] = True
                # Never return executable trial until BOTH durable records say
                # attempted. Losing either record cannot grant a second trial.
                self._save(self.confirmed, self.candidate, attempted)
                try:
                    self._verify_file(self.candidate)
                    self.selected = dict(self.candidate)
                    return dict(self.selected)
                except (OSError, OtaError):
                    self._save(self.confirmed, None, None)
        if self.confirmed:
            try:
                self._verify_file(self.confirmed)
                self.selected = dict(self.confirmed)
            except (OSError, OtaError):
                self.selected = None
        return dict(self.selected) if self.selected else None

    def mark_healthy(self):
        if self._fault or not self._boot_selected or self.selected is None:
            return False
        self.healthy = True
        return True

    def _control(self, op, body):
        names = () if op == 'rollback' else ('sha256',)
        if not _keys(body, names) or (op != 'rollback' and not _ishex(body['sha256'], 64)):
            raise OtaError('schema')
        if self._fault:
            raise OtaError('storage_fault')
        if op == 'activate':
            if self.trial or self.receiving:
                raise OtaError('busy')
            if not self.candidate or self.candidate['sha256'] != body['sha256']:
                raise OtaError('candidate')
            self._verify_file(self.candidate)
            trial = dict(self.candidate)
            trial['attempted'] = False
            self._save(self.confirmed, self.candidate, trial)
            self.healthy = False
        elif op == 'confirm':
            if (not self.trial or not self.trial['attempted'] or not self.healthy or
                    self.selected != self.candidate or self.selected['sha256'] != body['sha256']):
                raise OtaError('not_healthy_trial')
            self._verify_file(self.selected)
            self._save(dict(self.selected), None, None)
        else:
            self._save(self.confirmed, None, None)
            self.receiving = None
            self.healthy = False
        result = self.status()
        if op in ('activate', 'rollback'):
            result['restart'] = True
        return result

    def _dispatch(self, op, body):
        if op in ('activate', 'confirm', 'rollback'):
            return self._control(op, body)
        if op == 'status':
            if not _keys(body, ()):
                raise OtaError('schema')
            return self.status()
        schemas = {'begin': ('transfer', 'size', 'sha256'),
                   'chunk': ('transfer', 'offset', 'data'),
                   'finish': ('transfer',), 'abort': ('transfer',)}
        if op not in schemas:
            raise OtaError('operation')
        if not _keys(body, schemas[op]):
            raise OtaError('schema')
        if not _ishex(body['transfer'], 32):
            raise OtaError('schema')
        if self._fault:
            raise OtaError('storage_fault')
        if op == 'begin':
            if not _integer(body['size'], 1, 131072) or not _ishex(body['sha256'], 64):
                raise OtaError('schema')
            if self.trial is not None or self.receiving is not None:
                raise OtaError('busy')
            slot = 'b' if self.confirmed and self.confirmed['slot'] == 'a' else 'a'
            self._save(self.confirmed, None, None)
            with open(self._path(slot), 'wb') as stream:
                stream.write(b'')
            self.receiving = dict(transfer=body['transfer'], size=body['size'],
                                  sha256=body['sha256'], slot=slot, offset=0)
            return self.status()
        transfer = self.receiving
        if transfer is None or body['transfer'] != transfer['transfer']:
            raise OtaError('transfer')
        if op == 'abort':
            self.receiving = None
            return self.status()
        if op == 'chunk':
            if (not _integer(body['offset'], 0, 131072) or type(body['data']) is not str or
                    not 2 <= len(body['data']) <= 2048 or len(body['data']) % 2 or
                    not _ishex(body['data'], len(body['data']))):
                raise OtaError('schema')
            data = binascii.unhexlify(body['data'])
            offset = body['offset']
            end = offset + len(data)
            if end > transfer['size'] or offset > transfer['offset']:
                raise OtaError('offset')
            if offset < transfer['offset']:
                if end > transfer['offset']:
                    raise OtaError('offset')
                with open(self._path(transfer['slot']), 'rb') as stream:
                    stream.seek(offset)
                    if stream.read(len(data)) != data:
                        raise OtaError('chunk_mismatch')
            else:
                with open(self._path(transfer['slot']), 'r+b') as stream:
                    stream.seek(offset)
                    if stream.write(data) != len(data):
                        raise OtaError('short_write')
                with open(self._path(transfer['slot']), 'rb') as stream:
                    stream.seek(offset)
                    if stream.read(len(data)) != data:
                        raise OtaError('readback')
                transfer['offset'] = end
            return self.status()
        descriptor = dict(slot=transfer['slot'], size=transfer['size'], sha256=transfer['sha256'])
        if transfer['offset'] != transfer['size']:
            raise OtaError('incomplete')
        self._verify_file(descriptor)
        self._save(self.confirmed, descriptor, None)
        self.receiving = None
        return self.status()
