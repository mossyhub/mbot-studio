import React, { useState } from 'react';
import './SoundScreenControls.css';

const AV_BUILD = 'mbot-av-control-v1';
const inRange = (value, min, max) => value !== '' && Number.isFinite(Number(value)) && Number(value) >= min && Number(value) <= max;

export default function SoundScreenControls({ status, connected, onCommand, onStop }) {
  const [text, setText] = useState('Hello!');
  const [size, setSize] = useState('16');
  const [frequency, setFrequency] = useState('440');
  const [duration, setDuration] = useState('0.5');
  const [sound, setSound] = useState('hello');
  const [volume, setVolume] = useState('30');
  const [frameText, setFrameText] = useState('Hello!\nReady?');
  const [interval, setInterval] = useState('0.5');
  const frames = frameText.split('\n');
  const validFrames = frameText.length > 0 && frames.length <= 12 && frames.every(frame => frame.length <= 128) && inRange(interval, 0.15, 2) && frames.length * Number(interval) <= 12;
  const supported = type => status?.build === AV_BUILD && Array.isArray(status.capabilities) && status.capabilities.includes(type);
  const available = type => connected && supported(type);

  return (
    <section id={AV_BUILD} className="sound-screen-controls" aria-labelledby="av-heading">
      <h3 id="av-heading">Sound &amp; Screen</h3>
      <p className="av-help">{!connected ? 'Offline — connect the robot and server.' : status?.build !== AV_BUILD ? 'Unsupported firmware — requires mbot-av-control-v1.' : 'Explicit controls only. Check Activity Log for device execution.'}</p>
      <fieldset disabled={!available('display_text')}>
        <legend>Screen text{!supported('display_text') ? ' — unsupported' : ''}</legend>
        <label htmlFor="av-text">Screen text</label>
        <input id="av-text" type="text" maxLength={128} value={text} onChange={e => setText(e.target.value)} />
        <div className="av-row">
          <label htmlFor="av-size">Text size (8–32)
            <input id="av-size" type="number" min="8" max="32" step="1" value={size} onChange={e => setSize(e.target.value)} />
          </label>
          <button type="button" className="btn-small btn-secondary" disabled={!inRange(size, 8, 32) || text.length > 128} onClick={() => onCommand({ type: 'display_text', text, size: Number(size) })}>Show text</button>
        </div>
      </fieldset>
      <fieldset disabled={!available('play_tone')}>
        <legend>Tone{!supported('play_tone') ? ' — unsupported' : ''}</legend>
        <div className="av-row">
          <label htmlFor="av-frequency">Frequency (100–2000 Hz)
            <input id="av-frequency" type="number" min="100" max="2000" step="1" value={frequency} onChange={e => setFrequency(e.target.value)} />
          </label>
          <label htmlFor="av-duration">Tone duration (0–2 s)
            <input id="av-duration" type="number" min="0" max="2" step="0.1" value={duration} onChange={e => setDuration(e.target.value)} />
          </label>
        </div>
        <button type="button" className="btn-small btn-secondary" disabled={!inRange(frequency, 100, 2000) || !inRange(duration, 0, 2)} onClick={() => onCommand({ type: 'play_tone', frequency: Number(frequency), duration: Number(duration) })}>Play tone</button>
      </fieldset>
      <fieldset disabled={!available('play_sound')}>
        <legend>Preset sound{!supported('play_sound') ? ' — unsupported' : ''}</legend>
        <label htmlFor="av-sound">Sound preset</label>
        <div className="av-row">
          <select id="av-sound" value={sound} onChange={e => setSound(e.target.value)}>
            {['hello', 'beeps', 'laugh', 'score'].map(name => <option key={name} value={name}>{name}</option>)}
          </select>
          <button type="button" className="btn-small btn-secondary" onClick={() => onCommand({ type: 'play_sound', sound })}>Play preset</button>
        </div>
      </fieldset>
      <fieldset disabled={!available('set_volume')}>
        <legend>Audio level{!supported('set_volume') ? ' — unsupported' : ''}</legend>
        <div className="av-row">
          <label htmlFor="av-volume">Volume (0–60)
            <input id="av-volume" type="number" min="0" max="60" step="1" value={volume} onChange={e => setVolume(e.target.value)} />
          </label>
          <button type="button" className="btn-small btn-secondary" disabled={!inRange(volume, 0, 60) || !Number.isInteger(Number(volume))} onClick={() => onCommand({ type: 'set_volume', volume: Number(volume) })}>Set volume</button>
        </div>
      </fieldset>
      <fieldset disabled={!available('display_animation')}>
        <legend>Text-frame animation{!supported('display_animation') ? ' — unsupported' : ''}</legend>
        <label htmlFor="av-frames">Animation frames</label>
        <textarea id="av-frames" rows="4" value={frameText} onChange={e => setFrameText(e.target.value)} aria-describedby="av-frame-help" />
        <p id="av-frame-help" className="av-help">One frame per line: 1–12 frames, up to 128 characters each. Blank lines clear the screen. Maximum total: 12 seconds.</p>
        <label htmlFor="av-interval">Frame interval (0.15–2 s)
          <input id="av-interval" type="number" min="0.15" max="2" step="0.05" value={interval} onChange={e => setInterval(e.target.value)} />
        </label>
        {!validFrames && <p className="av-help" role="status">Use 1–12 frames of up to 128 characters, a 0.15–2 s interval, and at most 12 s total.</p>}
        <button type="button" className="btn-small btn-secondary" disabled={!validFrames} onClick={() => onCommand({ type: 'display_animation', frames, interval: Number(interval) })}>Play text frames</button>
      </fieldset>
      <button type="button" className="btn-small btn-danger" disabled={!available('stop_sound')} onClick={onStop}>Stop output</button>
      <p className="av-help">Emergency stop clears queued commands and stops sound and motors. A native tone may take up to 2 seconds to return.</p>
    </section>
  );
}
