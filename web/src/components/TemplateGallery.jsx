import React, { useState } from 'react';
import { playClick } from '../services/sound-service';
import './TemplateGallery.css';

// ─── Pre-built program templates ────────────────────────────

const TEMPLATES = [
  {
    id: 'tmpl_dance',
    name: 'Dance Party 💃',
    description: 'A fun dance routine with spins, wiggles, and music!',
    category: 'fun',
    icon: '💃',
    difficulty: 'Easy',
    blocks: [
      { type: 'display_image', image: 'happy' },
      { type: 'play_tone', frequency: 523, duration: 0.3 },
      { type: 'repeat', times: 3, do: [
        { type: 'move_forward', speed: 60, duration: 0.5 },
        { type: 'turn_right', speed: 80, angle: 120 },
        { type: 'play_tone', frequency: 659, duration: 0.2 },
        { type: 'move_backward', speed: 60, duration: 0.5 },
        { type: 'turn_left', speed: 80, angle: 120 },
        { type: 'play_tone', frequency: 784, duration: 0.2 },
      ]},
      { type: 'turn_right', speed: 40, angle: 360 },
      { type: 'display_text', text: 'Ta-da!' },
      { type: 'play_tone', frequency: 1047, duration: 0.5 },
    ],
  },
  {
    id: 'tmpl_explorer',
    name: 'Room Explorer 🗺️',
    description: 'Roams around avoiding walls using the distance sensor.',
    category: 'sensors',
    icon: '🗺️',
    difficulty: 'Medium',
    blocks: [
      { type: 'display_text', text: 'Exploring!' },
      { type: 'repeat_forever', do: [
        { type: 'if_obstacle', distance: 25, then: [
          { type: 'stop' },
          { type: 'play_tone', frequency: 440, duration: 0.15 },
          { type: 'move_backward', speed: 40, duration: 0.5 },
          { type: 'turn_right', speed: 50, angle: 90 },
        ], else: [
          { type: 'move_forward', speed: 50, duration: 0.3 },
        ]},
      ]},
    ],
  },
  {
    id: 'tmpl_line',
    name: 'Line Follower ➖',
    description: 'Follows a black line on the floor using line sensors.',
    category: 'sensors',
    icon: '➖',
    difficulty: 'Medium',
    blocks: [
      { type: 'display_text', text: 'Following line...' },
      { type: 'repeat_forever', do: [
        { type: 'if_line', sensor: 'left', color: 'black', then: [
          { type: 'set_speed', left: 20, right: 50 },
        ], else: [
          { type: 'if_line', sensor: 'right', color: 'black', then: [
            { type: 'set_speed', left: 50, right: 20 },
          ], else: [
            { type: 'set_speed', left: 40, right: 40 },
          ]},
        ]},
        { type: 'wait', duration: 0.05 },
      ]},
    ],
  },
  {
    id: 'tmpl_guard',
    name: 'Guard Robot 🛡️',
    description: 'Watches for intruders and sounds the alarm!',
    category: 'sensors',
    icon: '🛡️',
    difficulty: 'Easy',
    blocks: [
      { type: 'display_text', text: 'Guarding...' },
      { type: 'repeat_forever', do: [
        { type: 'if_obstacle', distance: 30, then: [
          { type: 'display_image', image: 'star' },
          { type: 'play_tone', frequency: 880, duration: 0.3 },
          { type: 'wait', duration: 0.2 },
          { type: 'play_tone', frequency: 660, duration: 0.3 },
          { type: 'display_text', text: 'INTRUDER!' },
          { type: 'wait', duration: 1 },
        ], else: [
          { type: 'wait', duration: 0.3 },
        ]},
      ]},
    ],
  },
  {
    id: 'tmpl_square',
    name: 'Draw a Square ⬜',
    description: 'Drives in a perfect square pattern.',
    category: 'movement',
    icon: '⬜',
    difficulty: 'Easy',
    blocks: [
      { type: 'display_text', text: 'Square!' },
      { type: 'repeat', times: 4, do: [
        { type: 'move_forward', speed: 50, duration: 1.5 },
        { type: 'turn_right', speed: 40, angle: 90 },
      ]},
      { type: 'display_text', text: 'Done!' },
    ],
  },
  {
    id: 'tmpl_zigzag',
    name: 'Zigzag Runner ⚡',
    description: 'Drives in a zigzag pattern across the floor.',
    category: 'movement',
    icon: '⚡',
    difficulty: 'Easy',
    blocks: [
      { type: 'repeat', times: 5, do: [
        { type: 'move_forward', speed: 50, duration: 0.8 },
        { type: 'turn_right', speed: 50, angle: 60 },
        { type: 'move_forward', speed: 50, duration: 0.8 },
        { type: 'turn_left', speed: 50, angle: 60 },
      ]},
      { type: 'stop' },
    ],
  },
  {
    id: 'tmpl_lightshow',
    name: 'Light Show 🌈',
    description: 'A dazzling sequence of displays, sounds, and movements!',
    category: 'fun',
    icon: '🌈',
    difficulty: 'Easy',
    blocks: [
      { type: 'repeat', times: 3, do: [
        { type: 'display_image', image: 'heart' },
        { type: 'play_tone', frequency: 523, duration: 0.3 },
        { type: 'turn_left', speed: 30, angle: 60 },
        { type: 'display_image', image: 'star' },
        { type: 'play_tone', frequency: 659, duration: 0.3 },
        { type: 'turn_right', speed: 30, angle: 60 },
        { type: 'display_image', image: 'happy' },
        { type: 'play_tone', frequency: 784, duration: 0.3 },
      ]},
      { type: 'display_text', text: '✨ WOW! ✨' },
      { type: 'play_tone', frequency: 1047, duration: 0.8 },
    ],
  },
  {
    id: 'tmpl_music',
    name: 'Music Box 🎵',
    description: 'Plays "Twinkle Twinkle Little Star" on the robot!',
    category: 'fun',
    icon: '🎵',
    difficulty: 'Easy',
    blocks: [
      { type: 'display_text', text: '🎵 Music!' },
      // Twinkle twinkle
      { type: 'play_tone', frequency: 262, duration: 0.4 },
      { type: 'play_tone', frequency: 262, duration: 0.4 },
      { type: 'play_tone', frequency: 392, duration: 0.4 },
      { type: 'play_tone', frequency: 392, duration: 0.4 },
      { type: 'play_tone', frequency: 440, duration: 0.4 },
      { type: 'play_tone', frequency: 440, duration: 0.4 },
      { type: 'play_tone', frequency: 392, duration: 0.8 },
      { type: 'wait', duration: 0.2 },
      { type: 'play_tone', frequency: 349, duration: 0.4 },
      { type: 'play_tone', frequency: 349, duration: 0.4 },
      { type: 'play_tone', frequency: 330, duration: 0.4 },
      { type: 'play_tone', frequency: 330, duration: 0.4 },
      { type: 'play_tone', frequency: 294, duration: 0.4 },
      { type: 'play_tone', frequency: 294, duration: 0.4 },
      { type: 'play_tone', frequency: 262, duration: 0.8 },
      { type: 'display_image', image: 'star' },
    ],
  },
  {
    id: 'tmpl_greeting',
    name: 'Greeting Bot 👋',
    description: 'Robot waves and introduces itself when it sees something!',
    category: 'fun',
    icon: '👋',
    difficulty: 'Medium',
    blocks: [
      { type: 'display_text', text: 'Hi there!' },
      { type: 'repeat_forever', do: [
        { type: 'if_obstacle', distance: 40, then: [
          { type: 'display_image', image: 'happy' },
          { type: 'play_tone', frequency: 523, duration: 0.2 },
          { type: 'play_tone', frequency: 659, duration: 0.2 },
          { type: 'display_text', text: 'Hello!' },
          { type: 'turn_left', speed: 30, angle: 30 },
          { type: 'turn_right', speed: 30, angle: 60 },
          { type: 'turn_left', speed: 30, angle: 30 },
          { type: 'wait', duration: 2 },
        ], else: [
          { type: 'display_text', text: '...' },
          { type: 'wait', duration: 0.5 },
        ]},
      ]},
    ],
  },
  {
    id: 'tmpl_servo_scan',
    name: 'Arm Scanner 🦾',
    description: 'Moves a configured servo through positions like a scanning arm.',
    category: 'movement',
    icon: '🦾',
    difficulty: 'Medium',
    requires: { types: ['servo'] },
    blocks: [
      { type: 'display_text', text: 'Scanning...' },
      { type: 'repeat', times: 3, do: [
        { type: 'servo', port: 'S1', angle: 20 },
        { type: 'wait', duration: 0.4 },
        { type: 'servo', port: 'S1', angle: 90 },
        { type: 'wait', duration: 0.4 },
        { type: 'servo', port: 'S1', angle: 160 },
        { type: 'wait', duration: 0.4 },
      ]},
      { type: 'display_text', text: 'Done' },
    ],
  },
  {
    id: 'tmpl_claw_cycle',
    name: 'Grabber Cycle ✋',
    description: 'Opens and closes a configured DC motor grabber in a safe cycle.',
    category: 'movement',
    icon: '✋',
    difficulty: 'Medium',
    requires: { types: ['dc_motor'] },
    blocks: [
      { type: 'display_text', text: 'Grabber' },
      { type: 'repeat', times: 3, do: [
        { type: 'dc_motor', port: 'M3', speed: 60, duration: 0.6 },
        { type: 'wait', duration: 0.5 },
        { type: 'dc_motor', port: 'M3', speed: -60, duration: 0.6 },
        { type: 'wait', duration: 0.5 },
      ]},
      { type: 'stop' },
    ],
  },
];

