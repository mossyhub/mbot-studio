import WebSocket from 'ws';

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function discoverMlink({ port = 52384, timeoutMs = 2500 } = {}) {
  return new Promise((resolve, reject) => {
    const url = `ws://127.0.0.1:${port}/`;
    const ws = new WebSocket(url);

    const state = {
      url,
      port,
      version: null,
      channels: [],
      messages: [],
    };

    const done = (fn, value) => {
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      } catch {
        // ignore close errors
      }
      fn(value);
    };

    const timer = setTimeout(() => {
      done(resolve, {
        ok: true,
        ...state,
      });
    }, timeoutMs);

    ws.on('open', () => {
      const payload = {
        jsonrpc: '2.0',
        id: 1,
        method: 'rpc.discover',
        params: {},
      };
      ws.send(JSON.stringify(payload));
    });

    ws.on('message', (raw) => {
      const text = String(raw || '');
      const parsed = safeJsonParse(text);
      state.messages.push(parsed || text);

      if (parsed?.method === 'nofifyMessage' && parsed?.params?.version) {
        state.version = parsed.params.version;
      }

      if (parsed?.method === 'notifyConnected' && Array.isArray(parsed?.params)) {
        state.channels = parsed.params;
      }
    });

    ws.on('error', (error) => {
      clearTimeout(timer);
      done(reject, new Error(`Could not connect to mLink websocket at ${url}: ${error.message}`));
    });

    ws.on('close', () => {
      clearTimeout(timer);
      resolve({ ok: true, ...state });
    });
  });
}

function createMlinkSession({ port = 52384, timeoutMs = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = `ws://127.0.0.1:${port}/`;
    const ws = new WebSocket(url);

    const pending = new Map();
    const callbackListeners = new Map();
    let requestId = 100;
    let callbackId = 500;
    const welcome = {
      version: null,
      channels: [],
      messages: [],
    };

    const cleanup = () => {
      for (const [, req] of pending) {
        clearTimeout(req.timer);
        req.reject(new Error('mLink session closed before response'));
      }
      pending.clear();
      callbackListeners.clear();
    };

    const timer = setTimeout(() => {
      reject(new Error(`Timed out connecting to mLink websocket at ${url}`));
      try { ws.close(); } catch { }
    }, timeoutMs);

    ws.on('open', () => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'rpc.discover', params: {} }));
      clearTimeout(timer);

      const session = {
        url,
        port,
        ws,
        getWelcome: () => ({ ...welcome }),
        async call(service, method, params = [], callTimeoutMs = 1800) {
          const id = ++requestId;
          const payload = {
            jsonrpc: '2.0',
            id,
            service,
            method,
            params: Array.isArray(params) ? params : [params],
          };

          return new Promise((resolveCall, rejectCall) => {
            const callTimer = setTimeout(() => {
              pending.delete(id);
              rejectCall(new Error(`Timeout waiting for mLink response: ${method}`));
            }, callTimeoutMs);

            pending.set(id, {
              resolve: resolveCall,
              reject: rejectCall,
              timer: callTimer,
              method,
            });

            try {
              ws.send(JSON.stringify(payload));
            } catch (error) {
              clearTimeout(callTimer);
              pending.delete(id);
              rejectCall(error);
            }
          });
        },
        registerCallback(handler) {
          const id = ++callbackId;
          callbackListeners.set(id, handler);
          return {
            id,
            placeholder: { type: 'JSON_RPC_CALLBACK', id },
            dispose: () => callbackListeners.delete(id),
          };
        },
        sleep(ms) {
          return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
        },
        close() {
          try {
            ws.close();
          } catch {
            // ignore
          }
        },
      };

      resolve(session);
    });

    ws.on('message', (raw) => {
      const text = String(raw || '');
      const parsed = safeJsonParse(text);
      welcome.messages.push(parsed || text);

      if (parsed?.method === 'nofifyMessage' && parsed?.params?.version) {
        welcome.version = parsed.params.version;
      }

      if (parsed?.method === 'notifyConnected' && Array.isArray(parsed?.params)) {
        welcome.channels = parsed.params;
      }

      if (parsed && typeof parsed.id === 'number' && pending.has(parsed.id)) {
        const req = pending.get(parsed.id);
        clearTimeout(req.timer);
        pending.delete(parsed.id);
        if (parsed.error) {
          req.reject(new Error(typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error)));
        } else {
          req.resolve(parsed.result);
        }
        return;
      }

      if (parsed?.type === 'JSON_RPC_CALLBACK' && typeof parsed.id === 'number') {
        const listener = callbackListeners.get(parsed.id);
        if (typeof listener === 'function') {
          listener(parsed);
        }
      }
    });

    ws.on('error', (error) => {
      clearTimeout(timer);
      cleanup();
      reject(new Error(`Could not connect to mLink websocket at ${url}: ${error.message}`));
    });

    ws.on('close', () => {
      cleanup();
    });
  });
}

