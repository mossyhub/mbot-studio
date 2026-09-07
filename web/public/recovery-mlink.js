/**
 * Browser-side mLink client for CyberPi firmware upload.
 *
 * This runs entirely in the browser, connecting directly to
 * ws://127.0.0.1:52384/ (mLink2 on the user's local machine).
 * No server-side proxy needed — works even when the mBot Studio
 * server is running remotely in Docker.
 *
 * Protocol: JSON-RPC 2.0 + F3F4 binary file transfer framing.
 */

const MLINK_PORT = 52384;
const MLINK_URL = `ws://127.0.0.1:${MLINK_PORT}/`;

// ─── F3F4 Binary Protocol Helpers ──────────────────────────────────

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

function sanitizeFlashRelativePath(name) {
  const raw = String(name || '').replace(/\\/g, '/');
  const stripped = raw.replace(/^\/+/, '');
  const segments = stripped
    .split('/')
    .filter(Boolean)
    .map((seg) => seg.replace(/[^a-zA-Z0-9_.-]/g, '_'))
    .filter(Boolean);
  const safe = segments.filter((seg) => seg !== '.' && seg !== '..');
  return safe.join('/') || 'untitled.txt';
}

function textToBytes(text) {
  return Array.from(new TextEncoder().encode(text));
}

function buildFileTransferHeader(filePath, dataBytes) {
  const pathBytes = textToBytes(filePath);
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

function fileToProtocolPackets(filePath, dataBytes) {
  const packets = [];
  packets.push(wrapF3F4(buildFileTransferHeader(filePath, dataBytes)));
  const numChunks = Math.ceil(dataBytes.length / FILE_TRANSFER_BLOCK_LENGTH);
  for (let i = 0; i < numChunks; i++) {
    const offset = i * FILE_TRANSFER_BLOCK_LENGTH;
    const end = Math.min(offset + FILE_TRANSFER_BLOCK_LENGTH, dataBytes.length);
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

// ─── WebSocket Session ─────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Discover if mLink is running. Returns { ok, version, channels }.
 */
export async function discoverMlink({ timeoutMs = 2500 } = {}) {
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(MLINK_URL);
    } catch {
      return reject(new Error('Browser blocked WebSocket to mLink (127.0.0.1:52384)'));
    }

    const state = { version: null, channels: [] };

    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* */ }
      resolve({ ok: true, ...state });
    }, timeoutMs);

    ws.onopen = () => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'rpc.discover', params: {} }));
    };

    ws.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        if (parsed?.method === 'nofifyMessage' && parsed?.params?.version) {
          state.version = parsed.params.version;
        }
        if (parsed?.method === 'notifyConnected' && Array.isArray(parsed?.params)) {
          state.channels = parsed.params;
        }
      } catch { /* non-JSON message, ignore */ }
    };

    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('Could not connect to mLink at ws://127.0.0.1:52384/. Is mLink2 running?'));
    };

    ws.onclose = () => {
      clearTimeout(timer);
      resolve({ ok: true, ...state });
    };
  });
}

/**
 * Create a persistent mLink session with JSON-RPC call support.
 */
function createSession({ timeoutMs = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(MLINK_URL);
      ws.binaryType = 'arraybuffer';
    } catch {
      return reject(new Error('Browser blocked WebSocket to mLink'));
    }

    const pending = new Map();
    const callbackListeners = new Map();
    let requestId = 100;
    let callbackId = 500;
    const welcome = { version: null, channels: [] };

    const cleanup = () => {
      for (const [, req] of pending) {
        clearTimeout(req.timer);
        req.reject(new Error('mLink session closed'));
      }
      pending.clear();
      callbackListeners.clear();
    };

    const timer = setTimeout(() => {
      reject(new Error('Timed out connecting to mLink'));
      try { ws.close(); } catch { /* */ }
    }, timeoutMs);

    ws.onopen = () => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'rpc.discover', params: {} }));
      clearTimeout(timer);

      const session = {
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
              rejectCall(new Error(`Timeout: ${method}`));
            }, callTimeoutMs);

            pending.set(id, {
              resolve: resolveCall,
              reject: rejectCall,
              timer: callTimer,
            });

            ws.send(JSON.stringify(payload));
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

        sleep,

        close() {
          try { ws.close(); } catch { /* */ }
        },
      };

      resolve(session);
    };

    ws.onmessage = (event) => {
      // Handle both text and binary messages
      let text;
      if (typeof event.data === 'string') {
        text = event.data;
      } else if (event.data instanceof ArrayBuffer) {
        text = new TextDecoder().decode(event.data);
      } else {
        return;
      }

      let parsed;
      try { parsed = JSON.parse(text); } catch { return; }

      if (parsed?.method === 'nofifyMessage' && parsed?.params?.version) {
        welcome.version = parsed.params.version;
      }
      if (parsed?.method === 'notifyConnected' && Array.isArray(parsed?.params)) {
        welcome.channels = parsed.params;
      }

      // RPC response
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

      // Callback dispatch
      if (parsed?.type === 'JSON_RPC_CALLBACK' && typeof parsed.id === 'number') {
        const listener = callbackListeners.get(parsed.id);
        if (typeof listener === 'function') {
          listener(parsed);
        }
      }
    };

    ws.onerror = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error('Could not connect to mLink at ws://127.0.0.1:52384/'));
    };

    ws.onclose = () => {
      cleanup();
    };
  });
}

