import React, { useState, useRef, useEffect, useCallback } from 'react';
import { playVoiceRecognized, playClick } from '../services/sound-service';
import './VoiceControl.css';

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export default function VoiceControl({ onVoiceCommand, disabled }) {
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [supported, setSupported] = useState(true);
  const [pulseAnim, setPulseAnim] = useState(false);
  const recognitionRef = useRef(null);

  useEffect(() => {
    if (!SpeechRecognition) {
      setSupported(false);
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onresult = (event) => {
      let interim = '';
      let final = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const text = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          final += text;
        } else {
          interim += text;
        }
      }

      setTranscript(interim || final);

      if (final) {
        playVoiceRecognized();
        setPulseAnim(true);
        setTimeout(() => setPulseAnim(false), 400);
        if (onVoiceCommand) {
          onVoiceCommand(final.trim());
        }
        setListening(false);
      }
    };

    recognition.onerror = (event) => {
      console.warn('Speech recognition error:', event.error);
      if (event.error !== 'no-speech') {
        setListening(false);
      }
    };

    recognition.onend = () => {
      setListening(false);
    };

    recognitionRef.current = recognition;

    return () => {
      try { recognition.abort(); } catch { /* ignore */ }
    };
  }, [onVoiceCommand]);

  const toggleListening = useCallback(() => {
    if (!recognitionRef.current) return;

    if (listening) {
      recognitionRef.current.abort();
      setListening(false);
    } else {
      playClick();
      setTranscript('');
      recognitionRef.current.start();
      setListening(true);
    }
  }, [listening]);

  if (!supported) {
    return (
      <div className="voice-control voice-unsupported">
        <span className="voice-icon">🎙️</span>
        <span className="voice-label">Voice not supported in this browser</span>
      </div>
    );
  }

  return (
    <div className={`voice-control ${listening ? 'voice-active' : ''} ${pulseAnim ? 'voice-pulse' : ''}`}>
      <button
        className={`voice-btn ${listening ? 'voice-btn-listening' : ''}`}
        onClick={toggleListening}
        disabled={disabled}
        title={listening ? 'Stop listening' : 'Push to talk'}
      >
        {listening ? '🔴' : '🎙️'}
      </button>
      <div className="voice-info">
        {listening ? (
          <>
            <span className="voice-status">Listening...</span>
            {transcript && <span className="voice-transcript">{transcript}</span>}
          </>
        ) : (
          <span className="voice-label">Push to Talk</span>
        )}
      </div>
      {listening && (
        <div className="voice-waves">
          <span className="wave"></span>
          <span className="wave"></span>
          <span className="wave"></span>
        </div>
      )}
    </div>
  );
}