function sanitizeFlashRelativePath(name) {
  const raw = String(name || '').replace(/\\/g, '/');
  const stripped = raw.replace(/^\/+/, '');
  const segments = stripped
    .split('/')
    .filter(Boolean)
    .map((seg) => seg.replace(/[^a-zA-Z0-9_.-]/g, '_'))
    .filter(Boolean);

  // Prevent traversal and weird empty results.
  const safe = segments.filter((seg) => seg !== '.' && seg !== '..');
  const joined = safe.join('/');
  return joined || 'untitled.txt';
}


function decodeByteTail(byteArray) {
  try {
    const buf = Buffer.from(Array.isArray(byteArray) ? byteArray : []);
    const text = buf.toString('utf8');
    return text.replace(/\r\n/g, '\n');
  } catch {
    return '';
  }
}

async function openDataChannelSerialStreaming({ session, preferredPort = null }) {
  const listed = await session.call('data-channel', 'list', ['serialport'], 2400);
  const channels = Array.isArray(listed) ? listed : [];

  const chosen = preferredPort
    ? channels.find((channel) => {
      const comName = channel?.info?.comName;
      const path = channel?.info?.path;
      return comName === preferredPort || path === preferredPort;
    })
    : channels[0];

  if (!chosen || typeof chosen.id === 'undefined') {
    return {
      ok: false,
      listed: channels,
      reason: preferredPort
        ? `No serial channel found for ${preferredPort}`
        : 'No serial channels reported by data-channel.list(serialport)',
    };
  }

  const responseEvents = [];
  const closeEvents = [];
  const dataTail = [];
  const maxTailBytes = 65536;

  const onResponse = session.registerCallback((payload) => {
    responseEvents.push(payload?.params || []);
  });
  const onData = session.registerCallback((payload) => {
    const params = Array.isArray(payload?.params) ? payload.params : [];
    const chunk = params[0];
    if (!Array.isArray(chunk) || chunk.length === 0) return;

    for (const byte of chunk) {
      dataTail.push(byte);
    }
    if (dataTail.length > maxTailBytes) {
      dataTail.splice(0, dataTail.length - maxTailBytes);
    }
  });
  const onClose = session.registerCallback((payload) => {
    closeEvents.push(payload?.params || []);
  });

  try {
    await session.call(
      'data-channel',
      'connect',
      [
        chosen.id,
        { baudRate: 115200, connectType: 'serialport' },
        onResponse.placeholder,
        onData.placeholder,
        onClose.placeholder,
      ],
      2800,
    );

    await session.sleep(600);

    const opened = responseEvents.some((params) => {
      if (!Array.isArray(params) || params.length < 2) return false;
      const [error, result] = params;
      return !error && result?.open === true;
    });

    return {
      ok: opened,
      listed: channels,
      chosen,
      responseEvents,
      closeEvents,
      dataTail,
      dispose: () => {
        onResponse.dispose();
        onData.dispose();
        onClose.dispose();
      },
      reason: opened ? null : 'No open=true callback received from data-channel.connect',
    };
  } catch (error) {
    onResponse.dispose();
    onData.dispose();
    onClose.dispose();
    throw error;
  }
}

async function execDeviceScriptCapture({ session, channelId, script, idx, waitMs = 450 }) {
  const packet = encodeHalocodeScriptPacket({ script, idx, mode: 0x0 });
  await session.call('data-channel', 'writeData', [channelId, Array.from(packet)], 2500);
  await session.sleep(waitMs);
}

