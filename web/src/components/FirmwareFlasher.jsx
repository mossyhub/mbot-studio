import React, { useEffect, useMemo, useState } from 'react';
import './FirmwareFlasher.css';

const DEFAULT_SETTINGS = {
  wifiSsid: '',
  wifiPassword: '',
  mqttBroker: '',
  mqttPort: 1883,
  topicPrefix: 'mbot-studio',
  clientId: 'mbot2-rover',
  serialPort: '',
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
    fetch('/api/config/mlink/discover')
      .then(r => r.json())
      .then((data) => {
        if (!active) return;
        setMlinkSupport({
          checked: true,
          ok: !!data?.ok,
          version: data?.version || '',
          error: data?.ok ? '' : (data?.error || 'mLink not detected'),
        });
      })
      .catch((error) => {
        if (!active) return;
        setMlinkSupport({
          checked: true,
          ok: false,
          version: '',
          error: error?.message || 'Could not reach mLink bridge',
        });
      });

    fetch('/api/config/mlink/serialports')
      .then(r => r.json())
      .then((data) => {
        if (!active || !data?.ok) return;
        const ports = Array.isArray(data.ports) ? data.ports : [];
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
      if (file.name === 'config.py') {
        return { ...file, content: applySettingsToConfig(file.content, settings) };
      }
      return file;
    });
  }, [firmwareFiles, settings]);

  const setSetting = (key, value) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  const flashViaMlink = async () => {
    setStatus('Trying mLink bridge device upload...');
    const res = await fetch('/api/config/mlink/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: filesToFlash,
        serialPort: settings.serialPort?.trim() || undefined,
      }),
    });

    const data = await res.json();
    if (!res.ok || !data.ok) {
      const steps = Array.isArray(data.details?.diagnostics)
        ? data.details.diagnostics
        : [];

      const lastSteps = steps
        .slice(-6)
        .map((d) => {
          const label = d.system || d.step || d.method || 'step';
          const ok = d.ok === true ? 'ok' : d.ok === false ? 'fail' : 'n/a';
          return `${label}:${ok}`;
        })
        .join(', ');

      const detailText = lastSteps ? ` Diagnostics: ${lastSteps}` : '';
      throw new Error(`${data.error || 'mLink upload failed.'}${detailText}`.trim());
    }

    setProgress((data.uploaded || []).map((name) => `✅ ${name}`));
    setStatus('✅ mLink upload complete. Robot is rebooting.');
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
      </div>

      {mlinkSupport.checked && (
        <p className="section-desc" style={{ marginTop: 8 }}>
          {mlinkSupport.ok
            ? `✅ mLink detected${mlinkSupport.version ? ` (v${mlinkSupport.version})` : ''}.`
            : `⚠️ mLink not detected. Install and run mLink2, then refresh this page. ${mlinkSupport.error || ''}`}
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
