import React, { useEffect, useMemo, useState } from 'react';
import './FirmwareFlasher.css';
import { discoverMlink, listSerialPorts, uploadViaMlink } from '../services/mlink-client.js';

const DEFAULT_SETTINGS = {
  wifiSsid: '',
  wifiPassword: '',
  mqttBroker: '',
  mqttPort: 1883,
  topicPrefix: 'mbot-studio',
  clientId: 'mbot2-rover',
  serialPort: '',
  programSlot: 1,
};

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
  const [flashing, setFlashing] = useState(false);
  const [status, setStatus] = useState('');
  const [progress, setProgress] = useState([]);
  const [mlinkSupport, setMlinkSupport] = useState({ checked: false, ok: false, version: '', error: '' });
  const [serialPorts, setSerialPorts] = useState([]);

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

    // Discover mLink directly from the browser (localhost WebSocket)
    discoverMlink()
      .then((data) => {
        if (!active) return;
        setMlinkSupport({
          checked: true,
          ok: true,
          version: data?.version || '',
          error: '',
        });
      })
      .catch((error) => {
        if (!active) return;
        setMlinkSupport({
          checked: true,
          ok: false,
          version: '',
          error: error?.message || 'mLink not detected',
        });
      });

    // List serial ports directly from the browser
    listSerialPorts()
      .then((data) => {
        if (!active || !data?.ok) return;
        const ports = data.ports || [];
        setSerialPorts(ports);
        setSettings((prev) => {
          if (prev.serialPort || ports.length === 0) return prev;
          const first = ports[0];
          const preferred = first?.info?.comName || first?.info?.path || '';
          return { ...prev, serialPort: preferred };
        });
      })
      .catch(() => {
        if (!active) return;
        setSerialPorts([]);
      });

    return () => {
      active = false;
    };
  }, []);

  const filesToFlash = useMemo(() => {
    return firmwareFiles.map((file) => {
      const fileName = String(file.name || '');
      if (fileName === 'mbot_config.py' || fileName.endsWith('/mbot_config.py')) {
        return { ...file, content: applySettingsToConfig(file.content, settings) };
      }
      return file;
    });
  }, [firmwareFiles, settings]);

  const setSetting = (key, value) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  const flashViaMlink = async () => {
    setStatus('Connecting to mLink (browser → localhost)...');

    const result = await uploadViaMlink({
      files: filesToFlash,
      serialPort: settings.serialPort?.trim() || null,
      slot: settings.programSlot || 1,
      onProgress: (msg) => setProgress((prev) => [...prev, msg]),
    });

    if (!result.ok) {
      throw new Error('Upload failed — check diagnostics above');
    }

    setStatus('✅ Upload complete — program is now running on the CyberPi.');
  };

  const flashFirmware = async () => {
    if (!filesToFlash.length) {
      setStatus('❌ No firmware files loaded.');
      return;
    }

    setFlashing(true);
    setProgress([]);

    try {
      await flashViaMlink();
    } catch (error) {
      setStatus(`❌ Upload failed: ${error.message}`);
    } finally {
      setFlashing(false);
    }
  };

  const flashTestFirmware = async () => {
    setFlashing(true);
    setProgress([]);
    setStatus('Uploading minimal motor test firmware...');

    try {
      // Fetch test firmware from server
      const res = await fetch('/api/config/firmware/test');
      const data = await res.json();
      if (!data.files || data.files.length === 0) {
        throw new Error('No test firmware files from server');
      }

      // Apply WiFi/MQTT settings to config file
      const testFiles = data.files.map((file) => {
        const fileName = String(file.name || '');
        if (fileName === 'mbot_config.py' || fileName.endsWith('/mbot_config.py')) {
          return { ...file, content: applySettingsToConfig(file.content, settings) };
        }
        return file;
      });

      const result = await uploadViaMlink({
        files: testFiles,
        serialPort: settings.serialPort?.trim() || null,
        slot: settings.programSlot || 1,
        onProgress: (msg) => setProgress((prev) => [...prev, msg]),
      });

      if (!result.ok) {
        throw new Error('Test upload failed');
      }

      setStatus('✅ Motor test firmware uploaded! Press Button A on CyberPi = forward, Button B = backward.');
    } catch (error) {
      setStatus(`❌ Test upload failed: ${error.message}`);
    } finally {
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
        This uploads the required mBot Studio firmware files to your robot using the local mLink bridge. Do this once, then use Program/Live over MQTT.
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
          Device Serial Port (optional)
          <select
            value={settings.serialPort}
            onChange={(e) => setSetting('serialPort', e.target.value)}
            disabled={flashing}
          >
            <option value="">Auto-detect</option>
            {serialPorts.map((port) => {
              const key = String(port?.info?.comName || port?.info?.path || port?.id);
              const value = String(port?.info?.comName || port?.info?.path || '');
              const label = port?.info?.comName || port?.info?.path || `port-${port?.id}`;
              const hint = port?.info?.manufacturer || port?.info?.friendlyName || '';
              return (
                <option key={key} value={value}>
                  {label}{hint ? ` — ${hint}` : ''}
                </option>
              );
            })}
          </select>
        </label>
        <label>
          Program Slot (1-8)
          <select
            value={settings.programSlot}
            onChange={(e) => setSetting('programSlot', Number(e.target.value))}
            disabled={flashing}
          >
            {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
              <option key={n} value={n}>Slot {n}</option>
            ))}
          </select>
        </label>
      </div>

      {mlinkSupport.checked && (
        <p className="section-desc" style={{ marginTop: 8 }}>
          {mlinkSupport.ok
            ? `✅ mLink detected${mlinkSupport.version ? ` (v${mlinkSupport.version})` : ''} — connecting directly from your browser.`
            : `⚠️ mLink not detected on this computer. Install and run mLink2, then refresh. ${mlinkSupport.error || ''}`}
        </p>
      )}

      {!settings.wifiSsid && (
        <p className="section-desc" style={{ marginTop: 8, color: '#e57373' }}>
          ⚠️ WiFi SSID is empty — the firmware will use placeholder values and won't connect.
        </p>
      )}

      <div className="firmware-actions">
        <button
          className="btn-primary"
          onClick={flashFirmware}
          disabled={loadingFiles || flashing || firmwareFiles.length === 0}
          title="Uploads firmware via the local mLink bridge"
        >
          {flashing ? '⏳ Uploading...' : '⬆️ Upload Firmware via mLink'}
        </button>
        <button
          className="btn-secondary"
          onClick={flashTestFirmware}
          disabled={flashing}
          title="Upload minimal motor test firmware — Button A=forward, B=backward"
          style={{ marginLeft: 8 }}
        >
          🧪 Test Motors Only
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