const TEMPLATE_CATEGORIES = [
  { key: 'all', label: '📚 All' },
  { key: 'fun', label: '🎉 Fun' },
  { key: 'movement', label: '🚗 Movement' },
  { key: 'sensors', label: '📡 Sensors' },
];

function isTemplateAvailable(template, robotConfig) {
  if (!template.requires?.types?.length) return true;
  const configuredTypes = new Set((robotConfig?.additions || []).map(a => a.type));
  return template.requires.types.every(t => configuredTypes.has(t));
}

function resolveTemplatePorts(template, robotConfig) {
  const additions = robotConfig?.additions || [];
  return template.blocks.map((block) => {
    if (block.type === 'servo' && block.port === 'S1') {
      const servo = additions.find(a => a.type === 'servo');
      if (servo?.port) return { ...block, port: servo.port };
    }
    if (block.type === 'dc_motor' && block.port === 'M3') {
      const motor = additions.find(a => a.type === 'dc_motor');
      if (motor?.port) return { ...block, port: motor.port };
    }
    return block;
  });
}

export default function TemplateGallery({ onLoadTemplate, robotConfig }) {
  const [category, setCategory] = useState('all');
  const [selectedId, setSelectedId] = useState(null);

  const availableTemplates = TEMPLATES.filter(t => isTemplateAvailable(t, robotConfig));
  const filtered = category === 'all'
    ? availableTemplates
    : availableTemplates.filter(t => t.category === category);

  const selected = availableTemplates.find(t => t.id === selectedId);

  function handleLoad(template) {
    playClick();
    if (onLoadTemplate) {
      onLoadTemplate(resolveTemplatePorts(template, robotConfig), template.name);
    }
  }

  return (
    <div className="template-gallery">
      <div className="template-header">
        <h3>📚 Program Templates</h3>
        <span className="template-count">{availableTemplates.length} programs ready for this robot!</span>
      </div>

      <div className="template-categories">
        {TEMPLATE_CATEGORIES.map(cat => (
          <button
            key={cat.key}
            className={`tmpl-cat-btn ${category === cat.key ? 'tmpl-cat-active' : ''}`}
            onClick={() => setCategory(cat.key)}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {selected && (
        <div className="template-detail">
          <div className="template-detail-header">
            <span className="template-detail-icon">{selected.icon}</span>
            <div className="template-detail-info">
              <strong>{selected.name}</strong>
              <p>{selected.description}</p>
              <span className="template-difficulty">{selected.difficulty} · {selected.blocks.length} blocks</span>
            </div>
          </div>
          <div className="template-detail-actions">
            <button className="btn-primary" onClick={() => handleLoad(selected)}>
              ✨ Load This Program
            </button>
            <button className="btn-secondary btn-small" onClick={() => setSelectedId(null)}>
              Close
            </button>
          </div>
        </div>
      )}

      <div className="template-grid">
        {filtered.map(tmpl => (
          <button
            key={tmpl.id}
            className={`template-card ${selectedId === tmpl.id ? 'template-card-active' : ''}`}
            onClick={() => setSelectedId(tmpl.id)}
          >
            <span className="template-card-icon">{tmpl.icon}</span>
            <div className="template-card-info">
              <span className="template-card-name">{tmpl.name}</span>
              <span className="template-card-desc">{tmpl.description}</span>
              <span className="template-card-meta">{tmpl.difficulty} · {tmpl.blocks.length} blocks</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
