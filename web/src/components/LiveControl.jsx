import React, { useState, useEffect, useRef, useCallback } from 'react';
import TelemetryPanel from './TelemetryPanel';
import './LiveControl.css';

const MAX_MISSION_EVENTS = 500;

function getMissionStorageKey(profileId) {
  return `mbot-studio-missions:${profileId || 'default'}`;
}

function loadMissionSessions(profileId) {
  try {
    return JSON.parse(localStorage.getItem(getMissionStorageKey(profileId)) || '[]');
  } catch {
    return [];
  }
}

function saveMissionSessions(profileId, sessions) {
  localStorage.setItem(getMissionStorageKey(profileId), JSON.stringify(sessions));
}

export default function LiveControl({ robotConfig, robotConnected, currentProfileId, onStop, onAchievement }) {
  const [liveInput, setLiveInput] = useState('');
  const [sending, setSending] = useState(false);
  const [log, setLog] = useState([]);
  const [sensorData, setSensorData] = useState(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [missionEvents, setMissionEvents] = useState([]);
  const [missionCursor, setMissionCursor] = useState(0);
  const [missionPlaying, setMissionPlaying] = useState(false);
  const [missionName, setMissionName] = useState('');
  const [missionSessions, setMissionSessions] = useState([]);
  const wsRef = useRef(null);
  const logEndRef = useRef(null);
  const reconnectTimer = useRef(null);
  const reconnectAttempts = useRef(0);
  const missionPlayTimer = useRef(null);
  const aiRequestController = useRef(null);
  const directQueueRef = useRef([]);
  const directQueueRunningRef = useRef(false);

  const recordMissionEvent = useCallback((type, payload) => {
    const event = {
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      type,
      payload,
    };
    setMissionEvents(prev => [...prev, event].slice(-MAX_MISSION_EVENTS));
  }, []);

  useEffect(() => {
    const sessions = loadMissionSessions(currentProfileId);
    setMissionSessions(sessions);
    setMissionEvents([]);
    setMissionCursor(0);
    setMissionPlaying(false);
  }, [currentProfileId]);

  useEffect(() => {
    if (missionEvents.length === 0) {
      setMissionCursor(0);
      return;
    }
    if (missionCursor > missionEvents.length - 1) {
      setMissionCursor(missionEvents.length - 1);
    }
  }, [missionEvents, missionCursor]);

  useEffect(() => {
    if (!missionPlaying || missionEvents.length === 0) return;

    missionPlayTimer.current = setInterval(() => {
      setMissionCursor(prev => {
        if (prev >= missionEvents.length - 1) {
          setMissionPlaying(false);
          return prev;
        }
        return prev + 1;
      });
    }, 700);

    return () => {
      if (missionPlayTimer.current) clearInterval(missionPlayTimer.current);
      missionPlayTimer.current = null;
    };
  }, [missionPlaying, missionEvents.length]);

  const addLog = useCallback((type, message) => {
    const time = new Date().toLocaleTimeString();
    setLog(prev => [...prev.slice(-100), { type, message, time }]);
  }, []);

  // Auto-scroll log
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [log]);

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
        recordMissionEvent('ws_open', { connected: true });
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'mqtt' && msg.topic === 'robot/sensors') {
            setSensorData(msg.data);
            recordMissionEvent('telemetry', msg.data);
          } else if (msg.type === 'mqtt' && msg.topic === 'robot/status') {
            addLog('robot', `Robot: ${JSON.stringify(msg.data)}`);
            recordMissionEvent('robot_status', msg.data);
          } else if (msg.type === 'mqtt' && msg.topic === 'robot/log') {
            addLog('robot', `🤖 ${typeof msg.data === 'string' ? msg.data : JSON.stringify(msg.data)}`);
            recordMissionEvent('robot_log', msg.data);
          } else if (msg.type === 'ack') {
            addLog('system', `✅ Command sent: ${msg.command}`);
            recordMissionEvent('ack', { command: msg.command });
          } else if (msg.type === 'error') {
            addLog('error', `❌ ${msg.message}`);
            recordMissionEvent('ws_error', { message: msg.message });
          }
        } catch (e) {
          console.error('WS message error:', e);
        }
      };

      ws.onclose = () => {
        setWsConnected(false);
        wsRef.current = null;
        addLog('system', '🔌 Disconnected from server');
        recordMissionEvent('ws_close', { connected: false });

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
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
      if (missionPlayTimer.current) clearInterval(missionPlayTimer.current);
    };
  }, [addLog, recordMissionEvent]);

  const sendLiveCommand = async (voiceText) => {
    const text = voiceText || liveInput.trim();
    if (!text || sending) return;

    setSending(true);
    setLiveInput('');
    addLog('user', `💬 ${text}`);
    recordMissionEvent('live_prompt', { text });
    aiRequestController.current = new AbortController();

    // First live control achievement
    if (onAchievement) onAchievement('first_live');

    try {
      // Use AI to interpret the command and generate immediate actions
      const res = await fetch('/api/ai/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: aiRequestController.current.signal,
        body: JSON.stringify({ message: text }),
      });
      const data = await res.json();

      if (data.program) {
        addLog('ai', `🧠 Generated ${data.program.length} commands`);
        recordMissionEvent('ai_program', { blockCount: data.program.length, explanation: data.explanation || '' });
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
          recordMissionEvent('program_send_error', { error: robotData.error });
        } else {
          addLog('system', `📡 Program sent to robot!`);
          recordMissionEvent('program_sent', { blockCount: data.program.length });
        }
      } else if (data.chat) {
        addLog('ai', `🤖 ${data.chat}`);
        recordMissionEvent('ai_chat', { message: data.chat });
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        addLog('system', '🛑 AI command canceled');
        recordMissionEvent('ai_canceled', { text });
        return;
      }
      addLog('error', `❌ Error: ${err.message}`);
      recordMissionEvent('client_error', { message: err.message });
    } finally {
      aiRequestController.current = null;
      setSending(false);
    }
  };

  const processDirectQueue = useCallback(() => {
    if (directQueueRunningRef.current) return;
    if (directQueueRef.current.length === 0) return;
    directQueueRunningRef.current = true;

    const runNext = () => {
      const nextCommand = directQueueRef.current.shift();
      if (!nextCommand) {
        directQueueRunningRef.current = false;
        return;
      }

      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'command', command: nextCommand }));
      }

      setTimeout(runNext, 120);
    };

    runNext();
  }, []);

  const enqueueDirectCommand = useCallback((command) => {
    if (!robotConnected) {
      addLog('error', '❌ Robot not connected');
      recordMissionEvent('direct_command_blocked', { command, reason: 'robot_not_connected' });
      return;
    }

    addLog('user', `🎮 ${command.type} ${JSON.stringify(command)}`);
    recordMissionEvent('direct_command', command);

    directQueueRef.current.push(command);
    if (directQueueRef.current.length > 40) {
      directQueueRef.current = directQueueRef.current.slice(-40);
    }
    processDirectQueue();
  }, [robotConnected, addLog, recordMissionEvent, processDirectQueue]);

  const cancelAiCommand = useCallback(() => {
    if (aiRequestController.current) {
      aiRequestController.current.abort();
    }
  }, []);

  const handleStop = () => {
    onStop();
    addLog('system', '🛑 EMERGENCY STOP!');
    recordMissionEvent('emergency_stop', { source: 'ui' });
    directQueueRef.current = [];
    directQueueRunningRef.current = false;
    if (aiRequestController.current) {
      aiRequestController.current.abort();
    }

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'emergency_stop' }));
    }
  };

  const handleSaveMission = () => {
    if (missionEvents.length === 0) return;
    const session = {
      id: `mission_${Date.now()}`,
      name: missionName.trim() || new Date().toLocaleString(),
      createdAt: Date.now(),
      events: missionEvents,
    };
    const next = [session, ...missionSessions].slice(0, 20);
    setMissionSessions(next);
    saveMissionSessions(currentProfileId, next);
    setMissionName('');
  };

  const handleLoadMission = (sessionId) => {
    const session = missionSessions.find(s => s.id === sessionId);
    if (!session) return;
    setMissionPlaying(false);
    setMissionEvents(session.events || []);
    setMissionCursor(0);
  };

  const handleClearTimeline = () => {
    setMissionPlaying(false);
    setMissionEvents([]);
    setMissionCursor(0);
  };

  const replayEvent = missionEvents[missionCursor] || null;

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

        {/* Text Command */}
        <div className="live-command-area">
          <h3>Tell your robot what to do right now:</h3>
          <p className="live-subtext">Type a command below — spelling it out works best! Or use the buttons to drive in real time.</p>
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
            <button
              className="btn-secondary"
              onClick={cancelAiCommand}
              disabled={!sending}
              title="Cancel current AI command"
            >
              ✋ Cancel
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
                onMouseDown={() => enqueueDirectCommand({ type: 'move_forward', speed: 50, duration: 0.5 })}
              >
                ⬆️
              </button>
              <div className="dpad-spacer" />
            </div>
            <div className="dpad-row">
              <button
                className="dpad-btn dpad-left"
                onMouseDown={() => enqueueDirectCommand({ type: 'turn_left', speed: 40, angle: 90 })}
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
                onMouseDown={() => enqueueDirectCommand({ type: 'turn_right', speed: 40, angle: 90 })}
              >
                ➡️
              </button>
            </div>
            <div className="dpad-row">
              <div className="dpad-spacer" />
              <button
                className="dpad-btn dpad-down"
                onMouseDown={() => enqueueDirectCommand({ type: 'move_backward', speed: 50, duration: 0.5 })}
              >
                ⬇️
              </button>
              <div className="dpad-spacer" />
            </div>
          </div>
        </div>

        {/* Live Telemetry Dashboard */}
        <TelemetryPanel wsRef={wsRef} robotConnected={robotConnected} />
      </div>

      {/* Middle: Hardware Ports */}
      <div className="live-hw-panel panel">
        <div className="panel-header">
          <h2>Servo Ports</h2>
        </div>
        <div className="hw-port-list">
          {['S1', 'S2', 'S3', 'S4'].map((port) => (
            <div key={port} className="hw-port-row">
              <span className="hw-port-label">{port}</span>
              {[0, 45, 90, 135, 180].map((angle) => (
                <button
                  key={`${port}_${angle}`}
                  className="btn-small btn-secondary"
                  onClick={() => enqueueDirectCommand({ type: 'servo', port, angle })}
                  disabled={!robotConnected}
                >
                  {angle}°
                </button>
              ))}
            </div>
          ))}
        </div>
        <div className="panel-header" style={{ marginTop: 8 }}>
          <h2>Motor Ports</h2>
        </div>
        <div className="hw-port-list">
          {['M1', 'M2', 'M3', 'M4'].map((port) => (
            <div key={port} className="hw-port-row">
              <span className="hw-port-label">{port}</span>
              <button className="btn-small btn-success" onClick={() => enqueueDirectCommand({ type: 'dc_motor', port, speed: 50, duration: 1 })} disabled={!robotConnected}>FWD</button>
              <button className="btn-small btn-secondary" onClick={() => enqueueDirectCommand({ type: 'dc_motor', port, speed: -50, duration: 1 })} disabled={!robotConnected}>REV</button>
              <button className="btn-small btn-danger" onClick={() => enqueueDirectCommand({ type: 'dc_motor', port, speed: 0, duration: 0 })} disabled={!robotConnected}>OFF</button>
            </div>
          ))}
        </div>
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

        <div className="mission-replay">
          <div className="mission-replay-header">
            <h3>🎬 Mission Replay</h3>
            <span className="mission-count">{missionEvents.length} events</span>
          </div>

          <div className="mission-controls-row">
            <input
              className="mission-name-input"
              value={missionName}
              onChange={(e) => setMissionName(e.target.value)}
              placeholder="Session name"
              maxLength={30}
            />
            <button className="btn-small btn-secondary" onClick={handleSaveMission} disabled={missionEvents.length === 0}>Save</button>
            <button className="btn-small btn-secondary" onClick={handleClearTimeline} disabled={missionEvents.length === 0}>Clear</button>
          </div>

          {missionSessions.length > 0 && (
            <div className="mission-controls-row">
              <select className="mission-select" onChange={(e) => handleLoadMission(e.target.value)} defaultValue="">
                <option value="" disabled>Load saved session...</option>
                {missionSessions.map((session) => (
                  <option key={session.id} value={session.id}>{session.name} ({session.events?.length || 0})</option>
                ))}
              </select>
            </div>
          )}

          <div className="mission-controls-row">
            <button
              className="btn-small btn-primary"
              onClick={() => setMissionPlaying(!missionPlaying)}
              disabled={missionEvents.length < 2}
            >
              {missionPlaying ? '⏸ Pause' : '▶ Replay'}
            </button>
            <span className="mission-position">
              {missionEvents.length > 0 ? `${missionCursor + 1}/${missionEvents.length}` : '0/0'}
            </span>
          </div>

          <input
            type="range"
            className="mission-slider"
            min={0}
            max={Math.max(missionEvents.length - 1, 0)}
            value={Math.min(missionCursor, Math.max(missionEvents.length - 1, 0))}
            onChange={(e) => {
              setMissionPlaying(false);
              setMissionCursor(Number(e.target.value));
            }}
            disabled={missionEvents.length === 0}
          />

          <div className="mission-event-preview">
            {replayEvent ? (
              <>
                <div className="mission-event-meta">
                  <span className="mission-event-type">{replayEvent.type}</span>
                  <span className="mission-event-time">{new Date(replayEvent.timestamp).toLocaleTimeString()}</span>
                </div>
                <pre>{JSON.stringify(replayEvent.payload, null, 2)}</pre>
              </>
            ) : (
              <span className="mission-empty">Run commands to build a replay timeline.</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
