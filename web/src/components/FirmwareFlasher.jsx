import React, { useEffect, useMemo, useState } from 'react';
import './FirmwareFlasher.css';

const DEFAULT_SETTINGS = {
  wifiSsid: '',
  wifiPassword: '',
  mqttBroker: '',
  mqttPort: 1883,
  topicPrefix: 'mbot-studio',
  clientId: 'mbot2-rover',
  nativePort: '',
};

const supportsWebSerial = typeof navigator !== 'undefined' && !!navigator.serial;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function chunkString(str, size) {
  const chunks = [];
  for (let i = 0; i < str.length; i += size) {
    chunks.push(str.slice(i, i + size));
  }
  return chunks;
}

function replaceConfigValue(content, key, value) {
  const escaped = String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const regex = new RegExp(`^${key}\\s*=\\s*\".*\"`, 'm');
  if (regex.test(content)) {
    return content.replace(regex, `${key} = "${escaped}"`);
  }
  return content;
}

function applySettingsToConfig(content, settings) {
  let next = content;
  next = replaceConfigValue(next, 'WIFI_SSID', settings.wifiSsid || 'YOUR_WIFI_NAME');
  next = replaceConfigValue(next, 'WIFI_PASSWORD', settings.wifiPassword || 'YOUR_WIFI_PASSWORD');
  next = replaceConfigValue(next, 'MQTT_BROKER', settings.mqttBroker || 'YOUR_COMPUTER_IP');
  next = next.replace(/^MQTT_PORT\s*=\s*\d+/m, `MQTT_PORT = ${Math.max(1, Number(settings.mqttPort) || 1883)}`);
  next = replaceConfigValue(next, 'MQTT_TOPIC_PREFIX', settings.topicPrefix || 'mbot-studio');
  next = replaceConfigValue(next, 'MQTT_CLIENT_ID', settings.clientId || 'mbot2-rover');
  return next;
}

