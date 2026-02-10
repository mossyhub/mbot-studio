import React from 'react';
import './StatusBar.css';

function getStatusInfo(robotStatus) {
  if (!robotStatus) return { className: 'status-disconnected', icon: '🔴', text: 'Server Offline' };

  if (robotStatus.robotOnline) {
    const stateLabel = robotStatus.robotState === 'running' ? ' (Running)' : '';
    return { className: 'status-connected', icon: '🟢', text: `Robot Online${stateLabel}` };
  }

  if (robotStatus.mqttConnected) {
    return { className: 'status-waiting', icon: '🟡', text: 'Waiting for Robot' };
  }

  return { className: 'status-disconnected', icon: '🔴', text: 'Server Offline' };
}

export default function StatusBar({ robotConnected, robotStatus, soundMuted, onSoundToggle }) {
  const status = getStatusInfo(robotStatus);

  return (
    <footer className="status-bar">
      <div className="status-left">
        <span className={`status-badge ${status.className}`}>
          {status.icon} {status.text}
        </span>
        {robotStatus?.mqttConnected && !robotStatus?.robotOnline && (
          <span className="status-hint">
            Turn on your mBot2 — it needs the firmware uploaded and WiFi connected
          </span>
        )}
      </div>
      <div className="status-right">
        <span className="status-item">mBot Studio v2.0</span>
        <span className="status-item">AI: GitHub Copilot</span>
        {soundMuted && (
          <button className="status-sound-btn" onClick={onSoundToggle} title="Sound is muted — click to unmute">
            🔇 Muted
          </button>
        )}
      </div>
    </footer>
  );
}