async function openDataChannelSerial({ session, preferredPort = null }) {
  const listed = await session.call('data-channel', 'list', ['serialport'], 2400);
  const channels = Array.isArray(listed) ? listed : [];

  const chosen = preferredPort
    ? channels.find((channel) => {
      const comName = channel?.info?.comName;
      const path = channel?.info?.path;
      return comName === preferredPort || path === preferredPort;
    })
    : channels[0];

  if (!chosen || typeof chosen.id === 'undefined') {
    return {
      ok: false,
      listed: channels,
      reason: preferredPort
        ? `No serial channel found for ${preferredPort}`
        : 'No serial channels reported by data-channel.list(serialport)',
    };
  }

  const responseEvents = [];
  const closeEvents = [];
  const dataTail = [];
  const maxTailBytes = 8192;

  const onResponse = session.registerCallback((payload) => {
    responseEvents.push(payload?.params || []);
  });
  const onData = session.registerCallback((payload) => {
    const params = Array.isArray(payload?.params) ? payload.params : [];
    const chunk = params[0];
    if (!Array.isArray(chunk) || chunk.length === 0) return;

    for (const byte of chunk) {
      dataTail.push(byte);
    }
    if (dataTail.length > maxTailBytes) {
      dataTail.splice(0, dataTail.length - maxTailBytes);
    }
  });
  const onClose = session.registerCallback((payload) => {
    closeEvents.push(payload?.params || []);
  });

  try {
    await session.call(
      'data-channel',
      'connect',
      [
        chosen.id,
        { baudRate: 115200, connectType: 'serialport' },
        onResponse.placeholder,
        onData.placeholder,
        onClose.placeholder,
      ],
      2800,
    );

    await session.sleep(700);

    const opened = responseEvents.some((params) => {
      if (!Array.isArray(params) || params.length < 2) return false;
      const [error, result] = params;
      return !error && result?.open === true;
    });

    return {
      ok: opened,
      listed: channels,
      chosen,
      responseEvents,
      closeEvents,
      dataTail,
      reason: opened ? null : 'No open=true callback received from data-channel.connect',
    };
  } finally {
    onResponse.dispose();
    onData.dispose();
    onClose.dispose();
  }
}

function encodeHalocodeScriptPacket({ script, idx, mode }) {
  const header = 0xf3;
  const footer = 0xf4;
  const type = 0x28; // TYPE_SCRIPT
  const normalizedMode = typeof mode === 'number' ? mode : 0x0;
  const normalizedIdx = typeof idx === 'number' ? idx : 0;

  const scriptBytes = Buffer.from(String(script || ''), 'utf8');
  const scriptLen = scriptBytes.length;
  const data = Buffer.concat([
    Buffer.from([scriptLen & 0xff, (scriptLen >> 8) & 0xff]),
    scriptBytes,
  ]);

  // datalen = len(data) + 4 (type+mode+idxLo+idxHi)
  const datalen = data.length + 4;
  const datalenLo = datalen & 0xff;
  const datalenHi = (datalen >> 8) & 0xff;
  const sumByte = (((datalenHi & 0xff) + (datalenLo & 0xff) + header) & 0xff);

  let checksum = (type + normalizedMode + ((normalizedIdx >> 8) & 0xff) + (normalizedIdx & 0xff)) & 0xff;
  for (const b of data) {
    checksum = (checksum + b) & 0xff;
  }

  return Buffer.concat([
    Buffer.from([
      header,
      sumByte,
      datalenLo,
      datalenHi,
      type,
      normalizedMode,
      normalizedIdx & 0xff,
      (normalizedIdx >> 8) & 0xff,
    ]),
    data,
    Buffer.from([checksum, footer]),
  ]);
}

// ─── F3F4 Binary File Transfer Protocol ────────────────────────────
// Reverse-engineered from mBlock5 application (CyberPi upload engine).
// Protocol uses F3F4 framing with sub-protocol 0x5E for file transfer.

const FILE_TRANSFER_BLOCK_LENGTH = 80;
const FILE_TRANSFER_PROTO_ID = [0x00, 0x5E];

function f3f4SumBytes(arr) {
  let s = 0;
  for (const b of arr) s += b;
  return s;
}

function wrapF3F4(payload) {
  const len = payload.length;
  const lenLo = len & 0xFF;
  const lenHi = (len >> 8) & 0xFF;
  const sumByte = (0xF3 + lenLo + lenHi) & 0xFF;
  const checksum = f3f4SumBytes(payload) & 0xFF;
  return [0xF3, sumByte, lenLo, lenHi, ...payload, checksum, 0xF4];
}

