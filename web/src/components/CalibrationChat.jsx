import React, { useState, useRef, useEffect } from 'react';
import './CalibrationChat.css';

const WELCOME_MESSAGE = {
  role: 'assistant',
  content: "Hi there! 🤖📏 I'm ready to learn about how your robot moves!\n\nWe'll do some fun tests together — I'll move the robot, and you tell me how far it went. That way, when you say \"go forward 12 inches\", I'll know exactly what to do!\n\nWhat would you like to teach me about?",
  quickReplies: [
    "I want to teach you how far you go forward",
    "Let's test turning",
    "Teach you about going backward",
    "Walk me through everything!",
  ],
};

export default function CalibrationChat({ robotConnected, onAchievement }) {
  const [messages, setMessages] = useState([WELCOME_MESSAGE]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [calibrations, setCalibrations] = useState({});
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const achievementTriggered = useRef(false);

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Load existing calibrations on mount
  useEffect(() => {
    fetch('/api/config/calibrations')
      .then(r => r.json())
      .then(data => setCalibrations(data.calibrations || {}))
      .catch(console.error);
  }, []);

  const sendMessage = async (text) => {
    const msg = (text || input).trim();
    if (!msg || loading) return;

    setInput('');
    setLoading(true);

    const newMessages = [...messages, { role: 'user', content: msg }];
    setMessages(newMessages);

    // Trigger calibration achievement on first message
    if (!achievementTriggered.current && onAchievement) {
      onAchievement('calibration');
      achievementTriggered.current = true;
    }

    try {
      const res = await fetch('/api/config/calibrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg }),
      });

      const data = await res.json();

      const assistantMsg = {
        role: 'assistant',
        content: data.chat || 'Hmm, let me think about that...',
        quickReplies: data.quickReplies || [],
        hasCommand: !!data.robotCommand,
        commandType: data.robotCommand?.type,
        hasMeasurement: !!data.calibrationData,
        summary: data.summary || false,
      };

      setMessages([...newMessages, assistantMsg]);

      // Refresh calibrations if new data was saved
      if (data.calibrationData) {
        fetch('/api/config/calibrations')
          .then(r => r.json())
          .then(d => setCalibrations(d.calibrations || {}))
          .catch(console.error);
      }
    } catch (err) {
      setMessages([...newMessages, {
        role: 'assistant',
        content: "😵 Oops, I couldn't connect to the server. Is it running?",
        quickReplies: ["Try again"],
      }]);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const handleQuickReply = (reply) => {
    sendMessage(reply);
  };

  const handleClearSession = async () => {
    try {
      await fetch('/api/config/calibrate/clear', { method: 'POST' });
    } catch { /* ignore */ }
    setMessages([WELCOME_MESSAGE]);
  };

  const handleClearCalibrations = async () => {
    if (!confirm('Clear all calibration data? The robot will forget everything it learned.')) return;
    try {
      await fetch('/api/config/calibrations', { method: 'DELETE' });
      setCalibrations({});
    } catch { /* ignore */ }
  };

  // Count total data points
  const totalPoints = Object.values(calibrations).reduce(
    (sum, entries) => sum + (entries?.length || 0), 0
  );

  return (
    <div className="calibration-chat">
      {/* Calibration status bar */}
      <div className="cal-status-bar">
        <div className="cal-status-left">
          <span className="cal-title">🎓 Teach Your Robot</span>
          {totalPoints > 0 && (
            <span className="cal-data-count">{totalPoints} measurement{totalPoints !== 1 ? 's' : ''} saved</span>
          )}
        </div>
        <div className="cal-status-right">
          {!robotConnected && (
            <span className="cal-warning">⚠️ Robot not connected — tests won't move the robot</span>
          )}
          <button className="btn-tiny" onClick={handleClearSession} title="Start a new teaching session">
            🔄 New Session
          </button>
          {totalPoints > 0 && (
            <button className="btn-tiny btn-danger-tiny" onClick={handleClearCalibrations} title="Erase all learned data">
              🗑️ Clear Data
            </button>
          )}
        </div>
      </div>

      {/* Existing calibration summary */}
      {totalPoints > 0 && (
        <div className="cal-summary-bar">
          <span className="cal-summary-label">What I know:</span>
          {calibrations.forward?.length > 0 && (
            <span className="cal-chip cal-chip-forward">⬆️ Forward: {calibrations.forward.length} tests</span>
          )}
          {calibrations.backward?.length > 0 && (
            <span className="cal-chip cal-chip-backward">⬇️ Backward: {calibrations.backward.length} tests</span>
          )}
          {calibrations.turn_left?.length > 0 && (
            <span className="cal-chip cal-chip-turn">↩️ Left turns: {calibrations.turn_left.length} tests</span>
          )}
          {calibrations.turn_right?.length > 0 && (
            <span className="cal-chip cal-chip-turn">↪️ Right turns: {calibrations.turn_right.length} tests</span>
          )}
        </div>
      )}

      {/* Chat messages */}
      <div className="cal-messages">
        {messages.map((msg, i) => (
          <div key={i} className={`cal-message ${msg.role}`}>
            <div className="cal-avatar">
              {msg.role === 'user' ? '👦' : '🤖'}
            </div>
            <div className="cal-bubble">
              <div className="cal-text">{msg.content}</div>

              {/* Command indicator */}
              {msg.hasCommand && (
                <div className="cal-command-badge">
                  🏃 Robot is moving! ({msg.commandType?.replace('_', ' ')})
                </div>
              )}

              {/* Measurement saved indicator */}
              {msg.hasMeasurement && (
                <div className="cal-saved-badge">
                  📊 Measurement saved!
                </div>
              )}

              {/* Summary indicator */}
              {msg.summary && (
                <div className="cal-summary-badge">
                  🎓 Calibration knowledge updated!
                </div>
              )}

              {/* Quick replies */}
              {msg.quickReplies && msg.quickReplies.length > 0 && i === messages.length - 1 && !loading && (
                <div className="cal-quick-replies">
                  {msg.quickReplies.map((reply, ri) => (
                    <button
                      key={ri}
                      className="cal-quick-reply"
                      onClick={() => handleQuickReply(reply)}
                    >
                      {reply}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}

        {loading && (
          <div className="cal-message assistant">
            <div className="cal-avatar">🤖</div>
            <div className="cal-bubble">
              <div className="cal-typing">
                <span></span><span></span><span></span>
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="cal-input-area">
        <input
          ref={inputRef}
          type="text"
          className="cal-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a measurement or reply..."
          disabled={loading}
        />
        <button
          className="cal-send-btn"
          onClick={() => sendMessage()}
          disabled={!input.trim() || loading}
        >
          {loading ? '⏳' : '📩'}
        </button>
      </div>
    </div>
  );
}