export default function FirmwareFlasher() {
  const [firmwareFiles, setFirmwareFiles] = useState([]);
  const [loadingFiles, setLoadingFiles] = useState(true);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [port, setPort] = useState(null);
  const [connected, setConnected] = useState(false);
  const [flashing, setFlashing] = useState(false);
  const [status, setStatus] = useState('');
  const [progress, setProgress] = useState([]);
  const [nativeSupport, setNativeSupport] = useState({ checked: false, ok: false, error: '', installHint: '' });
  const [nativePorts, setNativePorts] = useState([]);

  useEffect(() => {
    let active = true;

    fetch('/api/config/firmware')
      .then(r => r.json())
      .then((data) => {
        if (!active) return;
        setFirmwareFiles(data.files || []);
        const suggested = data.suggested || {};
        setSettings(prev => ({
          ...prev,
          mqttBroker: suggested.mqttBroker || window.location.hostname || '',
          mqttPort: suggested.mqttPort || 1883,
          topicPrefix: suggested.topicPrefix || prev.topicPrefix,
          clientId: suggested.clientId || prev.clientId,
        }));
      })
      .catch(() => {
        if (!active) return;
        setStatus('❌ Could not load firmware files from server.');
      })
      .finally(() => {
        if (active) setLoadingFiles(false);
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    fetch('/api/config/flash-native/ports')
      .then(r => r.json())
      .then((data) => {
        if (!active || !data?.ok) return;
        const ports = Array.isArray(data.ports) ? data.ports : [];
        setNativePorts(ports);
        setSettings(prev => {
          if (prev.nativePort || ports.length === 0) return prev;
          return { ...prev, nativePort: ports[0].port || '' };
        });
      })
      .catch(() => {
        if (!active) return;
        setNativePorts([]);
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    fetch('/api/config/flash-native/check')
      .then(r => r.json())
      .then((data) => {
        if (!active) return;
        setNativeSupport({
          checked: true,
          ok: !!data.ok,
          error: data.error || '',
          installHint: data.installHint || '',
        });
      })
      .catch(() => {
        if (!active) return;
        setNativeSupport({
          checked: true,
          ok: false,
          error: 'Could not check native flasher support',
          installHint: 'Install Python 3.10+ and run: py -3 -m pip install mpremote',
        });
      });

    return () => {
      active = false;
    };
  }, []);

  const filesToFlash = useMemo(() => {
    return firmwareFiles.map((file) => {
      if (file.name === 'config.py') {
        return { ...file, content: applySettingsToConfig(file.content, settings) };
      }
      return file;
    });
  }, [firmwareFiles, settings]);

  const setSetting = (key, value) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  const connectUsb = async () => {
    if (!supportsWebSerial) {
      setStatus('❌ Web Serial is unavailable. Use Chrome or Edge on localhost/https.');
      return;
    }

    try {
      const selectedPort = await navigator.serial.requestPort({ filters: [] });
      await selectedPort.open({ baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
      setPort(selectedPort);
      setConnected(true);
      setStatus('✅ USB connected. Ready to flash firmware.');
    } catch (error) {
      setStatus(`❌ USB connect failed: ${error.message}`);
    }
  };

  const disconnectUsb = async () => {
    if (!port) return;
    try {
      await port.close();
    } catch {
      // ignore
    }
    setConnected(false);
    setPort(null);
    setStatus('USB disconnected.');
  };

  const readWithTimeout = async (reader, timeoutMs) => {
    let timeoutHandle;
    try {
      const timeoutPromise = new Promise(resolve => {
        timeoutHandle = setTimeout(() => resolve({ timeout: true }), timeoutMs);
      });
      const readPromise = reader.read();
      const result = await Promise.race([readPromise, timeoutPromise]);
      if (result?.timeout) return { timeout: true, value: '' };
      if (result?.done) return { done: true, value: '' };
      return { value: new TextDecoder().decode(result.value || new Uint8Array()) };
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  };

  const waitForAnyText = async (reader, expectedTexts, timeoutMs = 12000) => {
    const start = Date.now();
    let buffer = '';
    const needles = (Array.isArray(expectedTexts) ? expectedTexts : [expectedTexts]).filter(Boolean);

    while ((Date.now() - start) < timeoutMs) {
      const chunk = await readWithTimeout(reader, 300);
      if (chunk?.value) {
        buffer += chunk.value;
        if (needles.some((needle) => buffer.includes(needle))) {
          return { ok: true, buffer };
        }
      }
      if (chunk?.done) break;
    }

    return { ok: false, buffer };
  };

  const readDrain = async (reader, durationMs = 250) => {
    const start = Date.now();
    let buffer = '';
    while ((Date.now() - start) < durationMs) {
      const chunk = await readWithTimeout(reader, 80);
      if (chunk?.value) buffer += chunk.value;
      if (chunk?.done) break;
    }
    return buffer;
  };

  const writeBytes = async (writer, bytes) => {
    await writer.write(bytes);
  };

  const writeText = async (writer, text) => {
    const encoder = new TextEncoder();
    await writer.write(encoder.encode(text));
  };

  const flashViaNative = async (reason = '') => {
    setStatus(reason
      ? `Browser flash failed (${reason}). Trying native flash helper...`
      : 'Trying native flash helper...');

    const res = await fetch('/api/config/flash-native', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: filesToFlash,
        port: settings.nativePort?.trim() || undefined,
      }),
    });

    const data = await res.json();
    if (!res.ok || !data.ok) {
      const details = data.error || 'Native flashing failed.';
      const hint = data.hint ? ` ${data.hint}` : '';
      const install = data.installHint ? ` ${data.installHint}` : '';
      throw new Error(`${details}${hint}${install}`.trim());
    }

    setProgress(data.flashedFiles.map((name) => `✅ ${name}`));
    setStatus('✅ Native flash complete! Robot is rebooting.');
  };

  const enterRawRepl = async (reader, writer) => {
    if (typeof port?.setSignals === 'function') {
      try {
        await port.setSignals({ dataTerminalReady: false, requestToSend: false });
        await sleep(120);
        await port.setSignals({ dataTerminalReady: true, requestToSend: true });
        await sleep(220);
      } catch {
        // Some devices/browsers ignore signal control.
      }
    }

    const sequences = [
      {
        name: 'break+raw',
        run: async () => {
          await writeBytes(writer, new Uint8Array([0x03, 0x03])); // Ctrl-C Ctrl-C
          await sleep(180);
          await writeBytes(writer, new Uint8Array([0x01])); // Ctrl-A
        },
      },
      {
        name: 'normal->raw',
        run: async () => {
          await writeBytes(writer, new Uint8Array([0x02])); // Ctrl-B
          await sleep(120);
          await writeBytes(writer, new Uint8Array([0x03, 0x03])); // Ctrl-C Ctrl-C
          await sleep(180);
          await writeBytes(writer, new Uint8Array([0x01])); // Ctrl-A
        },
      },
      {
        name: 'soft-reboot->raw',
        run: async () => {
          await writeBytes(writer, new Uint8Array([0x03, 0x03])); // Ctrl-C Ctrl-C
          await sleep(120);
          await writeBytes(writer, new Uint8Array([0x04])); // Ctrl-D (soft reboot)
          await sleep(1200);
          await writeBytes(writer, new Uint8Array([0x03])); // Ctrl-C
          await sleep(120);
          await writeBytes(writer, new Uint8Array([0x01])); // Ctrl-A
        },
      },
    ];

    let combinedBuffer = '';
    for (let i = 0; i < sequences.length; i++) {
      await readDrain(reader, 220);
      await sequences[i].run();

      const result = await waitForAnyText(
        reader,
        ['raw REPL; CTRL-B to exit', 'raw REPL', 'raw REPL; CTRL-B to exit\r\n>', 'raw REPL; CTRL-B to exit\n>'],
        i === sequences.length - 1 ? 9000 : 5000,
      );

      combinedBuffer += result.buffer || '';
      if (result.ok) {
        return { ok: true, attempt: sequences[i].name, buffer: combinedBuffer };
      }
    }

    return { ok: false, buffer: combinedBuffer };
  };

  const flashFirmware = async () => {
    if (!port || !connected) {
      setStatus('❌ Connect USB first.');
      return;
    }
    if (!filesToFlash.length) {
      setStatus('❌ No firmware files loaded.');
      return;
    }

    setFlashing(true);
    setProgress([]);

    let reader;
    let writer;
    let webFlashError = null;

    try {
      reader = port.readable.getReader();
      writer = port.writable.getWriter();

      setStatus('Entering raw REPL...');
      const rawReplResult = await enterRawRepl(reader, writer);
      if (!rawReplResult.ok) {
        const tail = (rawReplResult.buffer || '').slice(-160).replace(/\s+/g, ' ').trim();
        const details = tail ? ` Last serial output: "${tail}".` : '';
        throw new Error(`Could not enter raw REPL after multiple attempts. On CyberPi, switch to MicroPython/upload mode, close mBlock/serial monitor apps, unplug/replug USB, then retry. If this browser method still fails, use mLink-based upload (official Makeblock workflow).${details}`);
      }

      for (let i = 0; i < filesToFlash.length; i++) {
        const file = filesToFlash[i];
        const marker = `WROTE:${file.name}`;
        const base64 = toBase64(file.content || '');
        const chunks = chunkString(base64, 220);
        const listLiteral = chunks.map(c => `'${c}'`).join(',\n    ');

        const script = [
          'try:',
          '    import ubinascii as b64',
          'except ImportError:',
          '    import binascii as b64',
          'chunks = [',
          `    ${listLiteral}`,
          ']',
          `f = open("${file.name}", "wb")`,
          'for c in chunks:',
          '    f.write(b64.a2b_base64(c))',
          'f.close()',
          `print("${marker}")`,
          '',
        ].join('\n');

        setStatus(`Writing ${file.name} (${i + 1}/${filesToFlash.length})...`);
        await writeText(writer, script);
        await writeBytes(writer, new Uint8Array([0x04]));

        const wrote = await waitForAnyText(reader, marker, 20000);
        if (!wrote.ok) {
          throw new Error(`Failed writing ${file.name}`);
        }

        setProgress(prev => [...prev, `✅ ${file.name}`]);
      }

      setStatus('Finishing flash and rebooting firmware...');
      await writeBytes(writer, new Uint8Array([0x02])); // Ctrl-B
      await sleep(100);
      await writeBytes(writer, new Uint8Array([0x04])); // Ctrl-D soft reboot

      setStatus('✅ Firmware flashed! The robot should reboot and reconnect over WiFi/MQTT.');
    } catch (error) {
      webFlashError = error;
    } finally {
      if (reader) {
        try { await reader.cancel(); } catch {}
        try { reader.releaseLock(); } catch {}
      }
      if (writer) {
        try { writer.releaseLock(); } catch {}
      }

      if (webFlashError) {
        try {
          await flashViaNative(webFlashError.message);
        } catch (nativeError) {
          setStatus(`❌ Flash failed: ${nativeError.message}`);
        }
      }

      setFlashing(false);
    }
  };

  return (
    <div className="firmware-flasher">
      <div className="firmware-flasher-header">
        <h3>🧰 Flash Required Firmware</h3>
        <span className="firmware-file-count">{loadingFiles ? 'Loading files...' : `${firmwareFiles.length} files ready`}</span>
      </div>

      <p className="section-desc">
        This writes the required mBot Studio firmware files to your robot over USB. Do this once, then use Program/Live over MQTT.
      </p>

      <div className="firmware-settings-grid">
        <label>
          WiFi SSID
          <input value={settings.wifiSsid} onChange={(e) => setSetting('wifiSsid', e.target.value)} placeholder="Your WiFi name" disabled={flashing} />
        </label>
        <label>
          WiFi Password
          <input type="password" value={settings.wifiPassword} onChange={(e) => setSetting('wifiPassword', e.target.value)} placeholder="Your WiFi password" disabled={flashing} />
        </label>
        <label>
          MQTT Broker IP/Host
          <input value={settings.mqttBroker} onChange={(e) => setSetting('mqttBroker', e.target.value)} placeholder="192.168.1.100" disabled={flashing} />
        </label>
        <label>
          MQTT Port
          <input type="number" value={settings.mqttPort} onChange={(e) => setSetting('mqttPort', e.target.value)} min="1" max="65535" disabled={flashing} />
        </label>
        <label>
          Topic Prefix
          <input value={settings.topicPrefix} onChange={(e) => setSetting('topicPrefix', e.target.value)} disabled={flashing} />
        </label>
        <label>
          Client ID
          <input value={settings.clientId} onChange={(e) => setSetting('clientId', e.target.value)} disabled={flashing} />
        </label>
        <label>
          Native Serial Port (optional)
          <select
            value={settings.nativePort}
            onChange={(e) => setSetting('nativePort', e.target.value)}
            disabled={flashing}
          >
            <option value="">Auto-detect</option>
            {nativePorts.map((port) => (
              <option key={port.port} value={port.port}>
                {port.port} {port.description ? `— ${port.description}` : ''}
              </option>
            ))}
          </select>
        </label>
      </div>

      {nativeSupport.checked && (
        <p className="section-desc" style={{ marginTop: 8 }}>
          {nativeSupport.ok
            ? '✅ Native flash helper ready (Python + mpremote detected).'
            : `⚠️ Native flash helper not ready. ${nativeSupport.error || ''} ${nativeSupport.installHint || ''}`}
        </p>
      )}

      <div className="firmware-actions">
        {!connected ? (
          <button className="btn-secondary" onClick={connectUsb} disabled={!supportsWebSerial || loadingFiles || flashing}>
            🔌 Connect USB
          </button>
        ) : (
          <button className="btn-secondary" onClick={disconnectUsb} disabled={flashing}>
            ❌ Disconnect USB
          </button>
        )}

        <button className="btn-primary" onClick={flashFirmware} disabled={!connected || loadingFiles || flashing || firmwareFiles.length === 0}>
          {flashing ? '⏳ Flashing...' : '⬆️ Flash Firmware Now'}
        </button>
        <button
          className="btn-secondary"
          onClick={() => {
            setFlashing(true);
            setProgress([]);
            flashViaNative()
              .catch((error) => setStatus(`❌ Native flash failed: ${error.message}`))
              .finally(() => setFlashing(false));
          }}
          disabled={loadingFiles || flashing || firmwareFiles.length === 0}
          title="Uses server-side Python mpremote; no Web Serial required"
        >
          🛠️ Native Flash
        </button>
      </div>

      {status && <p className="firmware-status">{status}</p>}

      {progress.length > 0 && (
        <div className="firmware-progress">
          {progress.map((line, idx) => <div key={`progress_${idx}`}>{line}</div>)}
        </div>
      )}
    </div>
  );
}