// ─── Serial Data Channel ──────────────────────────────────────────

async function openSerialChannel({ session, preferredPort = null }) {
  const listed = await session.call('data-channel', 'list', ['serialport'], 2400);
  const channels = Array.isArray(listed) ? listed : [];

  const chosen = preferredPort
    ? channels.find((ch) => {
        const comName = ch?.info?.comName;
        const path = ch?.info?.path;
        return comName === preferredPort || path === preferredPort;
      })
    : channels[0];

  if (!chosen || typeof chosen.id === 'undefined') {
    return {
      ok: false,
      listed: channels,
      reason: preferredPort
        ? `No serial channel found for ${preferredPort}`
        : 'No serial channels found',
    };
  }

  const responseEvents = [];
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
  const onClose = session.registerCallback(() => {});

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

    await sleep(600);

    const opened = responseEvents.some((params) => {
      if (!Array.isArray(params) || params.length < 2) return false;
      const [error, result] = params;
      return !error && result?.open === true;
    });

    return {
      ok: opened,
      listed: channels,
      chosen,
      dataTail,
      dispose: () => {
        onResponse.dispose();
        onData.dispose();
        onClose.dispose();
      },
      reason: opened ? null : 'Serial port did not open',
    };
  } catch (error) {
    onResponse.dispose();
    onData.dispose();
    onClose.dispose();
    throw error;
  }
}

// ─── List Serial Ports ────────────────────────────────────────────

export async function listSerialPorts() {
  const session = await createSession();
  try {
    const result = await session.call('data-channel', 'list', ['serialport'], 2400);
    return {
      ok: true,
      ports: Array.isArray(result) ? result : [],
    };
  } catch (error) {
    return { ok: false, ports: [], error: error.message };
  } finally {
    session.close();
  }
}

// ─── Upload Files ─────────────────────────────────────────────────

/**
 * Upload firmware files to CyberPi via mLink, entirely from the browser.
 *
 * @param {Object} options
 * @param {Array<{name: string, content: string}>} options.files - Files to upload
 * @param {string} [options.serialPort] - Preferred COM port
 * @param {number} [options.slot=1] - Program slot (1-8)
 * @param {function} [options.onProgress] - Progress callback: (message: string) => void
 * @returns {Promise<{ok: boolean, uploaded: string[], diagnostics: Array}>}
 */