function int32LE(n) {
  return [n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF, (n >> 24) & 0xFF];
}

function int16LE(n) {
  return [n & 0xFF, (n >> 8) & 0xFF];
}

function xorHash4(data) {
  const hash = [0, 0, 0, 0];
  const padded = [...data];
  const rem = padded.length % 4;
  if (rem !== 0) {
    for (let i = 0; i < (4 - rem); i++) padded.push(0);
  }
  const blocks = Math.ceil(padded.length / 4);
  for (let i = 0; i < blocks; i++) {
    hash[0] ^= padded[4 * i + 0];
    hash[1] ^= padded[4 * i + 1];
    hash[2] ^= padded[4 * i + 2];
    hash[3] ^= padded[4 * i + 3];
  }
  return hash;
}

function buildFileTransferHeader(filePath, dataBytes) {
  const pathBytes = Array.from(Buffer.from(filePath, 'utf8'));
  const innerPayload = [
    1,
    ...int32LE(dataBytes.length),
    ...xorHash4(dataBytes),
    ...pathBytes,
  ];
  const payloadLen = int16LE(innerPayload.length);
  return [1, ...FILE_TRANSFER_PROTO_ID, 0x01, payloadLen[0], payloadLen[1], ...innerPayload];
}

function buildFileTransferBody(offset, chunkData) {
  const offsetBytes = int32LE(offset);
  const payloadLen = int16LE(offsetBytes.length + chunkData.length);
  return [1, ...FILE_TRANSFER_PROTO_ID, 0x02, payloadLen[0], payloadLen[1], ...offsetBytes, ...chunkData];
}

function fileToProtocolPackets(filePath, dataBytes, blockLength = FILE_TRANSFER_BLOCK_LENGTH) {
  const packets = [];
  packets.push(wrapF3F4(buildFileTransferHeader(filePath, dataBytes)));
  const numChunks = Math.ceil(dataBytes.length / blockLength);
  for (let i = 0; i < numChunks; i++) {
    const offset = i * blockLength;
    const end = Math.min(offset + blockLength, dataBytes.length);
    const chunk = dataBytes.slice(offset, end);
    packets.push(wrapF3F4(buildFileTransferBody(offset, chunk)));
  }
  return packets;
}

function parseF3F4Frames(buffer) {
  const frames = [];
  let i = 0;
  while (i < buffer.length) {
    if (buffer[i] !== 0xF3) { i++; continue; }
    if (i + 3 >= buffer.length) break;
    const lenLo = buffer[i + 2];
    const lenHi = buffer[i + 3];
    const payloadLen = lenLo | (lenHi << 8);
    const frameEnd = i + 4 + payloadLen + 2;
    if (frameEnd > buffer.length) break;
    if (buffer[frameEnd - 1] !== 0xF4) { i++; continue; }
    const payload = buffer.slice(i + 4, i + 4 + payloadLen);
    frames.push({ payload, raw: buffer.slice(i, frameEnd) });
    i = frameEnd;
  }
  return frames;
}

function parseFileTransferAck(payload) {
  if (payload.length < 7) return null;
  if (payload[0] !== 1 || payload[1] !== 0x00 || payload[2] !== 0x5E) return null;
  if (payload[3] !== 0xF0) return null;
  return { status: payload[5], success: payload[5] === 0 };
}

