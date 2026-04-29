import React, { useEffect, useRef, useState } from 'react';
import './BlocklyEditor.css';

/**
 * Block palette — all blocks available to manually add
 */
const BLOCK_PALETTE = [
  {
    category: 'Movement',
    color: 'cat-movement',
    blocks: [
      { type: 'move_forward', speed: 50, duration: 2 },
      { type: 'move_backward', speed: 50, duration: 2 },
      { type: 'turn_left', speed: 50, angle: 90 },
      { type: 'turn_right', speed: 50, angle: 90 },
      { type: 'stop' },
      { type: 'set_speed', left: 50, right: 50 },
    ],
  },
  {
    category: 'Sensors',
    color: 'cat-sensor',
    blocks: [
      { type: 'if_obstacle', distance: 20, then: [], else: [] },
      { type: 'if_line', sensor: 'both', color: 'black', then: [], else: [] },
      { type: 'if_color', color: 'red', then: [], else: [] },
    ],
  },
  {
    category: 'Sound & Display',
    color: 'cat-sound',
    blocks: [
      { type: 'play_tone', frequency: 440, duration: 0.5 },
      { type: 'play_melody', melody: 'happy' },
      { type: 'display_text', text: 'Hello!' },
      { type: 'display_image', image: 'happy' },
      { type: 'say', text: 'Hello!' },
      { type: 'set_led', color: 'green' },
    ],
  },
  {
    category: 'Control',
    color: 'cat-control',
    blocks: [
      { type: 'wait', duration: 1 },
      { type: 'repeat', times: 3, do: [] },
      { type: 'repeat_forever', do: [] },
      { type: 'if_button', button: 'a', then: [] },
      { type: 'while_sensor', sensor: 'distance', operator: '>', value: 20, do: [] },
      { type: 'move_until', direction: 'forward', speed: 50, sensor: 'distance', operator: '<', value: 15 },
    ],
  },
  {
    category: 'Sensors+',
    color: 'cat-sensor',
    blocks: [
      { type: 'if_sensor_range', sensor: 'distance', min: 10, max: 30, then: [], else: [] },
      { type: 'display_value', sensor: 'distance', label: 'Distance' },
    ],
  },
  {
    category: 'Variables',
    color: 'cat-variable',
    blocks: [
      { type: 'set_variable', name: 'my_var', value: 0 },
      { type: 'set_variable', name: 'dist', source: 'distance' },
      { type: 'change_variable', name: 'my_var', by: 1 },
      { type: 'math_operation', result: 'answer', a: 'my_var', operator: '+', b: 10 },
    ],
  },
  {
    category: 'Hardware',
    color: 'cat-hardware',
    blocks: [
      { type: 'dc_motor', port: 'M3', speed: 50, duration: 1 },
      { type: 'servo', port: 'S1', angle: 90 },
    ],
  },
];

/**
 * Schema defining editable parameters per block type
 */
