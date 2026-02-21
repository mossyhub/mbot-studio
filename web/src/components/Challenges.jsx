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
    prompt: 'Make the robot drive forward for 2 seconds',
  },
  {
    id: 'ch_square',
    title: 'Square Dance',
    description: 'Drive your robot in a square pattern and return to the start.',
    hint: 'You need 4 forward moves and 4 right turns of 90°',
    category: 'beginner',
    icon: '⬜',
    stars: 2,
    prompt: 'Drive in a square: repeat 4 times forward 2 seconds then turn right 90 degrees',
  },
  {
    id: 'ch_spiral',
    title: 'Spiral Out',
    description: 'Make the robot drive in a growing spiral pattern.',
    hint: 'Use a loop where the forward distance increases each time',
    category: 'beginner',
    icon: '🌀',
    stars: 2,
    prompt: 'Drive in a spiral: forward 1 second turn right, forward 2 seconds turn right, forward 3 seconds turn right, forward 4 seconds turn right',
  },
  {
    id: 'ch_figure8',
    title: 'Figure Eight',
    description: 'Drive in a figure-8 pattern using turns and forward moves.',
    hint: 'Try a left circle, then a right circle!',
    category: 'beginner',
    icon: '♾️',
    stars: 3,
    prompt: 'Drive in a figure 8: turn left in a circle, then turn right in a circle',
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
    prompt: 'Repeat forever: if obstacle closer than 20cm turn right 90 degrees, else drive forward',
  },
  {
    id: 'ch_line_follow',
    title: 'Line Follower',
    description: 'Follow a black line on the floor without losing it.',
    hint: 'Check the line sensor in a loop and adjust steering',
    category: 'intermediate',
    icon: '➖',
    stars: 3,
    prompt: 'Follow a black line: repeat forever, if line detected drive forward, else turn right slowly to find the line',
  },
  {
    id: 'ch_guard',
    title: 'Guard Robot',
    description: 'Make a guard that watches for intruders (movement within 30cm) and sounds an alarm.',
    hint: 'Loop forever, check distance, play a tone if something is close',
    category: 'intermediate',
    icon: '🛡️',
    stars: 2,
    prompt: 'Guard robot: repeat forever, if obstacle closer than 30cm play a loud alarm tone and flash red LEDs, else show green LEDs',
  },
  {
    id: 'ch_color_sort',
    title: 'Color Reporter',
    description: 'Drive slowly and display a message when it sees red, green, or blue.',
    hint: 'Use if_color blocks for each color in a loop',
    category: 'intermediate',
    icon: '🎨',
    stars: 3,
    prompt: 'Drive forward slowly in a loop. If color sensor sees red, display "RED!" and set LEDs red. If green, display "GREEN!" and set LEDs green. If blue, display "BLUE!" and set LEDs blue.',
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
    prompt: 'Create a fun dance: forward, spin right, backward, spin left, beep, flash LEDs different colors between each move',
  },
  {
    id: 'ch_song',
    title: 'Music Robot',
    description: 'Play a recognizable melody using play_tone blocks.',
    hint: 'Use different frequencies and durations. A4=440Hz, B4=494Hz, C5=523Hz...',
    category: 'creative',
    icon: '🎵',
    stars: 3,
    prompt: 'Play Twinkle Twinkle Little Star using play_tone blocks with the right musical notes',
  },
  {
    id: 'ch_emotions',
    title: 'Emotional Robot',
    description: 'Make the robot express 3 different emotions: happy, sad, and excited.',
    hint: 'Show faces with display_image, sounds with play_tone, and movement!',
    category: 'creative',
    icon: '🎭',
    stars: 3,
    prompt: 'Express 3 emotions: Happy (green LEDs, happy face, spin around, high tone), Sad (blue LEDs, sad face, slow backward, low tone), Excited (rainbow LEDs, fast spins, beeping)',
  },
  {
    id: 'ch_story',
    title: 'Story Teller',
    description: 'Program a story where the robot acts out each scene with movement and display.',
    hint: 'Use display_text for narration, movements for actions, waits between scenes',
    category: 'creative',
    icon: '📖',
    stars: 3,
    prompt: 'Tell a story in 4 scenes: Scene 1 display "Once upon a time..." and drive forward. Scene 2 display "A dragon appeared!" and flash red LEDs. Scene 3 display "The hero fought!" and spin. Scene 4 display "The end!" and play a victory melody.',
  },

  // === Hardware ===
  {
    id: 'ch_led_party',
    title: 'Light Show',
    description: 'Create a flashing LED light show with at least 3 different colors.',
    hint: 'Use set_led blocks with wait blocks between color changes. Try red, green, blue, purple!',
    category: 'creative',
    icon: '💡',
    stars: 1,
    prompt: 'Create a light show that cycles through red, green, blue, and purple LEDs with waits between each',
  },
  {
    id: 'ch_servo_wave',
    title: 'Robot Wave',
    description: 'Make the robot wave its arm up and down 3 times using a servo.',
    hint: 'Use a servo block with different angles in a repeat loop. Try 45° for up and 120° for down.',
    category: 'beginner',
    icon: '👋',
    stars: 2,
    prompt: 'Make the robot wave by moving servo S1 between 45 degrees (up) and 120 degrees (down) 3 times with waits',
  },
  {
    id: 'ch_claw_grab',
    title: 'Grab & Go',
    description: 'Drive forward, grab something with the claw motor, drive backward, then release.',
    hint: 'Drive forward, run DC motor forward to close claw, drive backward, run DC motor reverse to open.',
    category: 'intermediate',
    icon: '🤏',
    stars: 2,
    prompt: 'Drive forward for 2 seconds, close the claw by running DC motor M3 forward, drive backward for 2 seconds, then open the claw by running DC motor M3 in reverse',
  },
  {
    id: 'ch_counter',
    title: 'Lap Counter',
    description: 'Drive in a circle 5 times, counting and displaying the lap number each time.',
    hint: 'Use set_variable for counter, repeat 5 times, change_variable by 1 each lap, display_value to show it.',
    category: 'intermediate',
    icon: '🔢',
    stars: 2,
    prompt: 'Set a variable called lap to 0, then repeat 5 times: add 1 to lap, display the lap number on screen, drive in a small circle, then wait 1 second',
  },
  {
    id: 'ch_distance_display',
    title: 'Distance Dashboard',
    description: 'Show the live distance sensor reading on the screen while driving forward slowly.',
    hint: 'Use a repeat loop with display_value (distance sensor) and slow forward movement.',
    category: 'beginner',
    icon: '📏',
    stars: 1,
    prompt: 'Drive forward slowly while showing the distance sensor reading on the screen. Stop if something is closer than 10cm.',
  },
  {
    id: 'ch_mood_ring',
    title: 'Mood Ring Robot',
    description: 'Change LED color based on how close things are: green (far), yellow (medium), red (close).',
    hint: 'Use if_sensor_range blocks with distance sensor to set LEDs to different colors based on distance.',
    category: 'advanced',
    icon: '💎',
    stars: 3,
    prompt: 'Make the robot a mood ring: in a forever loop, if distance is greater than 50 set LEDs green, if between 20 and 50 set yellow, if less than 20 set red',
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
    prompt: 'Navigate a maze: repeat forever, if obstacle closer than 15cm turn right 90 degrees, else drive forward',
  },
  {
    id: 'ch_timer',
    title: 'Speed Run',
    description: 'Drive forward exactly 1 meter as fast as possible (display elapsed time).',
    hint: 'Use set_speed for control, display_text to show timing',
    category: 'advanced',
    icon: '⏱️',
    stars: 3,
    prompt: 'Drive forward at full speed for 3 seconds then stop and display "Done!" on screen',
  },
  {
    id: 'ch_clap',
    title: 'Clap Control',
    description: 'Make the robot respond to loud sounds — clap to start, clap to stop!',
    hint: 'Check loudness sensor in a loop, toggle movement on/off',
    category: 'advanced',
    icon: '👏',
    stars: 3,
    prompt: 'Repeat forever: wait until loudness is greater than 50, drive forward for 2 seconds, then stop and wait until loudness is greater than 50 again',
  },
  {
    id: 'ch_explorer',
    title: 'Room Explorer',
    description: 'Map an area by driving to each wall, turning, and covering the whole room.',
    hint: 'Drive until obstacle, turn a random-ish amount, repeat forever',
    category: 'advanced',
    icon: '🗺️',
    stars: 3,
    prompt: 'Explore the room: repeat forever, drive forward until obstacle is closer than 15cm, then turn right a random angle between 90 and 180 degrees',
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