async function uploadFilesToCyberpiFlash({ session, channelId, files, dataTail, slot = 1 }) {
  const diagnostics = [];
  const targetSlot = Math.max(1, Math.min(8, Math.floor(Number(slot) || 1)));

  // ── Step 0 (optional): Select target program slot ────────────────
  if (targetSlot !== 1) {
    try {
      const slotScript = `from system import script_manager; script_manager.set_current_exe_id(${targetSlot}); script_manager.set_current_exe_type(script_manager.TYPE_USER_SCRIPT)`;
      await execDeviceScriptCapture({ session, channelId, script: slotScript, idx: 0, waitMs: 300 });
      diagnostics.push({ step: 'set_target_slot', slot: targetSlot, ok: true });
    } catch (err) {
      diagnostics.push({ step: 'set_target_slot', slot: targetSlot, ok: false, error: err.message });
      // Continue anyway — upload may still land on slot 1
    }
  } else {
    diagnostics.push({ step: 'set_target_slot', slot: targetSlot, ok: true, note: 'default' });
  }

  // ── Step 1: Switch to offline (upload) mode ──────────────────────
  const offlineModeCmd = wrapF3F4([0x0d, 0x00, 0x00]);
  await session.call('data-channel', 'writeData', [channelId, offlineModeCmd], 1800);
  await session.sleep(500);
  diagnostics.push({ step: 'goto_offline_mode', ok: true });

  // Drain any initial data so we have a clean baseline for ACK detection.
  dataTail.length = 0;

  // ── Step 2: Upload each file via binary protocol ─────────────────
  for (const file of files) {
    const fileName = sanitizeFlashRelativePath(file?.name);
    const contentText = String(file?.content ?? '');
    const dataBytes = Array.from(Buffer.from(contentText, 'utf8'));

    // Use the _xx_ prefix for main.py (Makeblock slot convention for CyberPi).
    // Do NOT write to /flash/main.py — it conflicts with CyberPi's boot sequence.
    const stem = fileName.replace(/\.py$/, '');
    const isMainEntry = fileName === 'main.py';
    const flashPath = isMainEntry ? `/flash/_xx_${stem}.py` : `/flash/${fileName}`;

    const packets = fileToProtocolPackets(flashPath, dataBytes, FILE_TRANSFER_BLOCK_LENGTH);
    const numChunks = packets.length - 1;

    diagnostics.push({
      step: 'file_begin',
      file: fileName,
      flashPath,
      bytes: dataBytes.length,
      packets: packets.length,
    });

    let fileOk = true;

    for (let i = 0; i < packets.length; i++) {
      const packet = packets[i];
      const label = i === 0 ? 'header' : `body[${i - 1}/${numChunks}]`;
      const rxBefore = dataTail.length;

      await session.call('data-channel', 'writeData', [channelId, packet], 3000);

      // Wait for ACK response (status byte inside F3F4 frame).
      let ackReceived = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        await session.sleep(80);
        const newBytes = dataTail.slice(rxBefore);
        if (newBytes.length >= 7) {
          const frames = parseF3F4Frames(newBytes);
          for (const frame of frames) {
            const ack = parseFileTransferAck(frame.payload);
            if (ack) {
              if (!ack.success) {
                const errors = { 1: 'firmware check error', 240: 'encoding error (0xF0)' };
                diagnostics.push({ step: 'packet_fail', file: fileName, label, status: ack.status, error: errors[ack.status] || 'unknown' });
                fileOk = false;
              }
              ackReceived = true;
              break;
            }
          }
          if (ackReceived) break;
        }
      }

      if (!ackReceived) {
        diagnostics.push({ step: 'packet_timeout', file: fileName, label });
        fileOk = false;
        break; // Stop uploading this file if a packet fails.
      }
    }

    diagnostics.push({ step: 'file_done', file: fileName, flashPath, ok: fileOk });

    if (!fileOk) {
      // Abort remaining files if one fails.
      diagnostics.push({ step: 'upload_aborted', reason: `File transfer failed for ${fileName}` });
      return diagnostics;
    }

  }

  // ── Step 3: Switch to offline mode again (triggers program execution) ──
  dataTail.length = 0;
  await session.call('data-channel', 'writeData', [channelId, offlineModeCmd], 1800);
  await session.sleep(600);
  diagnostics.push({ step: 'trigger_run', ok: true });

  return diagnostics;
}


export async function uploadViaMlink({ files, port = 52384, serialPort = null, slot = 1 }) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('No files supplied for mLink upload');
  }

  const session = await createMlinkSession({ port });
  const diagnostics = [];
  const uploaded = [];

  try {
    // Use streaming channel so we can read ACK responses from the device.
    const serialConnect = await openDataChannelSerialStreaming({ session, preferredPort: serialPort });
    diagnostics.push({ system: 'serial-connect', ok: serialConnect.ok, details: { chosen: serialConnect.chosen, reason: serialConnect.reason } });

    if (!serialConnect.ok) {
      const failure = new Error('mLink could not open a serial data-channel to the device. Is another app holding the COM port?');
      failure.details = { welcome: session.getWelcome(), diagnostics };
      throw failure;
    }

    const fileNames = files.map((f) => sanitizeFlashRelativePath(f?.name));
    for (const name of fileNames) uploaded.push(name);

    const deviceDiagnostics = await uploadFilesToCyberpiFlash({
      session,
      channelId: serialConnect.chosen.id,
      files,
      dataTail: serialConnect.dataTail,
      slot: slot,
    });

    const allFilesOk = deviceDiagnostics.filter(d => d.step === 'file_done').every(d => d.ok);
    diagnostics.push({ system: 'device-upload', ok: allFilesOk, details: deviceDiagnostics });

    try {
      await session.call('data-channel', 'close', [serialConnect.chosen.id], 1800);
      diagnostics.push({ system: 'serial-close', ok: true, channelId: serialConnect.chosen.id });
    } catch (error) {
      diagnostics.push({ system: 'serial-close', ok: false, error: error.message, channelId: serialConnect.chosen.id });
    }

    serialConnect.dispose();

    return {
      ok: allFilesOk,
      uploaded,
      welcome: session.getWelcome(),
      diagnostics,
    };
  } finally {
    session.close();
  }
}

