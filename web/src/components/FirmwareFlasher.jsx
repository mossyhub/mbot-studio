import React, { useEffect, useMemo, useState } from 'react';
import './FirmwareFlasher.css';

const DEFAULT_SETTINGS = {
  wifiSsid: '',
  wifiPassword: '',
  mqttBroker: '',
  mqttPort: 1883,
  topicPrefix: 'mbot-studio',
  clientId: 'mbot2-rover',
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

  const waitForText = async (reader, expectedText, timeoutMs = 12000) => {
    const start = Date.now();
    let buffer = '';

    while ((Date.now() - start) < timeoutMs) {
      const chunk = await readWithTimeout(reader, 300);
      if (chunk?.value) {
        buffer += chunk.value;
        if (buffer.includes(expectedText)) {
          return { ok: true, buffer };
        }
      }
      if (chunk?.done) break;
    }

    return { ok: false, buffer };
  };

  const writeBytes = async (writer, bytes) => {
    await writer.write(bytes);
  };

  const writeText = async (writer, text) => {
    const encoder = new TextEncoder();
    await writer.write(encoder.encode(text));
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

    try {
      reader = port.readable.getReader();
      writer = port.writable.getWriter();

      setStatus('Entering raw REPL...');
      await writeBytes(writer, new Uint8Array([0x03, 0x03]));
      await sleep(120);
      await writeBytes(writer, new Uint8Array([0x01]));

      const rawReplResult = await waitForText(reader, 'raw REPL', 7000);
      if (!rawReplResult.ok) {
        throw new Error('Could not enter raw REPL. Put CyberPi in MicroPython mode and retry.');
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

        const wrote = await waitForText(reader, marker, 20000);
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
      setStatus(`❌ Flash failed: ${error.message}`);
    } finally {
      if (reader) {
        try { await reader.cancel(); } catch {}
        try { reader.releaseLock(); } catch {}
      }
      if (writer) {
        try { writer.releaseLock(); } catch {}
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
      </div>

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
