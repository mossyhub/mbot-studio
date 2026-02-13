import React, { useState, useEffect } from 'react';
import { playStar, playCelebration } from '../services/sound-service';
import { tryEarnBadge, incrementStat, getStats } from '../services/achievements';
import './Challenges.css';

// ─── Challenge Definitions ──────────────────────────────────

const CHALLENGES = [
  // === Beginner: Movement ===
  {
    id: 'ch_forward',
    title: 'First Steps',
    description: 'Make your robot drive forward for 2 seconds.',
    hint: 'Try saying "Go forward for 2 seconds"',
    category: 'beginner',
    icon: '🚗',
    stars: 1,
  },
  {
    id: 'ch_square',
    title: 'Square Dance',
    description: 'Drive your robot in a square pattern and return to the start.',
    hint: 'You need 4 forward moves and 4 right turns of 90°',
    category: 'beginner',
    icon: '⬜',
    stars: 2,
  },
  {
    id: 'ch_spiral',
    title: 'Spiral Out',
    description: 'Make the robot drive in a growing spiral pattern.',
    hint: 'Use a loop where the forward distance increases each time',
    category: 'beginner',
    icon: '🌀',
    stars: 2,
  },
  {
    id: 'ch_figure8',
    title: 'Figure Eight',
    description: 'Drive in a figure-8 pattern using turns and forward moves.',
    hint: 'Try a left circle, then a right circle!',
    category: 'beginner',
    icon: '♾️',
    stars: 3,
  },

  // === Intermediate: Sensors ===
  {
    id: 'ch_obstacle',
    title: 'Wall Avoider',
    description: 'Drive forever but turn when you get close to a wall.',
    hint: 'Use "repeat forever" with "if obstacle closer than 20cm"',
    category: 'intermediate',
    icon: '🧱',
    stars: 2,
  },
  {
    id: 'ch_line_follow',
    title: 'Line Follower',
    description: 'Follow a black line on the floor without losing it.',
    hint: 'Check the line sensor in a loop and adjust steering',
    category: 'intermediate',
    icon: '➖',
    stars: 3,
  },
  {
    id: 'ch_guard',
    title: 'Guard Robot',
    description: 'Make a guard that watches for intruders (movement within 30cm) and sounds an alarm.',
    hint: 'Loop forever, check distance, play a tone if something is close',
    category: 'intermediate',
    icon: '🛡️',
    stars: 2,
  },
  {
    id: 'ch_color_sort',
    title: 'Color Reporter',
    description: 'Drive slowly and display a message when it sees red, green, or blue.',
    hint: 'Use if_color blocks for each color in a loop',
    category: 'intermediate',
    icon: '🎨',
    stars: 3,
  },

  // === Creative ===
  {
    id: 'ch_dance',
    title: 'Dance Party',
    description: 'Create a dance routine with at least 5 different moves and music!',
    hint: 'Mix forward, backward, turns, and play_tone blocks',
    category: 'creative',
    icon: '💃',
    stars: 2,
  },
  {
    id: 'ch_song',
    title: 'Music Robot',
    description: 'Play a recognizable melody using play_tone blocks.',
    hint: 'Use different frequencies and durations. A4=440Hz, B4=494Hz, C5=523Hz...',
    category: 'creative',
    icon: '🎵',
    stars: 3,
  },
  {
    id: 'ch_emotions',
    title: 'Emotional Robot',
    description: 'Make the robot express 3 different emotions: happy, sad, and excited.',
    hint: 'Show faces with display_image, sounds with play_tone, and movement!',
    category: 'creative',
    icon: '🎭',
    stars: 3,
  },
  {
    id: 'ch_story',
    title: 'Story Teller',
    description: 'Program a story where the robot acts out each scene with movement and display.',
    hint: 'Use display_text for narration, movements for actions, waits between scenes',
    category: 'creative',
    icon: '📖',
    stars: 3,
  },

  // === Advanced ===
  {
    id: 'ch_maze',
    title: 'Maze Runner',
    description: 'Navigate a maze using the distance sensor to detect and avoid walls.',
    hint: 'Check front, turn to find open paths, keep moving forward when clear',
    category: 'advanced',
    icon: '🏁',
    stars: 3,
  },
  {
    id: 'ch_timer',
    title: 'Speed Run',
    description: 'Drive forward exactly 1 meter as fast as possible (display elapsed time).',
    hint: 'Use set_speed for control, display_text to show timing',
    category: 'advanced',
    icon: '⏱️',
    stars: 3,
  },
  {
    id: 'ch_clap',
    title: 'Clap Control',
    description: 'Make the robot respond to loud sounds — clap to start, clap to stop!',
    hint: 'Check loudness sensor in a loop, toggle movement on/off',
    category: 'advanced',
    icon: '👏',
    stars: 3,
  },
  {
    id: 'ch_explorer',
    title: 'Room Explorer',
    description: 'Map an area by driving to each wall, turning, and covering the whole room.',
    hint: 'Drive until obstacle, turn a random-ish amount, repeat forever',
    category: 'advanced',
    icon: '🗺️',
    stars: 3,
  },
];

const CATEGORIES = [
  { key: 'all', label: '🎯 All' },
  { key: 'beginner', label: '🟢 Beginner' },
  { key: 'intermediate', label: '🟡 Intermediate' },
  { key: 'creative', label: '🎨 Creative' },
  { key: 'advanced', label: '🔴 Advanced' },
];

const CHALLENGE_STORAGE_KEY_PREFIX = 'mbot-studio-challenges';

function getChallengeStorageKey(profileId) {
  return `${CHALLENGE_STORAGE_KEY_PREFIX}:${profileId || 'default'}`;
}