export async function probeMlinkServices({ port = 52384 } = {}) {
  const session = await createMlinkSession({ port });
  const diagnostics = [];

  try {
    const testPath = 'mbot_probe.txt';

    const calls = [
      { service: 'realFS', method: 'mkdir', params: ['.'], optional: true },
      { service: 'realFS', method: 'writeFile', params: [testPath, 'probe-ok'] },
      { service: 'realFS', method: 'readFile', params: [testPath], optional: true },
      { service: 'python-terminal', method: 'createTerminal', params: [[], {}], optional: true },
      { service: 'data-channel', method: 'list', params: ['serialport'], optional: true },
    ];

    for (const call of calls) {
      try {
        const result = await session.call(call.service, call.method, call.params, 2200);
        diagnostics.push({ ...call, ok: true, result });
      } catch (error) {
        diagnostics.push({ ...call, ok: false, error: error.message });
      }
    }

    try {
      const serialConnect = await openDataChannelSerial({ session, preferredPort: 'COM4' });
      diagnostics.push({ system: 'serial-connect', ok: serialConnect.ok, details: serialConnect });

      if (serialConnect.ok) {
        try {
          await session.call('data-channel', 'writeData', [serialConnect.chosen.id, [0xf0, 0xff, 0x10, 0x00, 0x0f, 0xf7]], 1800);
          diagnostics.push({ system: 'serial-ping', ok: true, channelId: serialConnect.chosen.id });
        } catch (error) {
          diagnostics.push({ system: 'serial-ping', ok: false, error: error.message, channelId: serialConnect.chosen.id });
        }

        try {
          await session.call('data-channel', 'close', [serialConnect.chosen.id], 1800);
          diagnostics.push({ system: 'serial-close', ok: true, channelId: serialConnect.chosen.id });
        } catch (error) {
          diagnostics.push({ system: 'serial-close', ok: false, error: error.message, channelId: serialConnect.chosen.id });
        }
      }
    } catch (error) {
      diagnostics.push({ system: 'serial-connect', ok: false, error: error.message });
    }

    return {
      ok: true,
      welcome: session.getWelcome(),
      diagnostics,
    };
  } finally {
    session.close();
  }
}

export async function listMlinkSerialPorts({ port = 52384 } = {}) {
  const session = await createMlinkSession({ port });

  try {
    const result = await session.call('data-channel', 'list', ['serialport'], 2400);
    const ports = Array.isArray(result) ? result : [];
    return {
      ok: true,
      ports,
      welcome: session.getWelcome(),
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
    };
  } finally {
    session.close();
  }
}

