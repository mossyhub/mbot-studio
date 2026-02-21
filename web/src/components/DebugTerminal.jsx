import React, { useState, useEffect, useRef, useCallback } from 'react';
import './DebugTerminal.css';

const HISTORY_KEY = 'mbot-studio-repl-history';

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); }
  catch { return []; }
}
function saveHistory(history) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-50)));
}

export default function DebugTerminal({ robotConnected }) {
  const [code, setCode] = useState('');
  const [output, setOutput] = useState([]);
  const [cmdHistory, setCmdHistory] = useState(loadHistory);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [wsConnected, setWsConnected] = useState(false);
  const [diagRunning, setDiagRunning] = useState(false);
  const wsRef = useRef(null);
  const outputEndRef = useRef(null);
  const inputRef = useRef(null);
  const reconnectTimer = useRef(null);
  const closedRef = useRef(false);
  const lastStatusRef = useRef('');
  const seenReplIds = useRef(new Set());

  const addOutput = useCallback((type, text) => {
    const time = new Date().toLocaleTimeString();
    setOutput(prev => [...prev.slice(-500), { type, text, time }]);
  }, []);

  // WebSocket for real-time REPL + log streaming
  useEffect(() => {
    closedRef.current = false;

    function connect() {
      if (closedRef.current) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (closedRef.current) { ws.close(); return; }
        setWsConnected(true);
        addOutput('system', 'Connected to server');
      };

      ws.onmessage = (event) => {
        if (closedRef.current) return;
        try {
          const msg = JSON.parse(event.data);

          if (msg.type === 'mqtt' && msg.topic === 'robot/log') {
            const logMsg = typeof msg.data === 'object' ? msg.data.message || JSON.stringify(msg.data) : String(msg.data);
            addOutput('log', logMsg);
          }

          if (msg.type === 'mqtt' && msg.topic === 'robot/repl/result') {
            const result = msg.data;
            // Deduplicate by REPL id
            const rid = result.id || '';
            if (rid && seenReplIds.current.has(rid)) return;
            if (rid) seenReplIds.current.add(rid);
            // Keep set from growing unbounded
            if (seenReplIds.current.size > 100) {
              const arr = [...seenReplIds.current];
              seenReplIds.current = new Set(arr.slice(-50));
            }
            if (result.output) addOutput('result', result.output);
            if (result.error) addOutput('error', result.error);
            if (result.ok && !result.output && !result.error) addOutput('result', '(ok, no output)');
          }

          if (msg.type === 'repl_ack') {
            addOutput('system', `Sent to robot (id: ${msg.id})`);
          }

          // Only show status changes, not every heartbeat
          if (msg.type === 'mqtt' && msg.topic === 'robot/status') {
            const data = msg.data;
            if (typeof data === 'object' && data.status && data.status !== lastStatusRef.current) {
              lastStatusRef.current = data.status;
              addOutput('status', `Robot: ${data.status}`);
            }
          }
        } catch { /* ignore */ }
      };

      ws.onclose = () => {
        setWsConnected(false);
        wsRef.current = null;
        if (!closedRef.current) {
          reconnectTimer.current = setTimeout(connect, 3000);
        }
      };
    }
    connect();
    return () => {
      closedRef.current = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (wsRef.current) {
        wsRef.current.onclose = null; // prevent reconnect on intentional close
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [addOutput]);

  // Auto-scroll
  useEffect(() => {
    outputEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [output]);

  const sendRepl = useCallback((codeStr) => {
    if (!codeStr.trim()) return;
    addOutput('input', codeStr);

    // Save to command history
    const newHistory = [...cmdHistory.filter(h => h !== codeStr), codeStr];
    setCmdHistory(newHistory);
    saveHistory(newHistory);
    setHistoryIdx(-1);

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'repl', code: codeStr }));
    } else {
      addOutput('error', 'Not connected to server');
    }
  }, [cmdHistory, addOutput]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendRepl(code);
      setCode('');
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const newIdx = historyIdx + 1;
      if (newIdx < cmdHistory.length) {
        setHistoryIdx(newIdx);
        setCode(cmdHistory[cmdHistory.length - 1 - newIdx]);
      }
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const newIdx = historyIdx - 1;
      if (newIdx >= 0) {
        setHistoryIdx(newIdx);
        setCode(cmdHistory[cmdHistory.length - 1 - newIdx]);
      } else {
        setHistoryIdx(-1);
        setCode('');
      }
    }
  };

  const runDiagnostic = () => {
    setDiagRunning(true);
    addOutput('system', 'Starting motor diagnostic...');
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'diagnostic' }));
    }
    setTimeout(() => setDiagRunning(false), 15000);
  };

  const quickCommands = [
    { label: 'Forward', code: 'mbot2.forward(30)\ntime.sleep(1)\nmbot2.EM_stop()' },
    { label: 'Backward', code: 'mbot2.backward(30)\ntime.sleep(1)\nmbot2.EM_stop()' },
    { label: 'drive_speed', code: 'mbot2.drive_speed(30, 30)\ntime.sleep(1)\nmbot2.EM_stop()' },
    { label: 'EM_set_speed', code: 'mbot2.EM_set_speed(30, 30)\ntime.sleep(1)\nmbot2.EM_stop()' },
    { label: 'Stop', code: 'mbot2.EM_stop()' },
    { label: 'Beep', code: 'cyberpi.audio.play("score")' },
    { label: 'Battery', code: 'rprint("Battery:", cyberpi.get_battery())' },
    { label: 'Distance', code: 'rprint("Dist:", sensor.get_distance())' },
    { label: 'LED Red', code: 'cyberpi.led.show("red red red red red")' },
    { label: 'LED Green', code: 'cyberpi.led.show("green green green green green")' },
    { label: 'Show IP', code: 'rprint("IP:", mqtt.get_wifi_ip())' },
    { label: 'dir(mbot2)', code: 'rprint(dir(mbot2))' },
  ];

  return (
    <div className="debug-terminal">
      <div className="debug-sidebar">
        <div className="debug-section">
          <h3>Motor Diagnostic</h3>
          <p className="debug-hint">Tests multiple motor APIs and reports which ones work. Press Button B on robot to run locally.</p>
          <button
            className="btn-primary"
            onClick={runDiagnostic}
            disabled={diagRunning || !robotConnected}
          >
            {diagRunning ? 'Running...' : 'Run Diagnostic'}
          </button>
        </div>

        <div className="debug-section">
          <h3>Quick Commands</h3>
          <p className="debug-hint">Test individual motor APIs directly on the robot.</p>
          <div className="quick-commands">
            {quickCommands.map((qc, i) => (
              <button
                key={i}
                className="btn-small btn-secondary"
                onClick={() => sendRepl(qc.code)}
                disabled={!robotConnected}
                title={qc.code}
              >
                {qc.label}
              </button>
            ))}
          </div>
        </div>

        <div className="debug-section">
          <h3>Connection</h3>
          <div className="debug-status-row">
            <span className={`status-dot ${wsConnected ? 'connected' : 'disconnected'}`} />
            <span>Server: {wsConnected ? 'Connected' : 'Disconnected'}</span>
          </div>
          <div className="debug-status-row">
            <span className={`status-dot ${robotConnected ? 'connected' : 'disconnected'}`} />
            <span>Robot: {robotConnected ? 'Online' : 'Offline'}</span>
          </div>
        </div>
      </div>

      <div className="debug-main">
        <div className="debug-output">
          {output.length === 0 && (
            <div className="debug-empty">
              <p>Remote REPL - Execute MicroPython directly on the robot.</p>
              <p>Type code below or use quick commands. Robot logs stream here in real-time.</p>
              <p>Available objects: mbot2, cyberpi, time, motor, sensor, handler, mqtt</p>
              <p>Use <strong>rprint()</strong> instead of print() to see output here.</p>
            </div>
          )}
          {output.map((entry, i) => (
            <div key={i} className={`debug-line debug-${entry.type}`}>
              <span className="debug-time">{entry.time}</span>
              <span className="debug-prefix">
                {entry.type === 'input' ? '>>> ' :
                 entry.type === 'result' ? '' :
                 entry.type === 'error' ? 'ERR ' :
                 entry.type === 'log' ? 'LOG ' :
                 entry.type === 'status' ? '' :
                 ''}
              </span>
              <span className="debug-text">{entry.text}</span>
            </div>
          ))}
          <div ref={outputEndRef} />
        </div>

        <div className="debug-input-area">
          <span className="debug-prompt">&gt;&gt;&gt;</span>
          <textarea
            ref={inputRef}
            className="debug-input"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Enter MicroPython code... (Enter to send, Shift+Enter for newline)"
            rows={code.split('\n').length > 3 ? 4 : Math.max(1, code.split('\n').length)}
            disabled={!robotConnected}
          />
          <button
            className="btn-primary debug-send-btn"
            onClick={() => { sendRepl(code); setCode(''); }}
            disabled={!code.trim() || !robotConnected}
          >
            Run
          </button>
          <button
            className="btn-secondary debug-clear-btn"
            onClick={() => setOutput([])}
          >
            Clear
          </button>
        </div>
      </div>
    </div>
  );
}
