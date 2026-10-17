import React, { useState, useEffect, useRef, useCallback } from 'react';
import TelemetryPanel from './TelemetryPanel';
import SoundScreenControls from './SoundScreenControls';
import VoiceRecording from './VoiceRecording';
import './LiveControl.css';

const MAX_MISSION_EVENTS = 500;
const HOLD_DELAY_MS = 180;
const TAP_TIMEOUT_MS = 3000;

function DirectionArrow({ rotation = 0 }) {
  return <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true" focusable="false"
    style={{ transform: `rotate(${rotation}deg)` }} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 20V4m-7 7 7-7 7 7" />
  </svg>;
}

function createHoldId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // LAN HTTP origins lack randomUUID, but still expose cryptographic entropy.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

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
  const [avStatus, setAvStatus] = useState(null);
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
  const recordingRequestController = useRef(null);
  const recordingStatusRef = useRef(null);
  const cancelRecordingPlayback = useCallback(() => {
    // Identity is the generation fence, even if a response body already resolved.
    const controller = recordingRequestController.current;
    recordingRequestController.current = null;
    controller?.abort();
  }, []);
  const directQueueRef = useRef([]);
  const directQueueRunningRef = useRef(false);
  const directQueueTimerRef = useRef(null);
  const directQueueGenerationRef = useRef(0);
  const driveRef = useRef(null);
  const [activeDirection, setActiveDirection] = useState(null);
  const [motorPower, setMotorPower] = useState(50);
  const [showRecordings, setShowRecordings] = useState(false);
  const [recordingEpoch, setRecordingEpoch] = useState(0);
  const supportsDriveHold = Array.isArray(avStatus?.capabilities) && avStatus.capabilities.includes('drive_hold');
  const supportsDriveTap = supportsDriveHold && avStatus.capabilities.includes('drive_tap');
  const maxMotorPower = avStatus?.capabilities?.includes('motor_power_100') ? 100 : 50;
  const driveReady = supportsDriveHold && robotConnected && wsConnected && avStatus.armed === true && avStatus.motion_enabled === true
    && avStatus.robotOnline !== false && ![avStatus.status, avStatus.state, avStatus.robotState].includes('offline');

  const cancelDrive = useCallback((sendStop = true) => {
    const hold = driveRef.current;
    if (!hold) return;
    // Invalidate first: late timers, capture events and old device replies are inert.
    driveRef.current = null;
    clearInterval(hold.renewTimer);
    clearTimeout(hold.ackTimer);
    clearTimeout(hold.intentTimer);
    clearTimeout(hold.tapTimer);
    setActiveDirection(null);
    if (sendStop && hold.phase !== 'pending' && hold.socket.readyState === WebSocket.OPEN) {
      try { hold.socket.send(JSON.stringify({ type: 'drive_stop', hold_id: hold.id })); } catch { /* lease expires if transport is lost */ }
    }
    if (hold.pointerId !== undefined && hold.element?.hasPointerCapture?.(hold.pointerId)) {
      hold.element.releasePointerCapture(hold.pointerId);
    }
  }, []);

  const startDrive = (hold) => {
    if (driveRef.current !== hold || hold.phase !== 'pending' || wsRef.current !== hold.socket) return;
    if (hold.socket.readyState !== WebSocket.OPEN) { cancelDrive(); return; }
    const now = performance.now();
    Object.assign(hold, { phase: 'held', startedAt: now, lastAck: now, startAcknowledged: false, pendingRenews: 0 });
    const checkAck = () => {
      if (driveRef.current !== hold || wsRef.current !== hold.socket) return false;
      const now = performance.now();
      if ((!hold.startAcknowledged && now - hold.startedAt > 500) || now - hold.lastAck > 500) {
        cancelDrive();
        addLog('error', 'Drive canceled: server submission acknowledgement timed out. Release and press again.');
        return false;
      }
      return true;
    };
    hold.armAckWatchdog = () => {
      if (driveRef.current !== hold) return;
      clearTimeout(hold.ackTimer);
      const deadline = Math.min(hold.startAcknowledged ? Infinity : hold.startedAt + 501, hold.lastAck + 501);
      hold.ackTimer = setTimeout(() => {
        if (checkAck()) hold.armAckWatchdog();
      }, Math.max(1, deadline - performance.now()));
    };
    hold.armAckWatchdog();
    try {
      hold.socket.send(JSON.stringify({ type: 'drive_start', hold_id: hold.id, direction: hold.direction, speed: hold.speed }));
    } catch {
      cancelDrive();
      addLog('error', 'Drive canceled: transport failed.');
      return;
    }
    if (driveRef.current !== hold) return;
    hold.renewTimer = setInterval(() => {
      if (!checkAck()) return;
      hold.pendingRenews++;
      try {
        if (hold.socket.readyState !== WebSocket.OPEN) { cancelDrive(); return; }
        hold.socket.send(JSON.stringify({ type: 'drive_renew', hold_id: hold.id }));
      } catch {
        cancelDrive();
        addLog('error', 'Drive canceled: transport failed.');
      }
    }, 200);
  };

  const beginDriveIntent = (direction, owner) => {
    if (!driveReady || driveRef.current || wsRef.current?.readyState !== WebSocket.OPEN) return;
    cancelDirectQueue();
    aiRequestController.current?.abort();
    aiRequestController.current = null;
    setSending(false);
    const hold = { id: createHoldId(), socket: wsRef.current, direction, boot: avStatus.boot,
      phase: 'pending', speed: Math.min(motorPower, maxMotorPower), tapCapable: supportsDriveTap,
      pressedAt: performance.now(), ...owner };
    driveRef.current = hold;
    setActiveDirection(direction);
    if (supportsDriveTap) hold.intentTimer = setTimeout(() => startDrive(hold), HOLD_DELAY_MS);
    else startDrive(hold); // Older held-drive firmware has no native bounded-power tap.
  };

  const releaseDrive = (event) => {
    const hold = driveRef.current;
    if (!hold || hold.phase === 'tap') return;
    if (hold.phase !== 'pending' || performance.now() - hold.pressedAt >= HOLD_DELAY_MS) {
      cancelDrive();
      return;
    }
    // Captured pointerup is retargeted to the button even when released outside it.
    if (hold.pointerId !== undefined) {
      const rect = hold.element.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX >= rect.right || event.clientY < rect.top || event.clientY >= rect.bottom) {
        cancelDrive();
        return;
      }
    }
    if (wsRef.current !== hold.socket || hold.socket.readyState !== WebSocket.OPEN) { cancelDrive(); return; }
    clearTimeout(hold.intentTimer);
    hold.phase = 'tap';
    // Release input ownership before releasePointerCapture fires lostcapture/blur.
    const { element, pointerId } = hold;
    delete hold.pointerId;
    delete hold.key;
    hold.element = null;
    if (pointerId !== undefined && element?.hasPointerCapture?.(pointerId)) element.releasePointerCapture(pointerId);
    hold.tapTimer = setTimeout(() => {
      if (driveRef.current !== hold || wsRef.current !== hold.socket) return;
      cancelDrive();
      addLog('error', 'Tap canceled: device completion timed out. Press again to retry.');
    }, TAP_TIMEOUT_MS);
    try {
      hold.socket.send(JSON.stringify({ type: 'drive_tap', hold_id: hold.id, direction: hold.direction, speed: hold.speed }));
    } catch {
      cancelDrive();
      addLog('error', 'Tap canceled: transport failed.');
    }
  };

  const directionProps = (direction, command) => ({
    'aria-label': direction,
    'aria-describedby': 'drive-help',
    'aria-pressed': activeDirection === direction,
    disabled: supportsDriveHold && !driveReady,
    onMouseDown: () => { if (!supportsDriveHold) enqueueDirectCommand(command); },
    onPointerDown: event => {
      if (!supportsDriveHold) return;
      event.preventDefault();
      if (event.button !== 0 || event.isPrimary === false || driveRef.current) return;
      const element = event.currentTarget;
      element.focus();
      beginDriveIntent(direction, { element, pointerId: event.pointerId });
      if (driveRef.current?.element === element) {
        try { element.setPointerCapture(event.pointerId); } catch { /* synthetic events have no active pointer */ }
      }
    },
    onPointerUp: event => { if (driveRef.current?.pointerId === event.pointerId) releaseDrive(event); },
    onPointerCancel: event => { if (driveRef.current?.pointerId === event.pointerId) cancelDrive(); },
    onLostPointerCapture: event => { if (driveRef.current?.pointerId === event.pointerId) cancelDrive(); },
    onBlur: event => { if (driveRef.current?.element === event.currentTarget) cancelDrive(); },
    onKeyDown: event => {
      if (!supportsDriveHold || ![' ', 'Enter'].includes(event.key)) return;
      event.preventDefault();
      if (!event.repeat && !driveRef.current) beginDriveIntent(direction, { element: event.currentTarget, key: event.key });
    },
    onKeyUp: event => {
      if (!supportsDriveHold || ![' ', 'Enter'].includes(event.key)) return;
      event.preventDefault();
      if (driveRef.current?.key === event.key && driveRef.current.element === event.currentTarget) releaseDrive(event);
    },
  });

  const receiveDriveStatus = useCallback(status => {
    if (['boot', 'build', 'application', 'device'].some(key => status?.[key] !== recordingStatusRef.current?.[key])
      || status?.mqttConnected === false || status?.robotOnline === false
      || !status?.capabilities?.includes('recorded_audio_v1')
      || [status?.status, status?.state, status?.robotState].includes('offline')) cancelRecordingPlayback();
    recordingStatusRef.current = status;
    const hold = driveRef.current;
    if (hold && (status?.boot !== hold.boot || status?.armed !== true || status?.motion_enabled !== true
      || !status?.capabilities?.includes('drive_hold') || status?.robotOnline === false
      || (hold.tapCapable && !status?.capabilities?.includes('drive_tap'))
      || (hold.speed > 50 && !status?.capabilities?.includes('motor_power_100'))
      || [status?.status, status?.state, status?.robotState].includes('offline'))) cancelDrive();
    setAvStatus(status);
  }, [cancelDrive, cancelRecordingPlayback]);

  useEffect(() => {
    if (!driveReady) cancelDrive();
  }, [driveReady, cancelDrive]);

  useEffect(() => {
    const visibility = () => { if (document.visibilityState === 'hidden') cancelDrive(); };
    window.addEventListener('blur', cancelDrive);
    window.addEventListener('pagehide', cancelDrive);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('blur', cancelDrive);
      window.removeEventListener('pagehide', cancelDrive);
      document.removeEventListener('visibilitychange', visibility);
      cancelDrive();
    };
  }, [cancelDrive]);

  const cancelDirectQueue = useCallback(() => {
    cancelRecordingPlayback();
    // Fence callbacks already ready to run as well as canceling the timer.
    directQueueGenerationRef.current++;
    if (directQueueTimerRef.current !== null) clearTimeout(directQueueTimerRef.current);
    directQueueTimerRef.current = null;
    directQueueRef.current = [];
    directQueueRunningRef.current = false;
  }, [cancelRecordingPlayback]);

  useEffect(() => {
    if (!robotConnected) cancelDirectQueue();
  }, [robotConnected, cancelDirectQueue]);

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
    // Scroll only the log, never pull the drive controls out from under a press.
    const container = logEndRef.current?.parentElement;
    if (container) container.scrollTop = container.scrollHeight;
  }, [log]);

  // WebSocket connection with auto-reconnect
  useEffect(() => {
    let statusController;
    let statusRevision = 0;
    function connect() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws`;

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (wsRef.current !== ws) return;
        setWsConnected(true);
        // Bootstrap on each socket connection; a newer WS status always wins.
        const revision = statusRevision;
        statusController = new AbortController();
        fetch('/api/robot/status', { signal: statusController.signal })
          .then(response => response.ok ? response.json() : null)
          .then(status => {
            if (wsRef.current === ws && ws.readyState === WebSocket.OPEN && revision === statusRevision) receiveDriveStatus(status);
          })
          .catch(() => {}); // Unknown status stays disabled; never infer support.
        reconnectAttempts.current = 0;
        addLog('system', '🔌 Connected to server');
        recordMissionEvent('ws_open', { connected: true });
      };

      ws.onmessage = (event) => {
        if (wsRef.current !== ws) return;
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'drive_ack') {
            const hold = driveRef.current;
            if (!hold || hold.id !== msg.hold_id || hold.phase === 'pending') return;
            if (hold.phase === 'tap') {
              if (msg.op === 'tap') addLog('system', `Tap submitted [hold_id=${hold.id}] — submission only, not confirmed movement`);
              return; // No renewal or hold ACK watchdog for a device-bounded tap.
            }
            const now = performance.now();
            if ((!hold.startAcknowledged && now - hold.startedAt > 500) || now - hold.lastAck > 500) {
              cancelDrive();
              return;
            }
            if (msg.op === 'start' && !hold.startAcknowledged) {
              hold.startAcknowledged = true;
              hold.lastAck = now;
              addLog('system', `Drive submitted [hold_id=${hold.id}] — submission only, not confirmed movement`);
            } else if (msg.op === 'renew' && hold.pendingRenews > 0) {
              hold.pendingRenews--;
              hold.lastAck = now;
            }
            hold.armAckWatchdog();
          } else if (msg.type === 'drive_error') {
            if (driveRef.current?.id !== msg.hold_id) return;
            cancelDrive();
            addLog('error', `Drive rejected: ${msg.message}`);
          } else if (msg.type === 'mqtt' && msg.topic === 'robot/drive_status') {
            const status = msg.data;
            const hold = driveRef.current;
            if (!hold || hold.id !== status?.hold_id) return;
            if (status.boot !== hold.boot || ['stopped', 'rejected'].includes(status.event)) {
              cancelDrive(hold.phase !== 'tap' || status.boot !== hold.boot);
            }
            addLog('robot', `Device drive ${status.event} [hold_id=${status.hold_id}]${status.reason ? `: ${status.reason}` : ''}`);
            recordMissionEvent('drive_status', status);
          } else if (msg.type === 'mqtt' && msg.topic === 'robot/sensors') {
            setSensorData(msg.data);
            recordMissionEvent('telemetry', msg.data);
          } else if (msg.type === 'mqtt' && msg.topic === 'robot/status') {
            statusRevision++;
            receiveDriveStatus(msg.data);
            if (msg.data?.status === 'offline' || msg.data?.state === 'offline' || msg.data?.robotOnline === false) cancelDirectQueue();
            addLog('robot', `Robot: ${JSON.stringify(msg.data)}`);
            recordMissionEvent('robot_status', msg.data);
          } else if (msg.type === 'mqtt' && msg.topic === 'robot/log') {
            addLog('robot', `🤖 ${typeof msg.data === 'string' ? msg.data : JSON.stringify(msg.data)}`);
            recordMissionEvent('robot_log', msg.data);
          } else if (msg.type === 'mqtt' && msg.topic === 'robot/execution') {
            const execution = msg.data;
            if (!execution || typeof execution !== 'object' || !execution.event) return;
            // Only program-scoped events describe the whole run. A block can
            // complete while a later block still fails or is canceled.
            const scope = execution.type === 'program' ? 'Program' : `Block ${execution.type || 'unknown'}`;
            const correlation = execution.run_id ? `run_id=${execution.run_id}` : 'uncorrelated';
            const details = execution.details == null ? '' : `: ${typeof execution.details === 'string' ? execution.details : JSON.stringify(execution.details)}`;
            addLog(execution.event === 'failed' ? 'error' : 'robot', `${scope} ${execution.event} [${correlation}]${details}`);
            recordMissionEvent(execution.type === 'program' ? `program_${execution.event}` : 'execution_block', execution);
          } else if (msg.type === 'ack') {
            addLog('system', `✅ Command sent: ${msg.command}${msg.run_id ? ` [run_id=${msg.run_id}] — submission only; see device execution events` : ''}`);
            recordMissionEvent('ack', { command: msg.command, ...(msg.run_id ? { run_id: msg.run_id } : {}) });
          } else if (msg.type === 'error') {
            cancelDrive();
            addLog('error', `❌ ${msg.message}`);
            recordMissionEvent('ws_error', { message: msg.message });
          }
        } catch (e) {
          console.error('WS message error:', e);
        }
      };

      ws.onclose = () => {
        if (wsRef.current !== ws) return;
        cancelDrive();
        statusController?.abort();
        statusRevision++;
        setAvStatus(null);
        cancelDirectQueue();
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
        if (wsRef.current !== ws) return;
        cancelDrive();
        cancelDirectQueue();
        setWsConnected(false);
        setAvStatus(null);
      };
    }

    connect();

    return () => {
      // Abandon pending AI work before this Live Control instance goes away.
      statusController?.abort();
      cancelDrive();
      cancelDirectQueue();
      aiRequestController.current?.abort();
      aiRequestController.current = null;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
      if (missionPlayTimer.current) clearInterval(missionPlayTimer.current);
    };
  }, [addLog, recordMissionEvent, cancelDirectQueue, cancelDrive, receiveDriveStatus]);

  const sendLiveCommand = async (voiceText) => {
    const text = voiceText || liveInput.trim();
    if (!text || sending || driveRef.current) return;

    setSending(true);
    setLiveInput('');
    addLog('user', `💬 ${text}`);
    recordMissionEvent('live_prompt', { text });
    const controller = new AbortController();
    aiRequestController.current = controller;

    // First live control achievement
    if (onAchievement) onAchievement('first_live');

    try {
      // Use AI to interpret the command and generate immediate actions
      const res = await fetch('/api/ai/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ message: text }),
      });
      const data = await res.json();
      // STOP/unmount can invalidate work even after the response has arrived.
      if (controller.signal.aborted || aiRequestController.current !== controller) return;

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
          signal: controller.signal,
          body: JSON.stringify({ program: data.program }),
        });
        const robotData = await robotRes.json();
        if (controller.signal.aborted || aiRequestController.current !== controller) return;

        if (!robotRes.ok || robotData.error || robotData.sent === false) {
          const error = robotData.error || 'Program was not sent';
          addLog('error', `❌ ${error}${robotData.run_id ? ` [run_id=${robotData.run_id}]` : ''}`);
          recordMissionEvent('program_send_error', { error, ...(robotData.run_id ? { run_id: robotData.run_id } : {}) });
        } else {
          addLog('system', robotData.run_id
            ? `📡 Program sent [run_id=${robotData.run_id}] — submission only; see device execution events`
            : '📡 Program sent to robot! Execution unverified');
          recordMissionEvent('program_sent', { blockCount: data.program.length, ...(robotData.run_id ? { run_id: robotData.run_id } : {}) });
        }
      } else if (data.chat) {
        addLog('ai', `🤖 ${data.chat}`);
        recordMissionEvent('ai_chat', { message: data.chat });
      }
    } catch (err) {
      if (aiRequestController.current !== controller) return;
      if (err.name === 'AbortError') {
        addLog('system', '🛑 AI command canceled');
        recordMissionEvent('ai_canceled', { text });
        return;
      }
      addLog('error', `❌ Error: ${err.message}`);
      recordMissionEvent('client_error', { message: err.message });
    } finally {
      if (aiRequestController.current === controller) {
        aiRequestController.current = null;
        setSending(false);
      }
    }
  };

  const processDirectQueue = useCallback(() => {
    if (directQueueRunningRef.current) return;
    if (directQueueRef.current.length === 0) return;
    directQueueRunningRef.current = true;
    const generation = directQueueGenerationRef.current;

    const runNext = () => {
      if (generation !== directQueueGenerationRef.current) return;
      directQueueTimerRef.current = null;
      if (driveRef.current || wsRef.current?.readyState !== WebSocket.OPEN) {
        cancelDirectQueue();
        return;
      }
      const nextCommand = directQueueRef.current.shift();
      if (!nextCommand) {
        directQueueRunningRef.current = false;
        return;
      }

      wsRef.current.send(JSON.stringify({ type: 'command', command: nextCommand }));

      directQueueTimerRef.current = setTimeout(runNext, 120);
    };

    runNext();
  }, [cancelDirectQueue]);

  const enqueueDirectCommand = useCallback((command) => {
    if (driveRef.current) return; // Never queue a command behind held movement.
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

  const playRecording = async (block) => {
    if (driveRef.current || recordingRequestController.current || !robotConnected
      || wsRef.current?.readyState !== WebSocket.OPEN) return;
    // Snapshot only editor source. The Program route resolves trusted duration,
    // prepares the asset and re-admits the immutable program before publication.
    const body = JSON.stringify({ program: [{ type: 'play_recording', recording: block.recording }] });
    const controller = new AbortController();
    recordingRequestController.current = controller;
    try {
      const response = await fetch('/api/robot/program', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: controller.signal,
      });
      const data = await response.json();
      if (controller.signal.aborted || recordingRequestController.current !== controller) return;
      if (!response.ok || data.error || data.sent !== true) {
        addLog('error', `Recording not sent: ${data.error || 'Program was not sent'}`);
      } else {
        addLog('system', `Recording submitted${data.run_id ? ` [run_id=${data.run_id}]` : ''} — submission only; see device execution events`);
        recordMissionEvent('program_sent', { blockCount: 1, ...(data.run_id ? { run_id: data.run_id } : {}) });
      }
    } catch (error) {
      if (!controller.signal.aborted && recordingRequestController.current === controller) {
        addLog('error', `Recording not sent: ${error.message}`);
      }
    } finally {
      if (recordingRequestController.current === controller) recordingRequestController.current = null;
    }
  };

  const cancelAiCommand = useCallback(() => {
    if (aiRequestController.current) {
      aiRequestController.current.abort();
    }
  }, []);

  const stopSequenceRef = useRef(0);
  const stopLiveWork = useCallback(() => {
    // Shell Stop must invalidate local work without calling the shell again.
    stopSequenceRef.current++;
    setRecordingEpoch(epoch => epoch + 1);
    cancelDrive();
    cancelDirectQueue();
    aiRequestController.current?.abort();
    aiRequestController.current = null;
    setSending(false);
    addLog('system', '🛑 EMERGENCY STOP!');
    recordMissionEvent('emergency_stop', { source: 'ui' });
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      try { wsRef.current.send(JSON.stringify({ type: 'emergency_stop' })); }
      catch { /* The shell also sends the independent HTTP emergency Stop. */ }
    }
  }, [cancelDrive, cancelDirectQueue, addLog, recordMissionEvent]);

  useEffect(() => {
    window.addEventListener('mbot-global-stop', stopLiveWork);
    return () => window.removeEventListener('mbot-global-stop', stopLiveWork);
  }, [stopLiveWork]);

  const handleStop = () => {
    const sequence = stopSequenceRef.current;
    onStop?.();
    // Keep standalone/legacy hosts working; the Guided shell dispatches synchronously.
    if (stopSequenceRef.current === sequence) stopLiveWork();
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
  const configuredPorts = (robotConfig?.additions || []).filter(addition =>
    (addition.type === 'servo' && /^S[1-4]$/.test(addition.port)) ||
    (addition.type === 'dc_motor' && /^M[1-4]$/.test(addition.port)));

  const portControls = (port, type) => type === 'servo'
    ? [0, 45, 90, 135, 180].map(angle => (
      <button key={angle} className="btn-small btn-secondary"
        onClick={() => enqueueDirectCommand({ type: 'servo', port, angle })}
        disabled={!robotConnected || !!activeDirection}>{angle}°</button>
    ))
    : [{ label: 'FWD', speed: 50, duration: 1 }, { label: 'REV', speed: -50, duration: 1 }, { label: 'OFF', speed: 0, duration: 0 }].map(({ label, speed, duration }) => (
      <button key={label} className={`btn-small ${speed === 0 ? 'btn-danger' : 'btn-secondary'}`}
        onClick={() => enqueueDirectCommand({ type: 'dc_motor', port, speed, duration })}
        disabled={!robotConnected || !!activeDirection}>{label}</button>
    ));

  return (
    <div className="live-control">
      <header className="live-page-heading">
        <div><h1>Live Control</h1><p>Drive your robot, then try its configured hardware and signals.</p></div>
        <span className={`live-connection ${robotConnected && wsConnected ? 'connected' : ''}`}>
          {robotConnected && wsConnected ? 'Robot connected' : 'Robot disconnected'}
        </span>
      </header>
      <div className="live-primary">
      <div className="live-controls-panel panel">
        <div className="panel-header">
          <h2>Drive</h2>
          <button className="btn-danger" onClick={handleStop}>
            🛑 STOP
          </button>
        </div>

        {/* Direction Pad */}
        <div className="direction-pad">
          <h3>Quick Controls</h3>
          {supportsDriveHold && <div className="live-subtext">
            <label htmlFor="drive-power">Motor power (%)</label>{' '}
            <output htmlFor="drive-power">{Math.min(motorPower, maxMotorPower)}%</output>
            <input id="drive-power" type="range" min="0" max={maxMotorPower} step="1"
              value={Math.min(motorPower, maxMotorPower)} disabled={!driveReady || !!activeDirection}
              aria-describedby="drive-help"
              onChange={event => { if (!driveRef.current) setMotorPower(Number(event.target.value)); }} />
          </div>}
          <p id="drive-help" className="live-subtext" role="status">
            {supportsDriveHold
              ? `${supportsDriveTap ? 'Tap for a bounded 400 ms nudge at the selected power. Hold for 180 ms to drive continuously; release to stop. ' : 'Hold a direction to drive at the selected power; release to stop. Firmware update required for bounded-power taps. '}Space or Enter works on a focused direction. Power is captured at press; 0% requests no motor power. ACK means submission, not confirmed movement.`
              : 'Firmware update required for hold-to-drive. Tap-only fallback: each press sends one bounded movement; release does not shorten it. Use STOP to cancel.'}
            {supportsDriveHold && !driveReady && ' Connect and arm the robot with motion enabled to drive.'}
            {activeDirection && ` Requesting ${activeDirection}. Other commands are paused until release or tap completion.`}
          </p>
          <div className="dpad">
            <div className="dpad-row">
              <div className="dpad-spacer" />
              <button
                className="dpad-btn dpad-up"
                {...directionProps('forward', { type: 'move_forward', speed: 50, duration: 0.5 })}
              >
                <DirectionArrow />
              </button>
              <div className="dpad-spacer" />
            </div>
            <div className="dpad-row">
              <button
                className="dpad-btn dpad-left"
                title="Small left turn — native angle request, not calibrated heading"
                {...directionProps('left', { type: 'turn_left', angle: 30 })}
              >
                <DirectionArrow rotation={-90} />
              </button>
              <button
                className="dpad-btn dpad-stop"
                aria-label="Stop drive"
                onClick={handleStop}
              >
                STOP
              </button>
              <button
                className="dpad-btn dpad-right"
                title="Small right turn — native angle request, not calibrated heading"
                {...directionProps('right', { type: 'turn_right', angle: 30 })}
              >
                <DirectionArrow rotation={90} />
              </button>
            </div>
            <div className="dpad-row">
              <div className="dpad-spacer" />
              <button
                className="dpad-btn dpad-down"
                {...directionProps('backward', { type: 'move_backward', speed: 50, duration: 0.5 })}
              >
                <DirectionArrow rotation={180} />
              </button>
              <div className="dpad-spacer" />
            </div>
          </div>
        </div>

      </div>
      <section className="configured-hardware" aria-labelledby="configured-heading">
        <h2 id="configured-heading">Your hardware</h2>
        {configuredPorts.length === 0 && <p className="live-subtext">Name your servos and motors in Robot settings. All ports remain available below.</p>}
        {configuredPorts.map((addition, index) => (
          <fieldset className="configured-port" key={`${addition.port}-${index}`}>
            <legend>{addition.label || addition.port} · {addition.port}</legend>
            <p className="live-subtext">{addition.type === 'servo'
              ? 'Requested servo angle, not a measured joint position. Check mechanical limits before moving.'
              : 'FWD / REV requests ±50% power for 1 second. OFF requests zero power. Grip and position are not confirmed.'}</p>
            <div className="hw-port-row">{portControls(addition.port, addition.type)}</div>
          </fieldset>
        ))}
      </section>
      </div>

      <fieldset className="drive-telemetry" disabled={!!activeDirection}>
        <legend>Sensor snapshot</legend>
        <TelemetryPanel wsRef={wsRef} wsConnected={wsConnected} robotConnected={robotConnected} />
      </fieldset>

      <details className="live-hw-panel panel advanced-ports">
        <summary>Advanced port controls</summary>
        <p className="live-subtext">All servo and motor ports, including unconfigured ports. Check what is attached before sending a command.</p>
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
                  disabled={!robotConnected || !!activeDirection}
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
              <button className="btn-small btn-success" onClick={() => enqueueDirectCommand({ type: 'dc_motor', port, speed: 50, duration: 1 })} disabled={!robotConnected || !!activeDirection}>FWD</button>
              <button className="btn-small btn-secondary" onClick={() => enqueueDirectCommand({ type: 'dc_motor', port, speed: -50, duration: 1 })} disabled={!robotConnected || !!activeDirection}>REV</button>
              <button className="btn-small btn-danger" onClick={() => enqueueDirectCommand({ type: 'dc_motor', port, speed: 0, duration: 0 })} disabled={!robotConnected || !!activeDirection}>OFF</button>
            </div>
          ))}
        </div>
      </details>
      <section className="live-output panel" aria-label="Sound, screen and recordings">
        <SoundScreenControls
          status={avStatus}
          connected={robotConnected && wsConnected && !!avStatus && avStatus.robotOnline !== false && avStatus.status !== 'offline' && avStatus.state !== 'offline' && avStatus.robotState !== 'offline'}
          onCommand={enqueueDirectCommand}
          onStop={handleStop}
        />
        <details className="live-recordings" onToggle={event => setShowRecordings(event.currentTarget.open)}>
          <summary>Voice recordings</summary>
          <p className="live-subtext">Record, preview and sync clips. “Use clip” submits playback to the robot; check the activity log for execution.</p>
          {showRecordings && <fieldset disabled={!!activeDirection} aria-label="Voice clip controls"
            style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            <VoiceRecording key={recordingEpoch}
              runtimeStatus={{ ...avStatus, robotOnline: robotConnected && wsConnected && avStatus?.robotOnline !== false
                && ![avStatus?.status, avStatus?.state, avStatus?.robotState].includes('offline'),
                mqttConnected: wsConnected && avStatus?.mqttConnected !== false }}
              onSelect={playRecording} />
          </fieldset>}
        </details>
      </section>

      <section className="live-command-area panel">
        <h2>Ask the robot</h2>
        <p className="live-subtext">AI turns your words into commands and submits them immediately. Keep STOP within reach.</p>
        <div className="live-input-row">
          <input type="text" aria-label="Live command" value={liveInput}
            onChange={event => setLiveInput(event.target.value)}
            onKeyDown={event => event.key === 'Enter' && sendLiveCommand()}
            placeholder='e.g., "Go forward slowly" or "Open the claw"'
            disabled={sending || !!activeDirection} />
          <button className="btn-primary" onClick={() => sendLiveCommand()}
            disabled={!liveInput.trim() || sending || !!activeDirection}>{sending ? '⏳' : '▶️ Go!'}</button>
          <button className="btn-secondary" onClick={cancelAiCommand} disabled={!sending}
            title="Cancel current AI command">✋ Cancel</button>
        </div>
      </section>

      {/* Right: Activity Log */}
      <details className="live-log-panel panel">
        <summary>Activity log &amp; replay</summary>
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
          <p className="live-subtext">Replay reviews recorded events only. It does not run commands again.</p>

          <div className="mission-controls-row">
            <input
              className="mission-name-input"
              aria-label="Session name"
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
              <select className="mission-select" aria-label="Load saved session" onChange={(e) => handleLoadMission(e.target.value)} defaultValue="">
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
            aria-label="Replay event"
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
      </details>
    </div>
  );
}