export async function diagnoseCyberpiPrograms({ port = 52384, serialPort = null } = {}) {
  const session = await createMlinkSession({ port });

  const diagnostics = [];
  try {
    const serial = await openDataChannelSerialStreaming({ session, preferredPort: serialPort });
    diagnostics.push({ step: 'serial_connect', ok: serial.ok, chosen: serial.chosen || null, reason: serial.reason || null });

    if (!serial.ok) {
      return { ok: false, error: 'Could not open serial channel via mLink', diagnostics, welcome: session.getWelcome() };
    }

    const startLen = serial.dataTail.length;
    let idx = 1;

    // Switch CyberPi into upload/offline mode so script packets are interpreted consistently.
    const gotoOffline = [0xf3, 0xf6, 0x03, 0x00, 0x0d, 0x00, 0x00, 0x0e, 0xf4];
    await session.call('data-channel', 'writeData', [serial.chosen.id, gotoOffline], 1800);
    await session.sleep(250);
    diagnostics.push({ step: 'goto_offline_mode', ok: true });

    // Print a clear marker so we can find output boundaries.
    await execDeviceScriptCapture({ session, channelId: serial.chosen.id, script: "print('MBOT_DIAG_BEGIN')", idx: idx++ });
    await execDeviceScriptCapture({ session, channelId: serial.chosen.id, script: "print('CWD '+str(__import__('os').getcwd()))", idx: idx++ });
    await execDeviceScriptCapture({ session, channelId: serial.chosen.id, script: "print('FLASH '+str(__import__('os').listdir('/flash')))", idx: idx++ });

    const dirs = ['apps', 'programs', 'projects', 'mblock', 'mcode', 'user', 'python', 'py'];
    for (const d of dirs) {
      const s = `print('DIR /flash/${d} '+str((__import__('os').listdir('/flash/${d}') if '${d}' in __import__('os').listdir('/flash') else 'MISSING')))`;
      await execDeviceScriptCapture({ session, channelId: serial.chosen.id, script: s, idx: idx++ });
    }

    const files = ['project.json', 'projects.json', 'program.json', 'programs.json', 'apps.json', 'app.json', 'manifest.json', 'meta.json'];
    for (const name of files) {
      const s = `print('FILE /flash/${name} '+str((open('/flash/${name}','rb').read(256) if '${name}' in __import__('os').listdir('/flash') else 'MISSING')))`;
      await execDeviceScriptCapture({ session, channelId: serial.chosen.id, script: s, idx: idx++ });
    }

    await execDeviceScriptCapture({ session, channelId: serial.chosen.id, script: "print('MBOT_DIAG_END')", idx: idx++ });

    const outputText = decodeByteTail(serial.dataTail.slice(startLen));
    diagnostics.push({ step: 'serial_output', bytes: serial.dataTail.length - startLen, textTail: outputText.slice(-4000) });

    try {
      await session.call('data-channel', 'close', [serial.chosen.id], 1800);
      diagnostics.push({ step: 'serial_close', ok: true, channelId: serial.chosen.id });
    } catch (error) {
      diagnostics.push({ step: 'serial_close', ok: false, error: error.message, channelId: serial.chosen.id });
    }

    serial.dispose();

    return {
      ok: true,
      welcome: session.getWelcome(),
      diagnostics,
      output: {
        text: outputText,
      },
    };
  } finally {
    session.close();
  }
}

export async function execCyberpiSnippet({ port = 52384, serialPort = null, script = '' } = {}) {
  const session = await createMlinkSession({ port });
  const diagnostics = [];

  try {
    const serial = await openDataChannelSerialStreaming({ session, preferredPort: serialPort });
    diagnostics.push({ step: 'serial_connect', ok: serial.ok, chosen: serial.chosen || null, reason: serial.reason || null });
    if (!serial.ok) {
      return { ok: false, error: 'Could not open serial channel via mLink', diagnostics, welcome: session.getWelcome() };
    }

    // Switch CyberPi into upload/offline mode so script packets are interpreted consistently.
    const gotoOffline = [0xf3, 0xf6, 0x03, 0x00, 0x0d, 0x00, 0x00, 0x0e, 0xf4];
    await session.call('data-channel', 'writeData', [serial.chosen.id, gotoOffline], 1800);
    await session.sleep(250);

    const startLen = serial.dataTail.length;
    await execDeviceScriptCapture({ session, channelId: serial.chosen.id, script: String(script || ''), idx: 1, waitMs: 650 });
    const outputText = decodeByteTail(serial.dataTail.slice(startLen));

    try {
      await session.call('data-channel', 'close', [serial.chosen.id], 1800);
    } catch {
      // ignore
    }
    serial.dispose();

    return {
      ok: true,
      welcome: session.getWelcome(),
      diagnostics,
      output: {
        text: outputText,
      },
    };
  } finally {
    session.close();
  }
}