export async function uploadViaMlink({ files, serialPort = null, slot = 1, onProgress }) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('No files to upload');
  }

  const log = (msg) => { if (typeof onProgress === 'function') onProgress(msg); };
  const diagnostics = [];

  log('Connecting to mLink...');
  const session = await createSession();

  try {
    log('Opening serial channel...');
    const serial = await openSerialChannel({ session, preferredPort: serialPort });
    diagnostics.push({ step: 'serial_connect', ok: serial.ok, chosen: serial.chosen || null });

    if (!serial.ok) {
      throw new Error(`Could not open serial channel. ${serial.reason || ''} Is another app using the COM port?`);
    }

    const targetSlot = Math.max(1, Math.min(8, Math.floor(Number(slot) || 1)));

    // Step 0: Select program slot
    if (targetSlot !== 1) {
      try {
        const slotScript = `from system import script_manager; script_manager.set_current_exe_id(${targetSlot}); script_manager.set_current_exe_type(script_manager.TYPE_USER_SCRIPT)`;
        const slotPacket = encodeScriptPacket({ script: slotScript, idx: 0, mode: 0x0 });
        await session.call('data-channel', 'writeData', [serial.chosen.id, Array.from(slotPacket)], 2500);
        await sleep(300);
      } catch { /* continue anyway */ }
    }

    // Step 1: Switch to offline (upload) mode
    const offlineModeCmd = wrapF3F4([0x0d, 0x00, 0x00]);
    await session.call('data-channel', 'writeData', [serial.chosen.id, offlineModeCmd], 1800);
    await sleep(500);
    serial.dataTail.length = 0;
    log('Device in upload mode');

    // Step 2: Upload each file
    const uploaded = [];
    for (const file of files) {
      const fileName = sanitizeFlashRelativePath(file?.name);
      const contentText = String(file?.content ?? '');
      const dataBytes = textToBytes(contentText);

      const stem = fileName.replace(/\.py$/, '');
      const isMainEntry = fileName === 'main.py';
      const flashPath = isMainEntry ? `/flash/_xx_${stem}.py` : `/flash/${fileName}`;

      const packets = fileToProtocolPackets(flashPath, dataBytes);
      const numChunks = packets.length - 1;

      log(`Uploading ${fileName} (${dataBytes.length} bytes, ${packets.length} packets)...`);

      let fileOk = true;
      for (let i = 0; i < packets.length; i++) {
        const rxBefore = serial.dataTail.length;

        await session.call('data-channel', 'writeData', [serial.chosen.id, packets[i]], 3000);

        // Wait for ACK
        let ackReceived = false;
        for (let attempt = 0; attempt < 20; attempt++) {
          await sleep(80);
          const newBytes = serial.dataTail.slice(rxBefore);
          if (newBytes.length >= 7) {
            const frames = parseF3F4Frames(newBytes);
            for (const frame of frames) {
              const ack = parseFileTransferAck(frame.payload);
              if (ack) {
                if (!ack.success) {
                  diagnostics.push({ step: 'packet_fail', file: fileName, status: ack.status });
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
          diagnostics.push({ step: 'packet_timeout', file: fileName, packet: i });
          fileOk = false;
          break;
        }
      }

      diagnostics.push({ step: 'file_done', file: fileName, flashPath, ok: fileOk });

      if (!fileOk) {
        throw new Error(`Upload failed for ${fileName}`);
      }

      uploaded.push(fileName);
      log(`✅ ${fileName}`);
    }

    // Step 3: Trigger run (send offline mode again)
    serial.dataTail.length = 0;
    await session.call('data-channel', 'writeData', [serial.chosen.id, offlineModeCmd], 1800);
    await sleep(600);

    // Close serial channel
    try {
      await session.call('data-channel', 'close', [serial.chosen.id], 1800);
    } catch { /* ignore */ }
    serial.dispose();

    log('✅ Upload complete — program is running on the CyberPi');
    return { ok: true, uploaded, diagnostics };
  } finally {
    session.close();
  }
}

// ─── Script Packet (for slot selection) ───────────────────────────

function encodeScriptPacket({ script, idx, mode }) {
  const scriptBytes = textToBytes(String(script || ''));
  const scriptLen = scriptBytes.length;
  const data = [scriptLen & 0xff, (scriptLen >> 8) & 0xff, ...scriptBytes];
  const normalizedMode = typeof mode === 'number' ? mode : 0x0;
  const normalizedIdx = typeof idx === 'number' ? idx : 0;
  const datalen = data.length + 4;
  const datalenLo = datalen & 0xff;
  const datalenHi = (datalen >> 8) & 0xff;
  const sumByte = (((datalenHi & 0xff) + (datalenLo & 0xff) + 0xf3) & 0xff);
  let checksum = (0x28 + normalizedMode + ((normalizedIdx >> 8) & 0xff) + (normalizedIdx & 0xff)) & 0xff;
  for (const b of data) {
    checksum = (checksum + b) & 0xff;
  }
  return [
    0xf3, sumByte, datalenLo, datalenHi,
    0x28, normalizedMode,
    normalizedIdx & 0xff, (normalizedIdx >> 8) & 0xff,
    ...data,
    checksum, 0xf4,
  ];
}