function loadChallengeState(profileId) {
  try { return JSON.parse(localStorage.getItem(getChallengeStorageKey(profileId)) || '{}'); }
  catch { return {}; }
}

function saveChallengeState(profileId, state) {
  localStorage.setItem(getChallengeStorageKey(profileId), JSON.stringify(state));
}

export default function Challenges({ currentProfileId, onLoadProgram, onCelebration }) {
  const [category, setCategory] = useState('all');
  const [completed, setCompleted] = useState(() => loadChallengeState(currentProfileId));
  const [activeChallenge, setActiveChallenge] = useState(null);
  const [showHint, setShowHint] = useState(false);

  useEffect(() => {
    setCompleted(loadChallengeState(currentProfileId));
    setActiveChallenge(null);
    setShowHint(false);
  }, [currentProfileId]);

  const filteredChallenges = category === 'all'
    ? CHALLENGES
    : CHALLENGES.filter(c => c.category === category);

  const totalStars = Object.values(completed).reduce((s, c) => s + (c.stars || 0), 0);
  const totalCompleted = Object.keys(completed).length;

  function handleComplete(challenge) {
    const state = loadChallengeState(currentProfileId);
    if (state[challenge.id]) return; // Already completed

    state[challenge.id] = { stars: challenge.stars, completedAt: Date.now() };
    saveChallengeState(currentProfileId, state);
    setCompleted({ ...state });

    // Play sounds
    playStar();
    setTimeout(() => playCelebration(), 300);

    // Increment achievement stats
    incrementStat('challenges_completed');
    incrementStat('stars_earned', challenge.stars);

    // Check challenge achievements
    const newBadges = [];
    const b1 = tryEarnBadge('first_challenge');
    if (b1) newBadges.push(b1);

    const stats = getStats();
    if ((stats.stars_earned || 0) >= 3) {
      const b = tryEarnBadge('three_stars');
      if (b) newBadges.push(b);
    }
    if ((stats.stars_earned || 0) >= 10) {
      const b = tryEarnBadge('ten_stars');
      if (b) newBadges.push(b);
    }

    // Check if all beginner complete
    const beginnerIds = CHALLENGES.filter(c => c.category === 'beginner').map(c => c.id);
    if (beginnerIds.every(id => state[id])) {
      const b = tryEarnBadge('all_beginner');
      if (b) newBadges.push(b);
    }

    if (newBadges.length && onCelebration) {
      newBadges.forEach(b => onCelebration(b));
    }

    setActiveChallenge(null);
  }

  return (
    <div className="challenges-panel">
      {/* Header */}
      <div className="challenges-header">
        <div className="challenges-header-left">
          <h2>🎯 Challenges</h2>
          <span className="challenges-progress">
            {totalCompleted}/{CHALLENGES.length} completed
          </span>
        </div>
        <div className="challenges-stars-total">
          ⭐ {totalStars} stars
        </div>
      </div>

      {/* Category tabs */}
      <div className="challenges-categories">
        {CATEGORIES.map(cat => (
          <button
            key={cat.key}
            className={`ch-cat-btn ${category === cat.key ? 'ch-cat-active' : ''}`}
            onClick={() => setCategory(cat.key)}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {/* Active challenge detail */}
      {activeChallenge && (
        <div className="challenge-detail">
          <div className="challenge-detail-header">
            <span className="challenge-detail-icon">{activeChallenge.icon}</span>
            <div className="challenge-detail-info">
              <h3>{activeChallenge.title}</h3>
              <p>{activeChallenge.description}</p>
            </div>
            <button className="btn-small btn-secondary" onClick={() => { setActiveChallenge(null); setShowHint(false); }}>✕</button>
          </div>

          <div className="challenge-detail-stars">
            {Array.from({ length: activeChallenge.stars }).map((_, i) => (
              <span key={i} className="star-icon">⭐</span>
            ))}
            <span className="star-label">{activeChallenge.stars} star{activeChallenge.stars > 1 ? 's' : ''}</span>
          </div>

          {showHint ? (
            <div className="challenge-hint">
              <span className="hint-icon">💡</span> {activeChallenge.hint}
            </div>
          ) : (
            <button className="btn-small btn-secondary hint-btn" onClick={() => setShowHint(true)}>
              💡 Show Hint
            </button>
          )}

          <div className="challenge-actions">
            <button className="btn-primary" onClick={() => {
              if (onLoadProgram) onLoadProgram(activeChallenge);
            }}>
              🧩 Start Programming
            </button>
            {!completed[activeChallenge.id] && (
              <button className="btn-success" onClick={() => handleComplete(activeChallenge)}>
                ✅ I Did It!
              </button>
            )}
            {completed[activeChallenge.id] && (
              <span className="challenge-done-label">✅ Completed!</span>
            )}
          </div>
        </div>
      )}

      {/* Challenge grid */}
      <div className="challenges-grid">
        {filteredChallenges.map(ch => {
          const done = !!completed[ch.id];
          return (
            <button
              key={ch.id}
              className={`challenge-card ${done ? 'done' : ''} ${activeChallenge?.id === ch.id ? 'active' : ''}`}
              onClick={() => { setActiveChallenge(ch); setShowHint(false); }}
            >
              <div className="challenge-card-icon">{ch.icon}</div>
              <div className="challenge-card-info">
                <div className="challenge-card-title">{ch.title}</div>
                <div className="challenge-card-stars">
                  {Array.from({ length: ch.stars }).map((_, i) => (
                    <span key={i}>{done ? '⭐' : '☆'}</span>
                  ))}
                </div>
              </div>
              {done && <span className="challenge-check">✅</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
