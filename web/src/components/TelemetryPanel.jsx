import React, { useState, useEffect } from 'react';
import './TelemetryPanel.css';

/**
 * TelemetryPanel — Live robot feedback dashboard
 * Shows sensors, battery, orientation, actuators, alerts, and sparklines.
 * Receives telemetry via WebSocket (type: 'telemetry').
 */
export default function TelemetryPanel({ wsRef, wsConnected, robotConnected }) {
  const [telemetry, setTelemetry] = useState(null);
  const [expanded, setExpanded] = useState(true);

  // Listen for telemetry messages on the shared WebSocket
  useEffect(() => {
    const ws = wsRef?.current;
    if (!wsConnected || !ws) return;

    const handleMessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'telemetry') {
          setTelemetry(msg.data);
        }
      } catch { /* ignore */ }
    };

    ws.addEventListener('message', handleMessage);
    return () => ws.removeEventListener('message', handleMessage);
  }, [wsRef, wsConnected]);

  // Recover the cached snapshot on each connection (including one sent before
  // React attached the listener). This reads the server cache, not the robot.
  useEffect(() => {
    if (!wsConnected) return;
    const controller = new AbortController();
    fetch('/api/robot/telemetry', { signal: controller.signal })
      .then(r => r.json())
      .then(data => {
        if (!controller.signal.aborted && data.timestamp) {
          setTelemetry(current => !current?.timestamp || data.timestamp >= current.timestamp ? data : current);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [wsConnected]);

  // Snapshots are on demand: never schedule sensor scans during a program.
  const refreshSensors = () => {
    const ws = wsRef?.current;
    if (robotConnected && wsConnected && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'request_sensors' }));
    }
  };

  const s = telemetry?.sensors || {};
  const displayValue = value => typeof value === 'object' ? JSON.stringify(value) : String(value);
  const quadColors = {
    ...(s.color && typeof s.color === 'object' ? s.color : {}),
    ...Object.fromEntries(['L1', 'L2', 'R1', 'R2']
      .filter(port => s[`color_${port}`] != null)
      .map(port => [port, s[`color_${port}`]])),
  };
  const actuators = telemetry?.actuators || {};
  const alerts = telemetry?.alerts || [];
  const history = telemetry?.history || {};
  const stale = telemetry?.stale;

  // Battery color logic
  const batteryColor = (level) => {
    if (level == null || level < 0) return '#666';
    if (level <= 10) return '#ef4444';
    if (level <= 25) return '#f59e0b';
    if (level <= 50) return '#eab308';
    return '#22c55e';
  };

  const batteryIcon = (level) => {
    if (level == null || level < 0) return '🔋';
    if (level <= 10) return '🪫';
    if (level <= 25) return '🔋';
    return '🔋';
  };

  // Mini sparkline renderer (inline SVG)
  const Sparkline = ({ data, color = '#6366f1', height = 24, width = 80 }) => {
    if (!data || data.length < 2) return null;
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;
    const points = data.map((v, i) => {
      const x = (i / (data.length - 1)) * width;
      const y = height - ((v - min) / range) * (height - 4) - 2;
      return `${x},${y}`;
    }).join(' ');

    return (
      <svg width={width} height={height} className="sparkline">
        <polyline
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          points={points}
        />
      </svg>
    );
  };

  // Tilt indicator
  const TiltIndicator = () => {
    const tiltDir = s.tilt_left ? '⬅️' : s.tilt_right ? '➡️' : s.tilt_forward ? '⬆️' : s.tilt_backward ? '⬇️' : s.face_up ? '⬆️ flat' : '';
    return tiltDir ? <span className="tilt-dir">{tiltDir}</span> : null;
  };

  if (!expanded) {
    return (
      <div className="telemetry-panel telemetry-collapsed" onClick={() => setExpanded(true)}>
        <span className="telemetry-collapsed-label">
          📡 Telemetry
          {alerts.length > 0 && <span className="alert-badge-mini">{alerts.length}</span>}
          {s.battery != null && s.battery >= 0 && (
            <span className="battery-mini" style={{ color: batteryColor(s.battery) }}>{s.battery}%</span>
          )}
        </span>
      </div>
    );
  }

  return (
    <div className={`telemetry-panel ${stale ? 'telemetry-stale' : ''}`} style={{ flexShrink: 0 }}>
      {/* Header */}
      <div className="telemetry-header">
        <div className="telemetry-header-left">
          <span className="telemetry-title">📡 Robot Telemetry</span>
          {!robotConnected && <span className="telemetry-offline">Offline</span>}
          {stale && robotConnected && <span className="telemetry-stale-badge">Stale</span>}
          {telemetry?.timestamp && !stale && (
            <span className="telemetry-live">● Live</span>
          )}
        </div>
        <button onClick={refreshSensors} disabled={!robotConnected || !wsConnected}>Refresh sensors</button>
        <button className="telemetry-collapse-btn" onClick={() => setExpanded(false)} title="Collapse">▼</button>
      </div>

      {/* Alerts bar */}
      {alerts.length > 0 && (
        <div className="telemetry-alerts">
          {alerts.map((a, i) => (
            <div key={i} className={`telemetry-alert alert-${a.type}`}>
              <span>{a.icon}</span> {a.message}
            </div>
          ))}
        </div>
      )}

      {!telemetry?.timestamp && (
        <div className="telemetry-empty">
          <p>No telemetry data yet.</p>
          <p className="telemetry-hint">{robotConnected ? 'Click Refresh sensors to request a snapshot.' : 'Connect your robot to see live data.'}</p>
        </div>
      )}

      {telemetry?.timestamp && (
        <div className="telemetry-grid">
          {/* Battery */}
          {s.battery != null && s.battery >= 0 && (
            <div className="telem-card telem-battery">
              <div className="telem-icon">{batteryIcon(s.battery)}</div>
              <div className="telem-data">
                <div className="telem-value" style={{ color: batteryColor(s.battery) }}>{s.battery}%</div>
                <div className="telem-label">Battery</div>
                <div className="telem-bar-track">
                  <div className="telem-bar-fill" style={{ width: `${s.battery}%`, background: batteryColor(s.battery) }} />
                </div>
              </div>
              {history.battery?.length > 1 && (
                <Sparkline data={history.battery} color={batteryColor(s.battery)} />
              )}
            </div>
          )}

          {/* Distance / Ultrasonic */}
          {s.distance != null && (
            <div className={`telem-card telem-distance ${s.distance >= 0 && s.distance < 15 ? 'telem-warn' : ''}`}>
              <div className="telem-icon">📏</div>
              <div className="telem-data">
                <div className="telem-value">{s.distance >= 0 ? `${s.distance}cm` : '—'}</div>
                <div className="telem-label">Distance</div>
              </div>
              {history.distance?.length > 1 && (
                <Sparkline data={history.distance} color={s.distance < 15 ? '#ef4444' : '#6366f1'} />
              )}
            </div>
          )}

          {/* Line Followers */}
          {(s.line_left != null || s.line_right != null) && (
            <div className="telem-card telem-line">
              <div className="telem-icon">➖</div>
              <div className="telem-data">
                <div className="telem-value telem-value-pair">
                  <span className="telem-sub">L: {s.line_left ?? '—'}</span>
                  <span className="telem-sub">R: {s.line_right ?? '—'}</span>
                </div>
                <div className="telem-label">Line Sensors</div>
                <div className="telem-line-viz">
                  <div className="line-indicator" style={{ opacity: s.line_left != null ? (s.line_left < 50 ? 1 : 0.25) : 0.1 }}>L</div>
                  <div className="line-indicator" style={{ opacity: s.line_right != null ? (s.line_right < 50 ? 1 : 0.25) : 0.1 }}>R</div>
                </div>
              </div>
            </div>
          )}

          {/* Color Sensor */}
          {s.color != null && typeof s.color !== 'object' && (
            <div className="telem-card telem-color">
              <div className="telem-icon">🎨</div>
              <div className="telem-data">
                <div className="telem-value">{displayValue(s.color)}</div>
                <div className="telem-label">Color</div>
              </div>
              {typeof s.color === 'string' && <div className="color-swatch" style={{ background: s.color.toLowerCase() }} />}
            </div>
          )}

          {Object.keys(quadColors).length > 0 && (
            <div className="telem-card telem-color">
              <div className="telem-data">
                {Object.entries(quadColors).map(([port, value]) => (
                  <div key={port}>{port}: {displayValue(value)}</div>
                ))}
                <div className="telem-label">Quad colors</div>
              </div>
            </div>
          )}

          {s.line_status != null && (
            <div className="telem-card telem-line">
              <div className="telem-data">
                <div className="telem-value">{displayValue(s.line_status)}</div>
                <div className="telem-label">Line status (raw)</div>
              </div>
            </div>
          )}

          {['yaw', 'pitch', 'roll'].some(axis => s[axis] != null) && (
            <div className="telem-card telem-orientation">
              <div className="telem-data">
                {['yaw', 'pitch', 'roll'].filter(axis => s[axis] != null).map(axis => (
                  <div key={axis}>{axis[0].toUpperCase() + axis.slice(1)}: {displayValue(s[axis])}°</div>
                ))}
                <div className="telem-label">Orientation</div>
              </div>
            </div>
          )}

          {s.errors && Object.keys(s.errors).length > 0 && (
            <div className="telem-card telem-warn">
              <div className="telem-data">
                <div className="telem-label">Sensor errors (raw)</div>
                <div>{displayValue(s.errors)}</div>
              </div>
            </div>
          )}

          {/* Gyroscope / Orientation */}
          {s.gyro_z != null && (
            <div className="telem-card telem-gyro">
              <div className="telem-icon">🧭</div>
              <div className="telem-data">
                <div className="telem-value telem-value-compact">
                  X:{s.gyro_x == null ? '—' : `${s.gyro_x}°`} Y:{s.gyro_y == null ? '—' : `${s.gyro_y}°`} Z:{s.gyro_z}°
                </div>
                <div className="telem-label">Gyroscope <TiltIndicator /></div>
              </div>
              <div className="compass-ring">
                <div className="compass-needle" style={{ transform: `rotate(${s.gyro_z || 0}deg)` }} />
              </div>
            </div>
          )}

          {/* Loudness */}
          {s.loudness != null && (
            <div className="telem-card telem-loudness">
              <div className="telem-icon">{s.loudness > 60 ? '🔊' : s.loudness > 30 ? '🔉' : '🔈'}</div>
              <div className="telem-data">
                <div className="telem-value">{s.loudness}</div>
                <div className="telem-label">Loudness</div>
                <div className="telem-bar-track">
                  <div className="telem-bar-fill telem-bar-loudness" style={{ width: `${Math.min(s.loudness, 100)}%` }} />
                </div>
              </div>
            </div>
          )}

          {/* Brightness */}
          {s.brightness != null && (
            <div className="telem-card telem-brightness">
              <div className="telem-icon">{s.brightness > 60 ? '☀️' : s.brightness > 30 ? '🌤️' : '🌙'}</div>
              <div className="telem-data">
                <div className="telem-value">{s.brightness}</div>
                <div className="telem-label">Brightness</div>
                <div className="telem-bar-track">
                  <div className="telem-bar-fill telem-bar-brightness" style={{ width: `${Math.min(s.brightness, 100)}%` }} />
                </div>
              </div>
            </div>
          )}

          {/* Shake / Motion */}
          {(s.is_shaking || s.shake_strength > 0) && (
            <div className={`telem-card telem-shake ${s.is_shaking ? 'telem-shaking' : ''}`}>
              <div className="telem-icon">📳</div>
              <div className="telem-data">
                <div className="telem-value">{s.is_shaking ? 'Shaking!' : 'Still'}</div>
                <div className="telem-label">Motion — str: {s.shake_strength}</div>
              </div>
            </div>
          )}

          {/* Buttons */}
          {(s.button_a !== undefined || s.button_b !== undefined) && (s.button_a || s.button_b) && (
            <div className="telem-card telem-buttons">
              <div className="telem-icon">🔘</div>
              <div className="telem-data">
                <div className="telem-value telem-value-pair">
                  <span className={`btn-indicator ${s.button_a ? 'btn-pressed' : ''}`}>A</span>
                  <span className={`btn-indicator ${s.button_b ? 'btn-pressed' : ''}`}>B</span>
                </div>
                <div className="telem-label">Buttons</div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Actuators section */}
      {(Object.keys(actuators.servos || {}).length > 0 || Object.keys(actuators.motors || {}).length > 0) && (
        <div className="telemetry-actuators">
          <div className="actuator-heading">⚡ Actuators</div>
          <div className="actuator-grid">
            {Object.entries(actuators.servos || {}).map(([port, angle]) => (
              <div key={port} className="actuator-chip actuator-servo">
                <span className="actuator-port">🦾 {port}</span>
                <span className="actuator-val">{angle}°</span>
                <div className="servo-arc">
                  <div className="servo-needle" style={{ transform: `rotate(${angle - 90}deg)` }} />
                </div>
              </div>
            ))}
            {Object.entries(actuators.motors || {}).map(([port, speed]) => (
              <div key={port} className={`actuator-chip actuator-motor ${speed !== 0 ? 'motor-active' : ''}`}>
                <span className="actuator-port">⚡ {port}</span>
                <span className="actuator-val">{speed > 0 ? `▶ ${speed}` : speed < 0 ? `◀ ${Math.abs(speed)}` : 'Stop'}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
