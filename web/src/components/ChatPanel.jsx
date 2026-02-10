import React, { useState, useRef, useEffect } from 'react';
import './ChatPanel.css';

export default function ChatPanel({ messages, setMessages, onAIResponse, currentBlocks }) {
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || loading) return;

    setInput('');
    setLoading(true);

    // Add user message
    const newMessages = [...messages, { role: 'user', content: text }];
    setMessages(newMessages);

    try {
      const res = await fetch('/api/ai/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          currentBlocks: currentBlocks && currentBlocks.length > 0 ? currentBlocks : undefined,
        }),
      });

      const data = await res.json();

      // Build assistant message
      let assistantMsg = '';
      if (data.explanation) {
        assistantMsg = data.explanation;
      } else if (data.chat) {
        assistantMsg = data.chat;
      } else if (data.error) {
        assistantMsg = '😵 Oops! Something went wrong. Try again?';
      }

      setMessages([...newMessages, {
        role: 'assistant',
        content: assistantMsg,
        hasProgram: !!data.program,
        blockCount: data.program?.length || 0,
      }]);

      // Pass the generated program up to parent
      if (data.program || data.pythonCode) {
        onAIResponse(data);
      }
    } catch (err) {
      setMessages([...newMessages, {
        role: 'assistant',
        content: '😵 I couldn\'t connect to the server. Is it running?',
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

  const quickPrompts = [
    "Go forward 3 seconds",
    "Do a dance! 💃",
    "Explore and avoid walls",
    "Draw a square",
  ];

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <h2>💬 Talk to Your Robot</h2>
      </div>

      <div className="chat-messages">
        {messages.map((msg, i) => (
          <div key={i} className={`chat-message ${msg.role}`}>
            <div className="message-avatar">
              {msg.role === 'user' ? '👦' : '🤖'}
            </div>
            <div className="message-bubble">
              <div className="message-text">{msg.content}</div>
              {msg.hasProgram && (
                <div className="message-program-badge">
                  ✨ Created {msg.blockCount} block{msg.blockCount !== 1 ? 's' : ''}! Check the program panel →
                </div>
              )}
            </div>
          </div>
        ))}

        {loading && (
          <div className="chat-message assistant">
            <div className="message-avatar">🤖</div>
            <div className="message-bubble">
              <div className="typing-indicator">
                <span></span><span></span><span></span>
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {messages.length <= 1 && (
        <div className="quick-prompts">
          <p className="quick-prompts-label">Try one of these:</p>
          <div className="quick-prompts-grid">
            {quickPrompts.map((prompt, i) => (
              <button
                key={i}
                className="quick-prompt"
                onClick={() => { setInput(prompt); inputRef.current?.focus(); }}
              >
                {prompt}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="chat-input-area">
        <textarea
          ref={inputRef}
          className="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Tell your robot what to do..."
          rows={2}
          disabled={loading}
        />
        <button
          className="chat-send-btn"
          onClick={sendMessage}
          disabled={!input.trim() || loading}
        >
          {loading ? '⏳' : '🚀'}
        </button>
      </div>
    </div>
  );
}
