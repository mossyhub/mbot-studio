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

function sanitizeFileName(name) {
  return String(name || '').replace(/[^a-zA-Z0-9_.-]/g, '_');
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

function buildWriteChunkScripts({ flashPath, contentBuffer, chunkSize = 384 }) {
  const scripts = [];
  const total = contentBuffer.length;
  let offset = 0;
  let first = true;

  while (offset < total) {
    const slice = contentBuffer.subarray(offset, Math.min(offset + chunkSize, total));
    const base64 = Buffer.from(slice).toString('base64');
    const fileMode = first ? 'wb' : 'ab';
    first = false;

    // Keep the script very small; base64 alphabet is safe in single quotes.
    const script = [
      'import ubinascii',
      `f=open('${flashPath}','${fileMode}')`,
      `f.write(ubinascii.a2b_base64('${base64}'))`,
      'f.close()',
    ].join(';');

    scripts.push(script);
    offset += slice.length;
  }

  return scripts;
}

async function uploadFilesToCyberpiFlash({ session, channelId, files }) {
  const diagnostics = [];
  let idx = 1;

  // Switch CyberPi into upload/offline mode.
  // This packet is used by Makeblock tooling (see HalocodePackData.broadcast/offline patterns).
  const gotoOffline = [0xf3, 0xf6, 0x03, 0x00, 0x0d, 0x00, 0x00, 0x0e, 0xf4];
  await session.call('data-channel', 'writeData', [channelId, gotoOffline], 1800);
  await session.sleep(250);
  diagnostics.push({ step: 'goto_offline_mode', ok: true });

  for (const file of files) {
    const fileName = sanitizeFileName(file?.name);
    const flashPath = `/flash/${fileName}`;
    const contentText = String(file?.content ?? '');
    const contentBuffer = Buffer.from(contentText, 'utf8');
    const scripts = buildWriteChunkScripts({ flashPath, contentBuffer });

    diagnostics.push({ step: 'file_begin', file: fileName, flashPath, bytes: contentBuffer.length, chunks: scripts.length });

    for (let i = 0; i < scripts.length; i++) {
      const packet = encodeHalocodeScriptPacket({ script: scripts[i], idx, mode: 0x0 });
      idx = (idx + 1) & 0xffff;
      await session.call('data-channel', 'writeData', [channelId, Array.from(packet)], 2500);

      // Small pacing helps avoid overruns on some USB-serial adapters.
      await session.sleep(20);

      if ((i + 1) % 25 === 0) {
        diagnostics.push({ step: 'file_progress', file: fileName, sentChunks: i + 1, totalChunks: scripts.length });
      }
    }

    diagnostics.push({ step: 'file_done', file: fileName, ok: true });
  }

  // Soft reboot via script.
  try {
    const resetPacket = encodeHalocodeScriptPacket({ script: 'import machine;machine.reset()', idx, mode: 0x0 });
    await session.call('data-channel', 'writeData', [channelId, Array.from(resetPacket)], 2000);
    diagnostics.push({ step: 'reset', ok: true });
  } catch (error) {
    diagnostics.push({ step: 'reset', ok: false, error: error.message });
  }

  return diagnostics;
}

function buildWriteAttempts(fileName, content) {
  const fn = sanitizeFileName(fileName);
  const targetPath = fn;
  return [
    {
      service: 'realFS',
      method: 'mkdir',
      params: ['.'],
      optional: true,
    },
    {
      service: 'realFS',
      method: 'writeFile',
      params: [targetPath, content],
    },
    {
      service: 'realFS',
      method: 'writeFile',
      params: [targetPath, content, 'utf8'],
    },
    {
      service: 'realFS',
      method: 'writeFile',
      params: [{ path: targetPath, content }],
    },
    {
      service: 'realFS',
      method: 'writeFile',
      params: [{ filePath: targetPath, content }],
    },
  ];
}

export async function uploadViaMlink({ files, port = 52384, serialPort = null }) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('No files supplied for mLink upload');
  }

  const session = await createMlinkSession({ port });
  const diagnostics = [];
  const uploaded = [];

  try {
    const serialConnect = await openDataChannelSerial({ session, preferredPort: serialPort });
    diagnostics.push({ system: 'serial-connect', ok: serialConnect.ok, details: serialConnect });

    if (!serialConnect.ok) {
      const failure = new Error('mLink could not open a serial data-channel to the device. Is another app holding the COM port?');
      failure.details = { welcome: session.getWelcome(), diagnostics };
      throw failure;
    }

    const fileNames = files.map((f) => sanitizeFileName(f?.name));
    for (const name of fileNames) uploaded.push(name);

    const deviceDiagnostics = await uploadFilesToCyberpiFlash({
      session,
      channelId: serialConnect.chosen.id,
      files,
    });
    diagnostics.push({ system: 'device-upload', ok: true, details: deviceDiagnostics });

    try {
      await session.call('data-channel', 'close', [serialConnect.chosen.id], 1800);
      diagnostics.push({ system: 'serial-close', ok: true, channelId: serialConnect.chosen.id });
    } catch (error) {
      diagnostics.push({ system: 'serial-close', ok: false, error: error.message, channelId: serialConnect.chosen.id });
    }

    return {
      ok: true,
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