export async function probePythonTerminal({ port = 52384 } = {}) {
  const session = await createMlinkSession({ port });
  const diagnostics = [];

  const candidates = [
    { method: 'createTerminal', params: [[], {}] },
    { method: 'getProjectList', params: [] },
    { method: 'listProjects', params: [] },
    { method: 'getProjects', params: [] },
    { method: 'getPrograms', params: [] },
    { method: 'listPrograms', params: [] },
    { method: 'getProgramList', params: [] },
    { method: 'getCurrentProject', params: [] },
    { method: 'getCurrentProgram', params: [] },
    { method: 'status', params: [] },
    { method: 'info', params: [] },
  ];

  try {
    for (const call of candidates) {
      try {
        const result = await session.call('python-terminal', call.method, call.params, 2200);
        diagnostics.push({ ...call, ok: true, result });
      } catch (error) {
        diagnostics.push({ ...call, ok: false, error: error.message });
      }
    }

    return {
      ok: true,
      welcome: session.getWelcome(),
      diagnostics,
    };
  } finally {
    session.close();
  }
}

export async function probeProgramNamingApis({ port = 52384 } = {}) {
  const session = await createMlinkSession({ port });
  const diagnostics = [];

  const services = ['systemCore', 'systeminfo', 'executor', 'channel', 'hello-world', 'python-terminal'];
  const methods = [
    'getProgramList',
    'listPrograms',
    'getPrograms',
    'programs',
    'getProjectList',
    'listProjects',
    'getProjects',
    'projects',
    'list',
    'info',
    'status',
  ];

  // Try a few parameter shapes commonly used in these services.
  const paramShapes = [
    [],
    [{}],
    ['program'],
    ['programs'],
    ['projects'],
  ];

  try {
    for (const service of services) {
      for (const method of methods) {
        for (const params of paramShapes) {
          const call = { service, method, params };
          try {
            const result = await session.call(service, method, params, 1600);
            diagnostics.push({ ...call, ok: true, result });
            // If we found a working call for this service+method, stop trying other param shapes.
            break;
          } catch (error) {
            diagnostics.push({ ...call, ok: false, error: error.message });
          }
        }
      }
    }

    return { ok: true, welcome: session.getWelcome(), diagnostics };
  } finally {
    session.close();
  }
}

function buildVirtualFsParamShapes(pathValue) {
  const p = String(pathValue || '');
  return [
    [p],
    [{ path: p }],
    [{ filePath: p }],
    [{ dir: p }],
    [p, {}],
    [{ path: p, encoding: 'utf8' }],
  ];
}

async function tryVirtualFsCall({ session, method, params, timeoutMs = 2200 }) {
  const result = await session.call('virtualfs', method, params, timeoutMs);
  return result;
}

export async function probeVirtualFs({ port = 52384, path = '/flash' } = {}) {
  const session = await createMlinkSession({ port });
  const diagnostics = [];

  const candidateMethods = [
    'readdir',
    'readDir',
    'list',
    'ls',
    'scandir',
    'stat',
    'exists',
    'readFile',
  ];

  try {
    for (const method of candidateMethods) {
      const shapes = method === 'readFile'
        ? [
          [String(path || '')],
          [{ path: String(path || '') }],
          [{ filePath: String(path || '') }],
        ]
        : buildVirtualFsParamShapes(path);

      for (const params of shapes) {
        const call = { service: 'virtualfs', method, params };
        try {
          const result = await tryVirtualFsCall({ session, method, params, timeoutMs: 2200 });
          diagnostics.push({ ...call, ok: true, result });
          break;
        } catch (error) {
          diagnostics.push({ ...call, ok: false, error: error.message });
        }
      }
    }

    return { ok: true, welcome: session.getWelcome(), diagnostics };
  } finally {
    session.close();
  }
}

export async function virtualFsListDir({ port = 52384, path = '/flash' } = {}) {
  const session = await createMlinkSession({ port });

  const candidateMethods = ['readdir', 'readDir', 'list', 'ls', 'scandir'];
  const attempted = [];

  try {
    for (const method of candidateMethods) {
      for (const params of buildVirtualFsParamShapes(path)) {
        attempted.push({ service: 'virtualfs', method, params });
        try {
          const result = await tryVirtualFsCall({ session, method, params, timeoutMs: 2600 });
          return {
            ok: true,
            path: String(path || ''),
            method,
            params,
            result,
            welcome: session.getWelcome(),
            attempted,
          };
        } catch {
          // keep trying
        }
      }
    }

    return {
      ok: false,
      error: 'No virtualfs directory-list method succeeded',
      path: String(path || ''),
      welcome: session.getWelcome(),
      attempted,
    };
  } finally {
    session.close();
  }
}