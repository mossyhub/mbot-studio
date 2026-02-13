/**
 * Sound Service — Web Audio API sound effects
 * No external files needed — generates all sounds programmatically.
 * Kid-friendly bleeps, bloops, and melodies.
 */

let audioCtx = null;

function getCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  // Resume if suspended (browser autoplay policy)
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function playTone(freq, duration = 0.15, type = 'sine', volume = 0.15) {
  if (isMuted()) return;
  try {
    const ctx = getCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);
  } catch { /* ignore audio errors silently */ }
}

function playSequence(notes, tempo = 120) {
  const beatDur = 60 / tempo;
  notes.forEach(([freq, beats, type], i) => {
    setTimeout(() => playTone(freq, beats * beatDur * 0.9, type || 'sine', 0.12), i * beatDur * 200);
  });
}

// ─── Public API ──────────────────────────────────────────────

/** Soft click for button interactions */
export function playClick() {
  playTone(800, 0.06, 'sine', 0.08);
}

/** Program sent to robot */
export function playProgramSent() {
  playSequence([
    [523, 0.5],     // C5
    [659, 0.5],     // E5
    [784, 0.8],     // G5
  ]);
}

/** Program completed successfully */
export function playSuccess() {
  playSequence([
    [523, 0.3],     // C5
    [659, 0.3],     // E5
    [784, 0.3],     // G5
    [1047, 0.6],    // C6
  ]);
}

/** Error / something went wrong */
export function playError() {
  playSequence([
    [300, 0.4, 'sawtooth'],
    [200, 0.6, 'sawtooth'],
  ]);
}

/** Achievement unlocked! Triumphant fanfare */
export function playAchievement() {
  playSequence([
    [523, 0.2],     // C5
    [659, 0.2],     // E5
    [784, 0.2],     // G5
    [1047, 0.3],    // C6
    [784, 0.15],    // G5
    [1047, 0.5],    // C6
  ]);
}

/** Challenge completed — star earned */
export function playStar() {
  playSequence([
    [880, 0.2],     // A5
    [1109, 0.2],    // C#6
    [1319, 0.4],    // E6
  ]);
}

/** Emergency stop */
export function playStop() {
  playTone(200, 0.3, 'square', 0.2);
}

/** Robot connected */
export function playConnect() {
  playSequence([
    [440, 0.15],    // A4
    [554, 0.15],    // C#5
    [659, 0.25],    // E5
  ]);
}

/** Robot disconnected */
export function playDisconnect() {
  playSequence([
    [659, 0.15],    // E5
    [554, 0.15],    // C#5
    [440, 0.3],     // A4
  ]);
}

/** Voice command recognized */
export function playVoiceRecognized() {
  playTone(1200, 0.1, 'sine', 0.1);
}

/** Countdown beep (for challenges) */
export function playCountdown() {
  playTone(600, 0.12, 'sine', 0.12);
}

/** Celebration — rapid ascending run */
export function playCelebration() {
  const notes = [523, 587, 659, 698, 784, 880, 988, 1047];
  notes.forEach((freq, i) => {
    setTimeout(() => playTone(freq, 0.12, 'sine', 0.1), i * 60);
  });
}

/** Check if audio is available */
export function isAudioAvailable() {
  return !!(window.AudioContext || window.webkitAudioContext);
}

/** Mute management */
let muted = false;
const originalPlayTone = playTone;

export function setMuted(m) {
  muted = m;
  localStorage.setItem('mbot-sound-muted', m ? '1' : '0');
}

export function isMuted() {
  if (muted) return true;
  const stored = localStorage.getItem('mbot-sound-muted');
  if (stored === '1') { muted = true; return true; }
  return false;
}