const BLOCK_PARAM_SCHEMA = {
  move_forward: [
    { key: 'speed', label: 'Speed', type: 'range', min: 0, max: 100, step: 5 },
    { key: 'duration', label: 'Duration (s)', type: 'number', min: 0.1, max: 30, step: 0.1 },
  ],
  move_backward: [
    { key: 'speed', label: 'Speed', type: 'range', min: 0, max: 100, step: 5 },
    { key: 'duration', label: 'Duration (s)', type: 'number', min: 0.1, max: 30, step: 0.1 },
  ],
  turn_left: [
    { key: 'speed', label: 'Speed', type: 'range', min: 0, max: 100, step: 5 },
    { key: 'angle', label: 'Angle (°)', type: 'number', min: 1, max: 360, step: 1 },
  ],
  turn_right: [
    { key: 'speed', label: 'Speed', type: 'range', min: 0, max: 100, step: 5 },
    { key: 'angle', label: 'Angle (°)', type: 'number', min: 1, max: 360, step: 1 },
  ],
  set_speed: [
    { key: 'left', label: 'Left Motor', type: 'range', min: -100, max: 100, step: 5 },
    { key: 'right', label: 'Right Motor', type: 'range', min: -100, max: 100, step: 5 },
  ],
  wait: [
    { key: 'duration', label: 'Seconds', type: 'number', min: 0.1, max: 60, step: 0.1 },
  ],
  repeat: [
    { key: 'times', label: 'Times', type: 'number', min: 1, max: 100, step: 1 },
  ],
  play_tone: [
    { key: 'frequency', label: 'Frequency (Hz)', type: 'number', min: 100, max: 2000, step: 10 },
    { key: 'duration', label: 'Duration (s)', type: 'number', min: 0.1, max: 5, step: 0.1 },
  ],
  play_melody: [
    { key: 'melody', label: 'Melody', type: 'select', options: ['happy', 'sad', 'excited', 'alert'] },
  ],
  display_text: [
    { key: 'text', label: 'Text', type: 'text' },
  ],
  display_image: [
    { key: 'image', label: 'Image', type: 'select', options: ['happy', 'sad', 'heart', 'star', 'arrow_up', 'arrow_down'] },
  ],
  say: [
    { key: 'text', label: 'Text', type: 'text' },
  ],
  if_obstacle: [
    { key: 'distance', label: 'Distance (cm)', type: 'number', min: 1, max: 200, step: 1 },
  ],
  if_color: [
    { key: 'color', label: 'Color', type: 'select', options: ['red', 'green', 'blue', 'yellow', 'white', 'black'] },
  ],
  if_line: [
    { key: 'sensor', label: 'Sensor', type: 'select', options: ['left', 'right', 'both'] },
    { key: 'color', label: 'Color', type: 'select', options: ['black', 'white'] },
  ],
  if_button: [
    { key: 'button', label: 'Button', type: 'select', options: ['a', 'b'] },
  ],
  while_sensor: [
    { key: 'sensor', label: 'Sensor', type: 'select', options: ['distance', 'line', 'brightness', 'loudness', 'angle', 'timer'] },
    { key: 'operator', label: 'Operator', type: 'select', options: ['>', '<', '>=', '<=', '==', 'between'] },
    { key: 'value', label: 'Value', type: 'number', min: 0, max: 400, step: 1 },
    { key: 'min', label: 'Min (between)', type: 'number', min: 0, max: 400, step: 1 },
    { key: 'max', label: 'Max (between)', type: 'number', min: 0, max: 400, step: 1 },
  ],
  move_until: [
    { key: 'direction', label: 'Direction', type: 'select', options: ['forward', 'backward'] },
    { key: 'speed', label: 'Speed', type: 'range', min: 10, max: 100, step: 5 },
    { key: 'sensor', label: 'Sensor', type: 'select', options: ['distance', 'line', 'brightness', 'loudness', 'angle'] },
    { key: 'operator', label: 'Operator', type: 'select', options: ['<', '>', '<=', '>=', 'between'] },
    { key: 'value', label: 'Value', type: 'number', min: 0, max: 400, step: 1 },
    { key: 'min', label: 'Min (between)', type: 'number', min: 0, max: 400, step: 1 },
    { key: 'max', label: 'Max (between)', type: 'number', min: 0, max: 400, step: 1 },
  ],
  if_sensor_range: [
    { key: 'sensor', label: 'Sensor', type: 'select', options: ['distance', 'line', 'brightness', 'loudness', 'angle'] },
    { key: 'min', label: 'Min', type: 'number', min: 0, max: 400, step: 1 },
    { key: 'max', label: 'Max', type: 'number', min: 0, max: 400, step: 1 },
  ],
  display_value: [
    { key: 'sensor', label: 'Sensor', type: 'select', options: ['distance', 'line', 'brightness', 'loudness', 'angle'] },
    { key: 'label', label: 'Label', type: 'text' },
  ],
  set_variable: [
    { key: 'name', label: 'Variable Name', type: 'text' },
    { key: 'source', label: 'From Sensor', type: 'select', options: ['number', 'distance', 'line', 'brightness', 'loudness', 'angle', 'timer'] },
    { key: 'value', label: 'Value (if number)', type: 'number', min: -999, max: 999, step: 1 },
  ],
  set_led: [
    { key: 'color', label: 'Color', type: 'select', options: ['red', 'green', 'blue', 'yellow', 'purple', 'white', 'off'] },
  ],
  change_variable: [
    { key: 'name', label: 'Variable Name', type: 'text' },
    { key: 'by', label: 'Change By', type: 'number', min: -999, max: 999, step: 1 },
  ],
  math_operation: [
    { key: 'result', label: 'Store In', type: 'text' },
    { key: 'a', label: 'A (name or number)', type: 'text' },
    { key: 'operator', label: 'Operator', type: 'select', options: ['+', '-', '*', '/'] },
    { key: 'b', label: 'B (name or number)', type: 'text' },
  ],
  dc_motor: [
    { key: 'port', label: 'Port', type: 'select', options: ['M1', 'M2', 'M3', 'M4'] },
    { key: 'speed', label: 'Speed', type: 'range', min: -100, max: 100, step: 5 },
    { key: 'duration', label: 'Duration (s)', type: 'number', min: 0.1, max: 30, step: 0.1 },
  ],
  servo: [
    { key: 'port', label: 'Port', type: 'select', options: ['S1', 'S2', 'S3', 'S4'] },
    { key: 'angle', label: 'Angle (°)', type: 'number', min: 0, max: 180, step: 1 },
  ],
};

