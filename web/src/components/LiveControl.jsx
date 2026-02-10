import React, { useState, useEffect, useRef, useCallback } from 'react';
import TelemetryPanel from './TelemetryPanel';
import VoiceControl from './VoiceControl';
import './LiveControl.css';

export default function LiveControl({ robotConfig, robotConnected, onStop, onAchievement }) {
  const [liveInput, setLiveInput] = useState('');
  const [sending, setSending] = useState(false);
  const [log, setLog] = useState([]);
  const [sensorData, setSensorData] = useState(null);
  const [wsConnected, setWsConnected] = useState(false);
  const wsRef = useRef(null);
  const logEndRef = useRef(null);
  const reconnectTimer = useRef(null);
  const reconnectAttempts = useRef(0);

  // WebSocket connection with auto-reconnect
  useEffect(() => {
    function connect() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws`;

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setWsConnected(true);
        reconnectAttempts.current = 0;
        addLog('system', '🔌 Connected to server');
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'mqtt' && msg.topic === 'robot/sensors') {
            setSensorData(msg.data);
          } else if (msg.type === 'mqtt' && msg.topic === 'robot/status') {
            addLog('robot', `Robot: ${JSON.stringify(msg.data)}`);
          } else if (msg.type === 'mqtt' && msg.topic === 'robot/log') {
            addLog('robot', `🤖 ${typeof msg.data === 'string' ? msg.data : JSON.stringify(msg.data)}`);
          } else if (msg.type === 'ack') {
            addLog('system', `✅ Command sent: ${msg.command}`);
          } else if (msg.type === 'error') {
            addLog('error', `❌ ${msg.message}`);
          }
        } catch (e) {
          console.error('WS message error:', e);
        }
      };

      ws.onclose = () => {
        setWsConnected(false);
        wsRef.current = null;
        addLog('system', '🔌 Disconnected from server');

        // Auto-reconnect with exponential backoff (max 10s)
        const delay = Math.min(1000 * Math.pow(1.5, reconnectAttempts.current), 10000);
        reconnectAttempts.current++;
        addLog('system', `🔄 Reconnecting in ${Math.round(delay / 1000)}s...`);
        reconnectTimer.current = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        // onclose will fire after this
      };
    }

    connect();

    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  // Auto-scroll log
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [log]);

  const addLog = useCallback((type, message) => {
    const time = new Date().toLocaleTimeString();
    setLog(prev => [...prev.slice(-100), { type, message, time }]);
  }, []);

  const sendLiveCommand = async (voiceText) => {
    const text = voiceText || liveInput.trim();
    if (!text || sending) return;

    setSending(true);
    setLiveInput('');
    addLog('user', `💬 ${text}`);

    // First live control achievement
    if (onAchievement) onAchievement('first_live');

    try {
      // Use AI to interpret the command and generate immediate actions
      const res = await fetch('/api/ai/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });
      const data = await res.json();

      if (data.program) {
        addLog('ai', `🧠 Generated ${data.program.length} commands`);
        if (data.explanation) {
          addLog('ai', `💡 ${data.explanation}`);
        }

        // Send the program to robot via the API
        const robotRes = await fetch('/api/robot/program', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ program: data.program }),
        });
        const robotData = await robotRes.json();

        if (robotData.error) {
          addLog('error', `❌ ${robotData.error}`);
        } else {
          addLog('system', `📡 Program sent to robot!`);
        }
      } else if (data.chat) {
        addLog('ai', `🤖 ${data.chat}`);
      }
    } catch (err) {
      addLog('error', `❌ Error: ${err.message}`);
    } finally {
      setSending(false);
    }
  };

  const sendDirectCommand = (command) => {
    if (!robotConnected) {
      addLog('error', '❌ Robot not connected');
      return;
    }

    addLog('user', `🎮 ${command.type} ${JSON.stringify(command)}`);

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'command', command }));
    }
  };

  const handleStop = () => {
    onStop();
    addLog('system', '🛑 EMERGENCY STOP!');

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'emergency_stop' }));
    }
  };

  return (
    <div className="live-control">
      {/* Left: Controls */}
      <div className="live-controls-panel panel">
        <div className="panel-header">
          <h2>🎮 Live Control</h2>
          <button className="btn-danger" onClick={handleStop}>
            🛑 STOP
          </button>
        </div>

        {/* Voice/Text Command */}
        <div className="live-command-area">
          <h3>Tell your robot what to do right now:</h3>
          <VoiceControl
            onVoiceCommand={(text) => {
              setLiveInput(text);
              sendLiveCommand(text);
              if (onAchievement) onAchievement('first_voice');
            }}
            disabled={sending}
          />
          <div className="live-input-row">
            <input
              type="text"
              value={liveInput}
              onChange={(e) => setLiveInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && sendLiveCommand()}
              placeholder='e.g., "Go forward slowly" or "Open the claw"'
              disabled={sending}
            />
            <button
              className="btn-primary"
              onClick={sendLiveCommand}
              disabled={!liveInput.trim() || sending}
            >
              {sending ? '⏳' : '▶️ Go!'}
            </button>
          </div>
        </div>

        {/* Direction Pad */}
        <div className="direction-pad">
          <h3>Quick Controls</h3>
          <div className="dpad">
            <div className="dpad-row">
              <div className="dpad-spacer" />
              <button
                className="dpad-btn dpad-up"
                onMouseDown={() => sendDirectCommand({ type: 'move_forward', speed: 50, duration: 0.5 })}
              >
                ⬆️
              </button>
              <div className="dpad-spacer" />
            </div>
            <div className="dpad-row">
              <button
                className="dpad-btn dpad-left"
                onMouseDown={() => sendDirectCommand({ type: 'turn_left', speed: 40, angle: 45 })}
              >
                ⬅️
              </button>
              <button
                className="dpad-btn dpad-stop"
                onClick={handleStop}
              >
                🛑
              </button>
              <button
                className="dpad-btn dpad-right"
                onMouseDown={() => sendDirectCommand({ type: 'turn_right', speed: 40, angle: 45 })}
              >
                ➡️
              </button>
            </div>
            <div className="dpad-row">
              <div className="dpad-spacer" />
              <button
                className="dpad-btn dpad-down"
                onMouseDown={() => sendDirectCommand({ type: 'move_backward', speed: 50, duration: 0.5 })}
              >
                ⬇️
              </button>
              <div className="dpad-spacer" />
            </div>
          </div>
        </div>

        {/* Custom Hardware Quick Controls */}
        {robotConfig?.additions?.length > 0 && (
          <div className="custom-controls">
            <h3>Custom Hardware</h3>
            <div className="custom-buttons">
              {robotConfig.additions.map((hw, i) => {
                if (hw.type === 'dc_motor') {
                  return (
                    <div key={i} className="custom-control-group">
                      <span className="custom-label">⚡ {hw.label || `Motor ${hw.port}`}</span>
                      <button
                        className="btn-small btn-success"
                        onClick={() => sendDirectCommand({ type: 'dc_motor', port: hw.port, speed: 70, duration: 1 })}
                      >
                        ▶️ On
                      </button>
                      <button
                        className="btn-small btn-secondary"
                        onClick={() => sendDirectCommand({ type: 'dc_motor', port: hw.port, speed: -70, duration: 1 })}
                      >
                        ◀️ Reverse
                      </button>
                      <button
                        className="btn-small btn-danger"
                        onClick={() => sendDirectCommand({ type: 'dc_motor', port: hw.port, speed: 0, duration: 0 })}
                      >
                        ⏹️ Off
                      </button>
                    </div>
                  );
                }
                if (hw.type === 'servo') {
                  return (
                    <div key={i} className="custom-control-group">
                      <span className="custom-label">🦾 {hw.label || `Servo ${hw.port}`}</span>
                      <button
                        className="btn-small btn-secondary"
                        onClick={() => sendDirectCommand({ type: 'servo', port: hw.port, angle: 0 })}
                      >
                        0°
                      </button>
                      <button
                        className="btn-small btn-secondary"
                        onClick={() => sendDirectCommand({ type: 'servo', port: hw.port, angle: 45 })}
                      >
                        45°
                      </button>
                      <button
                        className="btn-small btn-primary"
                        onClick={() => sendDirectCommand({ type: 'servo', port: hw.port, angle: 90 })}
                      >
                        90°
                      </button>
                      <button
                        className="btn-small btn-secondary"
                        onClick={() => sendDirectCommand({ type: 'servo', port: hw.port, angle: 135 })}
                      >
                        135°
                      </button>
                      <button
                        className="btn-small btn-secondary"
                        onClick={() => sendDirectCommand({ type: 'servo', port: hw.port, angle: 180 })}
                      >
                        180°
                      </button>
                    </div>
                  );
                }
                return null;
              })}
            </div>
          </div>
        )}

        {/* Live Telemetry Dashboard */}
        <TelemetryPanel wsRef={wsRef} robotConnected={robotConnected} />
      </div>

      {/* Right: Activity Log */}
      <div className="live-log-panel panel">
        <div className="panel-header">
          <h2>📋 Activity Log</h2>
          <button className="btn-small btn-secondary" onClick={() => setLog([])}>
            Clear
          </button>
        </div>
        <div className="live-log">
          {log.length === 0 && (
            <div className="log-empty">
              <p>Activity will appear here when you control your robot.</p>
            </div>
          )}
          {log.map((entry, i) => (
            <div key={i} className={`log-entry log-${entry.type}`}>
              <span className="log-time">{entry.time}</span>
              <span className="log-message">{entry.message}</span>
            </div>
          ))}
          <div ref={logEndRef} />
        </div>
      </div>
    </div>
  );
}