/**
 * Visual block representation of the program.
 * Shows AI-generated blocks in a colorful, interactive display.
 * 
 * Instead of using Blockly's complex XML workspace (which is hard for young kids),
 * we render a simplified "block stack" view that's more intuitive.
 * The blocks can be reordered, deleted, and new ones added.
 */
export default function BlocklyEditor({ blocks, onBlocksChange, robotConfig }) {
  const [dragIndex, setDragIndex] = useState(null);
  const [dragOverIndex, setDragOverIndex] = useState(null);
  const [showPalette, setShowPalette] = useState(false);
  const [editingIndex, setEditingIndex] = useState(null);
  const [paletteCategory, setPaletteCategory] = useState(null);

  const handleDragStart = (index) => {
    setDragIndex(index);
  };

  const handleDragOver = (e, index) => {
    e.preventDefault();
    setDragOverIndex(index);
  };

  const handleDrop = (index) => {
    if (dragIndex === null || dragIndex === index) {
      setDragIndex(null);
      setDragOverIndex(null);
      return;
    }

    const newBlocks = [...blocks];
    const [removed] = newBlocks.splice(dragIndex, 1);
    newBlocks.splice(index, 0, removed);
    onBlocksChange(newBlocks);
    setDragIndex(null);
    setDragOverIndex(null);
  };

  const handleDelete = (index) => {
    const newBlocks = blocks.filter((_, i) => i !== index);
    onBlocksChange(newBlocks);
    if (editingIndex === index) setEditingIndex(null);
  };

  const handleClearAll = () => {
    if (blocks.length === 0) return;
    if (!window.confirm('Remove all blocks? You can undo this.')) return;
    onBlocksChange([]);
    setEditingIndex(null);
  };

  const handleAddBlock = (templateBlock) => {
    // Deep clone the template so each added block is independent
    const newBlock = JSON.parse(JSON.stringify(templateBlock));
    onBlocksChange([...blocks, newBlock]);
    setShowPalette(false);
    setPaletteCategory(null);
  };

  const handleParamChange = (index, key, value) => {
    const newBlocks = [...blocks];
    newBlocks[index] = { ...newBlocks[index], [key]: value };
    onBlocksChange(newBlocks);
  };

  const handleDuplicateBlock = (index) => {
    const newBlocks = [...blocks];
    const clone = JSON.parse(JSON.stringify(blocks[index]));
    newBlocks.splice(index + 1, 0, clone);
    onBlocksChange(newBlocks);
  };

  // Render inline parameter editor for a block
  const renderParamEditor = (block, index) => {
    const schema = BLOCK_PARAM_SCHEMA[block.type];
    if (!schema || schema.length === 0) return null;

    return (
      <div className="block-param-editor" onClick={(e) => e.stopPropagation()}>
        {schema.map((param) => (
          <div key={param.key} className="param-field">
            <label className="param-label">{param.label}</label>
            {param.type === 'range' ? (
              <div className="param-range-wrap">
                <input
                  type="range"
                  className="param-range"
                  min={param.min}
                  max={param.max}
                  step={param.step}
                  value={block[param.key] ?? param.min}
                  onChange={(e) => handleParamChange(index, param.key, Number(e.target.value))}
                />
                <span className="param-range-value">{block[param.key] ?? param.min}</span>
              </div>
            ) : param.type === 'number' ? (
              <input
                type="number"
                className="param-input"
                min={param.min}
                max={param.max}
                step={param.step}
                value={block[param.key] ?? ''}
                onChange={(e) => handleParamChange(index, param.key, Number(e.target.value))}
              />
            ) : param.type === 'select' ? (
              <select
                className="param-select"
                value={block[param.key] ?? param.options[0]}
                onChange={(e) => handleParamChange(index, param.key, e.target.value)}
              >
                {param.options.map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                className="param-input param-input-text"
                value={block[param.key] ?? ''}
                onChange={(e) => handleParamChange(index, param.key, e.target.value)}
                placeholder={param.label}
              />
            )}
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="blockly-editor">
      <div className="blocks-toolbar">
        <span className="blocks-count">
          {blocks.length} block{blocks.length !== 1 ? 's' : ''}
        </span>
        <div className="toolbar-actions">
          <button
            className={`btn-small ${showPalette ? 'btn-primary' : 'btn-accent'}`}
            onClick={() => { setShowPalette(!showPalette); setPaletteCategory(null); }}
          >
            {showPalette ? '✕ Close' : '➕ Add Block'}
          </button>
          <button className="btn-small btn-secondary" onClick={handleClearAll}>
            🗑️ Clear All
          </button>
        </div>
      </div>

      {/* Block Palette */}
      {showPalette && (
        <div className="block-palette">
          <div className="palette-categories">
            {BLOCK_PALETTE.map((cat) => (
              <button
                key={cat.category}
                className={`palette-cat-btn ${cat.color} ${paletteCategory === cat.category ? 'active' : ''}`}
                onClick={() => setPaletteCategory(paletteCategory === cat.category ? null : cat.category)}
              >
                {cat.category}
              </button>
            ))}
            {robotConfig?.additions?.length > 0 && (
              <button
                className={`palette-cat-btn cat-hardware ${paletteCategory === 'My Robot' ? 'active' : ''}`}
                onClick={() => setPaletteCategory(paletteCategory === 'My Robot' ? null : 'My Robot')}
              >
                My Robot
              </button>
            )}
          </div>
          {paletteCategory && paletteCategory !== 'My Robot' && (
            <div className="palette-blocks">
              {BLOCK_PALETTE.find(c => c.category === paletteCategory)?.blocks.map((tmpl, i) => (
                <button
                  key={i}
                  className={`palette-block-btn ${getBlockCategory(tmpl.type)}`}
                  onClick={() => handleAddBlock(tmpl)}
                >
                  <span className="palette-block-icon">{getBlockIcon(tmpl.type)}</span>
                  <span className="palette-block-label">{getBlockLabel(tmpl)}</span>
                </button>
              ))}
            </div>
          )}
          {paletteCategory === 'My Robot' && robotConfig?.additions && (
            <div className="palette-blocks">
              {robotConfig.additions.flatMap((hw) => {
                if (!hw.actions || hw.actions.length === 0) return [];
                return hw.actions.map((action, idx) => {
                  const block = hw.type === 'servo'
                    ? { type: 'servo', port: hw.port, angle: action.angle ?? 90 }
                    : { type: 'dc_motor', port: hw.port, speed: (action.motorDirection === 'reverse' ? -(action.speed ?? 50) : (action.speed ?? 50)), duration: action.duration ?? 1 };
                  const label = `${hw.label || hw.port}: ${action.name}`;
                  return (
                    <button
                      key={`${hw.port}_${idx}`}
                      className="palette-block-btn cat-hardware"
                      onClick={() => handleAddBlock(block)}
                    >
                      <span className="palette-block-icon">{hw.type === 'servo' ? '🦾' : '⚡'}</span>
                      <span className="palette-block-label">{label}</span>
                    </button>
                  );
                });
              })}
            </div>
          )}
        </div>
      )}

      {blocks.length === 0 && !showPalette ? (
        <div className="blockly-empty">
          <div className="empty-icon">🧩</div>
          <h3>No blocks yet!</h3>
          <p>Tell your robot what to do in the chat, or click <strong>➕ Add Block</strong> above to build manually!</p>
          <p className="empty-hint">You can also drag blocks around to change the order!</p>
        </div>
      ) : blocks.length > 0 && (
        <div className="blocks-stack">
          {/* Start flag */}
          <div className="block-item block-start">
            <div className="block-icon">🏁</div>
            <div className="block-label">When program starts</div>
          </div>

          {blocks.map((block, index) => (
            <div
              key={index}
              className={`block-item ${getBlockCategory(block.type)} ${
                dragIndex === index ? 'dragging' : ''
              } ${dragOverIndex === index ? 'drag-over' : ''} ${
                editingIndex === index ? 'editing' : ''
              }`}
              draggable
              onDragStart={() => handleDragStart(index)}
              onDragOver={(e) => handleDragOver(e, index)}
              onDrop={() => handleDrop(index)}
              onDragEnd={() => { setDragIndex(null); setDragOverIndex(null); }}
            >
              <div className="block-connector" />
              <div
                className="block-body"
                onClick={() => setEditingIndex(editingIndex === index ? null : index)}
              >
                <div className="block-icon">{getBlockIcon(block.type)}</div>
                <div className="block-content">
                  <div className="block-label">{getBlockLabel(block)}</div>
                  <div className="block-params">{getBlockParams(block)}</div>
                </div>
                <div className="block-actions">
                  <button
                    className="block-action-btn block-duplicate"
                    onClick={(e) => { e.stopPropagation(); handleDuplicateBlock(index); }}
                    title="Duplicate this block"
                  >
                    📋
                  </button>
                  <button
                    className="block-action-btn block-edit-btn"
                    onClick={(e) => { e.stopPropagation(); setEditingIndex(editingIndex === index ? null : index); }}
                    title="Edit parameters"
                  >
                    ✏️
                  </button>
                  <button
                    className="block-action-btn block-delete"
                    onClick={(e) => { e.stopPropagation(); handleDelete(index); }}
                    title="Remove this block"
                  >
                    ×
                  </button>
                </div>
              </div>

              {/* Inline parameter editor */}
              {editingIndex === index && renderParamEditor(block, index)}

              {/* Render nested blocks for control flow */}
              {block.then && block.then.length > 0 && (
                <div className="block-nested">
                  <div className="nested-label">then:</div>
                  {block.then.map((nested, ni) => (
                    <div key={ni} className={`block-item block-nested-item ${getBlockCategory(nested.type)}`}>
                      <div className="block-icon">{getBlockIcon(nested.type)}</div>
                      <div className="block-content">
                        <div className="block-label">{getBlockLabel(nested)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {block.else && block.else.length > 0 && (
                <div className="block-nested block-nested-else">
                  <div className="nested-label">else:</div>
                  {block.else.map((nested, ni) => (
                    <div key={ni} className={`block-item block-nested-item ${getBlockCategory(nested.type)}`}>
                      <div className="block-icon">{getBlockIcon(nested.type)}</div>
                      <div className="block-content">
                        <div className="block-label">{getBlockLabel(nested)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {block.do && block.do.length > 0 && (
                <div className="block-nested">
                  <div className="nested-label">do:</div>
                  {block.do.map((nested, ni) => (
                    <div key={ni} className={`block-item block-nested-item ${getBlockCategory(nested.type)}`}>
                      <div className="block-icon">{getBlockIcon(nested.type)}</div>
                      <div className="block-content">
                        <div className="block-label">{getBlockLabel(nested)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}

          {/* End block */}
          <div className="block-item block-end">
            <div className="block-connector" />
            <div className="block-icon">🏁</div>
            <div className="block-label">End</div>
          </div>
        </div>
      )}
    </div>
  );
}

// === Block display helpers ===

function getBlockCategory(type) {
  const categories = {
    move_forward: 'cat-movement',
    move_backward: 'cat-movement',
    turn_left: 'cat-movement',
    turn_right: 'cat-movement',
    stop: 'cat-movement',
    set_speed: 'cat-movement',
    if_obstacle: 'cat-sensor',
    if_line: 'cat-sensor',
    if_color: 'cat-sensor',
    get_distance: 'cat-sensor',
    if_sensor_range: 'cat-sensor',
    display_value: 'cat-sensor',
    play_tone: 'cat-sound',
    play_melody: 'cat-sound',
    display_text: 'cat-display',
    display_image: 'cat-display',
    say: 'cat-display',
    wait: 'cat-control',
    repeat: 'cat-control',
    repeat_forever: 'cat-control',
    if_button: 'cat-control',
    while_sensor: 'cat-control',
    move_until: 'cat-control',
    set_led: 'cat-sound',
    dc_motor: 'cat-hardware',
    servo: 'cat-hardware',
    set_variable: 'cat-variable',
    change_variable: 'cat-variable',
    math_operation: 'cat-variable',
  };
  return categories[type] || 'cat-other';
}

function getBlockIcon(type) {
  const icons = {
    move_forward: '⬆️',
    move_backward: '⬇️',
    turn_left: '↩️',
    turn_right: '↪️',
    stop: '🛑',
    set_speed: '🏎️',
    if_obstacle: '👀',
    if_line: '➖',
    if_color: '🎨',
    get_distance: '📏',
    if_sensor_range: '📐',
    display_value: '📊',
    play_tone: '🎵',
    play_melody: '🎶',
    display_text: '📝',
    display_image: '🖼️',
    say: '💬',
    wait: '⏱️',
    repeat: '🔄',
    repeat_forever: '♾️',
    if_button: '🔘',
    while_sensor: '🔁',
    move_until: '🎯',
    set_led: '💡',
    dc_motor: '⚡',
    servo: '🦾',
    set_variable: '📦',
    change_variable: '➕',
    math_operation: '🧮',
  };
  return icons[type] || '📦';
}

function getBlockLabel(block) {
  const labels = {
    move_forward: 'Move Forward',
    move_backward: 'Move Backward',
    turn_left: 'Turn Left',
    turn_right: 'Turn Right',
    stop: 'Stop',
    set_speed: 'Set Motor Speed',
    if_obstacle: 'If Obstacle Detected',
    if_line: 'If Line Detected',
    if_color: 'If Color Is',
    get_distance: 'Read Distance',
    if_sensor_range: 'If Sensor In Range',
    display_value: 'Show Sensor Value',
    play_tone: 'Play Tone',
    play_melody: 'Play Melody',
    display_text: 'Show Text',
    display_image: 'Show Image',
    say: 'Say',
    wait: 'Wait',
    repeat: 'Repeat',
    repeat_forever: 'Repeat Forever',
    if_button: 'If Button Pressed',
    while_sensor: 'While Sensor...',
    move_until: 'Move Until...',
    set_led: 'Set LEDs',
    dc_motor: 'DC Motor',
    servo: 'Move Servo',
    set_variable: 'Set Variable',
    change_variable: 'Change Variable',
    math_operation: 'Math',
  };
  return labels[block.type] || block.type;
}

function getBlockParams(block) {
  switch (block.type) {
    case 'move_forward':
    case 'move_backward':
      return `Speed: ${block.speed || 50} | ${block.duration || 1}s`;
    case 'turn_left':
    case 'turn_right':
      return `Speed: ${block.speed || 50} | ${block.angle || 90}°`;
    case 'wait':
      return `${block.duration || 1} seconds`;
    case 'repeat':
      return `${block.times || 1} times`;
    case 'play_tone':
      return `${block.frequency || 440}Hz for ${block.duration || 0.5}s`;
    case 'play_melody':
      return `${block.melody || 'happy'}`;
    case 'display_text':
    case 'say':
      return `"${block.text || ''}"`;
    case 'display_image':
      return `${block.image || 'happy'}`;
    case 'if_obstacle':
      return `closer than ${block.distance || 20}cm`;
    case 'if_color':
      return `${block.color || 'red'}`;
    case 'set_led':
      return `${block.color || 'green'}`;
    case 'dc_motor':
      return `Port ${block.port} | Speed: ${block.speed || 50} | ${block.duration || 1}s`;
    case 'servo':
      return `Port ${block.port} | Angle: ${block.angle || 90}°`;
    case 'set_speed':
      return `Left: ${block.left || 0} | Right: ${block.right || 0}`;
    case 'if_button':
      return `Button ${(block.button || 'a').toUpperCase()}`;
    case 'while_sensor': {
      const op = block.operator || '>';
      if (op === 'between') return `while ${block.sensor || 'distance'} between ${block.min ?? 10} and ${block.max ?? 30}`;
      return `while ${block.sensor || 'distance'} ${op} ${block.value ?? 20}`;
    }
    case 'move_until': {
      const op = block.operator || '<';
      const dir = block.direction || 'forward';
      if (op === 'between') return `${dir} until ${block.sensor || 'distance'} between ${block.min ?? 10} and ${block.max ?? 30}`;
      return `${dir} until ${block.sensor || 'distance'} ${op} ${block.value ?? 20}`;
    }
    case 'if_sensor_range':
      return `${block.sensor || 'distance'} between ${block.min ?? 10} and ${block.max ?? 30}`;
    case 'display_value':
      return `Show ${block.sensor || 'distance'}`;
    case 'set_variable':
      if (block.source && block.source !== 'number') return `${block.name || 'my_var'} = read ${block.source}`;
      return `${block.name || 'my_var'} = ${block.value ?? 0}`;
    case 'change_variable':
      return `${block.name || 'my_var'} += ${block.by ?? 1}`;
    case 'math_operation':
      return `${block.result || 'result'} = ${block.a ?? 0} ${block.operator || '+'} ${block.b ?? 0}`;
    default:
      return '';
  }
}
