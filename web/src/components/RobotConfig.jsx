import React, { useState, useEffect } from 'react';
import './RobotConfig.css';
import CalibrationChat from './CalibrationChat.jsx';
import FirmwareFlasher from './FirmwareFlasher.jsx';
import HardwareWizard from './HardwareWizard.jsx';

export default function RobotConfig({ config, onConfigUpdate, robotConnected, onAchievement }) {
  const [robotName, setRobotName] = useState(config?.name || 'My mBot2');
  const [additions, setAdditions] = useState(config?.additions || []);
  const [notes, setNotes] = useState(config?.notes || '');
  const [nlInput, setNlInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [saveStatus, setSaveStatus] = useState('');
  const [testStatus, setTestStatus] = useState({}); // { port: 'testing...' | 'done' | 'error' }
  const [clarificationQuestions, setClarificationQuestions] = useState([]);
  const [assumptions, setAssumptions] = useState([]);
  const [completeness, setCompleteness] = useState([]);
  const [showWizard, setShowWizard] = useState(false);
  const [physicalDescription, setPhysicalDescription] = useState(config?.physicalDescription || '');
  const [constraints, setConstraints] = useState(config?.constraints || []);
  const [taskPatterns, setTaskPatterns] = useState(config?.taskPatterns || []);

  useEffect(() => {
    if (config) {
      setRobotName(config.name || 'My mBot2');
      setAdditions(config.additions || []);
      setNotes(config.notes || '');
      setPhysicalDescription(config.physicalDescription || '');
      setConstraints(config.constraints || []);
      setTaskPatterns(config.taskPatterns || []);
      setClarificationQuestions([]);
      setAssumptions([]);
      setCompleteness([]);
    }
  }, [config]);

  // Parse natural language hardware description using AI
  const handleNLParse = async () => {
    if (!nlInput.trim()) return;
    setLoading(true);

    try {
      const res = await fetch('/api/config/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: nlInput, existingAdditions: additions }),
      });
      const data = await res.json();

      if (data.additions) {
        setAdditions(data.additions);
        setCompleteness(data.completeness || []);
        setClarificationQuestions(data.questions || []);
        setAssumptions(data.assumptions || []);
        if (data.physicalDescription) setPhysicalDescription(data.physicalDescription);
        if (data.constraints?.length) setConstraints(data.constraints);
        if (data.taskPatterns?.length) setTaskPatterns(data.taskPatterns);
        setNlInput('');

        if (data.needsClarification) {
          setSaveStatus('🧠 I need a few more details before this hardware is fully ready.');
          setTimeout(() => setSaveStatus(''), 5000);
        } else if (data.understood) {
          setSaveStatus(`✅ Got it! ${data.understood}`);
          setTimeout(() => setSaveStatus(''), 5000);
        }
      }
    } catch (err) {
      setSaveStatus('❌ Could not parse. Try describing one thing at a time.');
      setTimeout(() => setSaveStatus(''), 3000);
    } finally {
      setLoading(false);
    }
  };

  const getMissingFields = (addition) => {
    const type = addition?.type;
    const required = type === 'servo'
      ? ['port', 'label', 'partOf', 'purpose', 'states', 'homeState', 'actions', 'orientation']
      : type === 'dc_motor'
      ? ['port', 'label', 'partOf', 'purpose', 'states', 'homeState', 'actions']
      : String(type || '').includes('sensor')
      ? ['port', 'label', 'partOf', 'purpose']
      : ['port', 'label', 'partOf', 'purpose'];

    const missing = [];
    for (const field of required) {
      if (field === 'states') {
        if (!addition.states || addition.states.length === 0) missing.push('states');
        continue;
      }
      if (field === 'actions') {
        if (!addition.actions || addition.actions.length === 0 || !addition.actions.some(a => a?.name)) {
          missing.push('actions');
        }
        continue;
      }
      const value = addition?.[field];
      if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
        missing.push(field);
      }
    }
    return missing;
  };

  const handleSave = async () => {
    const incomplete = additions
      .map((addition, index) => ({
        index,
        label: addition.label || addition.port || `Hardware ${index + 1}`,
        missing: getMissingFields(addition),
      }))
      .filter(item => item.missing.length > 0);

    if (incomplete.length > 0) {
      const first = incomplete[0];
      setSaveStatus(`🧩 ${first.label} still needs: ${first.missing.join(', ')}.`);
      setTimeout(() => setSaveStatus(''), 5000);
      setClarificationQuestions(
        incomplete.flatMap(item => item.missing.map(field => ({
          field,
          question: `For ${item.label}, what is the ${field}?`,
        })))
      );
      return;
    }

    const newConfig = {
      name: robotName,
      additions,
      notes,
      physicalDescription: physicalDescription || undefined,
      constraints: constraints.length ? constraints : undefined,
      taskPatterns: taskPatterns.length ? taskPatterns : undefined,
    };

    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newConfig),
      });
      const data = await res.json();

      if (data.success) {
        onConfigUpdate(data.config);
        setSaveStatus('✅ Robot configuration saved!');
        setTimeout(() => setSaveStatus(''), 3000);
      }
    } catch (err) {
      setSaveStatus('❌ Could not save. Is the server running?');
      setTimeout(() => setSaveStatus(''), 3000);
    }
  };

  const handleRemoveAddition = (index) => {
    setAdditions(additions.filter((_, i) => i !== index));
  };

  const handleAddManual = () => {
    setAdditions([...additions, {
      port: '',
      type: 'dc_motor',
      label: '',
      description: '',
      partOf: '',
      purpose: '',
      feedbackType: 'none',
      states: [],
      homeState: '',
      stallBehavior: 'caution',
      orientation: '',
      actions: [],
    }]);
  };

  const updateAddition = (index, field, value) => {
    const updated = [...additions];
    updated[index] = { ...updated[index], [field]: value };
    // Auto-set feedbackType when type changes
    if (field === 'type') {
      if (value === 'dc_motor') updated[index].feedbackType = 'none';
      else if (value === 'servo') updated[index].feedbackType = 'position';
      else if (value.includes('sensor')) updated[index].feedbackType = 'sensor';
    }
    setAdditions(updated);
  };

  // Send a test action to the robot
  const handleTestAction = async (port, action, type) => {
    setTestStatus(prev => ({ ...prev, [port + action.name]: 'testing' }));
    try {
      const res = await fetch('/api/robot/test-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port, action, type }),
      });
      const data = await res.json();
      if (data.sent) {
        setTestStatus(prev => ({ ...prev, [port + action.name]: 'done' }));
      } else {
        setTestStatus(prev => ({ ...prev, [port + action.name]: 'error' }));
      }
    } catch {
      setTestStatus(prev => ({ ...prev, [port + action.name]: 'error' }));
    }
    setTimeout(() => {
      setTestStatus(prev => ({ ...prev, [port + action.name]: null }));
    }, 2000);
  };

  // Home a hardware port
  const handleHome = async (addition) => {
    if (!addition.homeState) return;
    const homeAction = addition.actions?.find(a => a.targetState === addition.homeState);
    let command = null;
    if (homeAction) {
      if (addition.type === 'servo') {
        command = { type: 'servo', port: addition.port, angle: homeAction.angle || 90 };
      } else {
        const dir = homeAction.motorDirection || 'forward';
        const spd = homeAction.speed || 50;
        command = { type: 'dc_motor', port: addition.port, speed: dir === 'reverse' ? -spd : spd, duration: homeAction.duration || 1 };
      }
    }

    try {
      await fetch('/api/robot/hardware-state/home', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          port: addition.port,
          homeState: addition.homeState,
          homeAction: command,
        }),
      });
      setSaveStatus(`🏠 ${addition.label || addition.port} homed to "${addition.homeState}"`);
      setTimeout(() => setSaveStatus(''), 3000);
    } catch {
      setSaveStatus('❌ Could not home hardware');
      setTimeout(() => setSaveStatus(''), 3000);
    }
  };

  // Manage states as a tag-like input
  const addState = (index, stateName) => {
    if (!stateName.trim()) return;
    const current = additions[index].states || [];
    if (!current.includes(stateName.trim())) {
      updateAddition(index, 'states', [...current, stateName.trim()]);
    }
  };

  const removeState = (index, stateName) => {
    const current = additions[index].states || [];
    updateAddition(index, 'states', current.filter(s => s !== stateName));
    // Also clear homeState if it was removed
    if (additions[index].homeState === stateName) {
      updateAddition(index, 'homeState', '');
    }
  };

  const exampleDescriptions = [
    "I have a claw gripper on port M3 that's part of a robot arm. It opens and closes to pick up small objects.",
    "There's a servo on S1 that lifts the arm up and down. It's part of the robot arm assembly.",
    "I attached a DC motor to M4 that spins a propeller fan on the roof of the robot.",
    "Port S2 has a servo that rotates the robot's head left and right to look around.",
  ];

  const usedPorts = additions.map(a => a.port).filter(Boolean);
  const existingGroups = [...new Set(additions.map(a => a.partOf).filter(Boolean))];

  const handleWizardComplete = (addition) => {
    setAdditions(prev => [...prev, addition]);
    setShowWizard(false);
    setSaveStatus('Hardware added! Click Save Configuration to keep it.');
    setTimeout(() => setSaveStatus(''), 5000);
  };

  return (
    <div className="robot-config">
      {showWizard && (
        <HardwareWizard
          usedPorts={usedPorts}
          existingGroups={existingGroups}
          robotConnected={robotConnected}
          onComplete={handleWizardComplete}
          onCancel={() => setShowWizard(false)}
        />
      )}
      <div className="config-content">
        {/* Robot Identity */}
        <section className="config-section">
          <h2>🤖 Your Robot</h2>
          <div className="config-field">
            <label>Robot Name</label>
            <input
              type="text"
              value={robotName}
              onChange={(e) => setRobotName(e.target.value)}
              placeholder="Give your robot a name!"
            />
          </div>
          <div className="config-field">
            <label>Describe Your Robot</label>
            <p className="field-hint">Tell the AI what your robot looks like. Where are things attached? What can it do? This helps the AI understand your robot's physical shape.</p>
            <textarea
              className="config-notes"
              value={physicalDescription}
              onChange={(e) => setPhysicalDescription(e.target.value)}
              placeholder="Example: A small wheeled rover with a robot arm on top. The arm moves up and down, and has a gripper claw at the end that opens and closes to pick up small objects like ping pong balls."
              rows={3}
            />
          </div>
        </section>

        <section className="config-section">
          <h2>🔌 One-Time Firmware Setup (mLink)</h2>
          <p className="section-desc">
            Upload the robot firmware once using Makeblock's mLink bridge. After that, Program and Live tabs control the robot by sending MQTT commands to the existing firmware.
          </p>
          <p className="section-desc">
            <strong>Required:</strong> Download and install <strong>mLink2</strong> (Makeblock), then keep it running on this computer while you upload.
          </p>
          <FirmwareFlasher />
          <ol className="setup-steps">
            <li>Install and run <strong>mLink2</strong> on this computer.</li>
            <li>Connect your mBot2/CyberPi over USB-C.</li>
            <li>Fill in WiFi + MQTT settings, then click <strong>Upload Firmware via mLink</strong>.</li>
            <li>Wait for reboot and confirm the app shows robot online status.</li>
          </ol>
        </section>

        {/* Hardware List + Add Buttons */}
        <section className="config-section">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <h2>🔧 Hardware</h2>
            <button className="btn-primary btn-small" onClick={() => setShowWizard(true)}>
              + Add Hardware
            </button>
          </div>
          <p className="section-desc">
            Your mBot2 comes with drive motors, ultrasonic sensor, line follower, color sensor, and gyroscope. Add extra servos and motors here.
          </p>

          {additions.length === 0 ? (
            <div className="empty-additions">
              <p>No extra hardware added yet. Click <strong>+ Add Hardware</strong> to get started.</p>
            </div>
          ) : (
            <div className="additions-list">
              {additions.map((addition, index) => (
                <div key={index} className="addition-card">
                  <div className="addition-header">
                    <span className="addition-type-icon">
                      {addition.type === 'dc_motor' ? '⚡' :
                       addition.type === 'servo' ? '🦾' :
                       addition.type === 'ultrasonic' ? '📏' :
                       addition.type === 'color_sensor' ? '🎨' : '📦'}
                    </span>
                    <div className="addition-fields">
                      <div className="addition-field-row">
                        <label>Label:</label>
                        <input
                          type="text"
                          value={addition.label || ''}
                          onChange={(e) => updateAddition(index, 'label', e.target.value)}
                          placeholder="e.g., Claw Motor"
                        />
                      </div>
                      <div className="addition-field-row">
                        <label>Port:</label>
                        <select
                          value={addition.port || ''}
                          onChange={(e) => updateAddition(index, 'port', e.target.value)}
                        >
                          <option value="">Select...</option>
                          <optgroup label="DC Motors">
                            <option value="M1">M1</option>
                            <option value="M2">M2</option>
                            <option value="M3">M3</option>
                            <option value="M4">M4</option>
                          </optgroup>
                          <optgroup label="Servos">
                            <option value="S1">S1</option>
                            <option value="S2">S2</option>
                            <option value="S3">S3</option>
                            <option value="S4">S4</option>
                          </optgroup>
                          <optgroup label="Sensors / mBuild">
                            <option value="P1">P1</option>
                            <option value="P2">P2</option>
                            <option value="P3">P3</option>
                            <option value="P4">P4</option>
                          </optgroup>
                        </select>
                      </div>
                      <div className="addition-field-row">
                        <label>Type:</label>
                        <select
                          value={addition.type || 'dc_motor'}
                          onChange={(e) => updateAddition(index, 'type', e.target.value)}
                        >
                          <option value="dc_motor">DC Motor</option>
                          <option value="servo">Servo</option>
                          <option value="ultrasonic">Ultrasonic Sensor</option>
                          <option value="color_sensor">Color Sensor</option>
                          <option value="light_sensor">Light Sensor</option>
                          <option value="custom">Custom</option>
                        </select>
                      </div>
                    </div>
                    <button
                      className="addition-remove"
                      onClick={() => handleRemoveAddition(index)}
                      title="Remove"
                    >
                      🗑️
                    </button>
                  </div>

                  {/* Rich semantic fields */}
                  <div className="addition-semantic">
                    <div className="addition-field-row">
                      <label>🧩 Part Of:</label>
                      <input
                        type="text"
                        value={addition.partOf || ''}
                        onChange={(e) => updateAddition(index, 'partOf', e.target.value)}
                        placeholder="e.g., Robot Arm, Claw Assembly, Head..."
                      />
                    </div>
                    <div className="addition-field-row">
                      <label>🎯 Purpose:</label>
                      <input
                        type="text"
                        value={addition.purpose || ''}
                        onChange={(e) => updateAddition(index, 'purpose', e.target.value)}
                        placeholder="e.g., Opens and closes claw to grab objects"
                      />
                    </div>
                    {addition.type === 'servo' && (
                      <div className="addition-field-row">
                        <label>🧭 Orientation:</label>
                        <select
                          value={addition.orientation || ''}
                          onChange={(e) => updateAddition(index, 'orientation', e.target.value)}
                        >
                          <option value="">Select...</option>
                          <option value="vertical">Vertical</option>
                          <option value="horizontal">Horizontal</option>
                        </select>
                      </div>
                    )}
                  </div>

                  {/* Physical properties — feedback, states, stall behavior */}
                  <div className="addition-physical">
                    <div className="physical-row">
                      <div className="addition-field-row">
                        <label>📡 Feedback:</label>
                        <select
                          value={addition.feedbackType || 'none'}
                          onChange={(e) => updateAddition(index, 'feedbackType', e.target.value)}
                        >
                          <option value="none">None (DC Motor — no position feedback)</option>
                          <option value="position">Position (Servo — knows its angle)</option>
                          <option value="sensor">Sensor (reads values)</option>
                        </select>
                      </div>
                      <div className="addition-field-row">
                        <label>⚠️ At Limits:</label>
                        <select
                          value={addition.stallBehavior || 'caution'}
                          onChange={(e) => updateAddition(index, 'stallBehavior', e.target.value)}
                        >
                          <option value="safe">Safe — nothing bad happens</option>
                          <option value="caution">Caution — motor stalls but no damage</option>
                          <option value="danger">Danger — could damage mechanism!</option>
                        </select>
                      </div>
                    </div>

                    {/* Named states */}
                    {(addition.feedbackType || 'none') !== 'sensor' && (
                      <div className="states-editor">
                        <label className="states-label">🏷️ Physical States:</label>
                        <div className="states-tags">
                          {(addition.states || []).map((state, si) => (
                            <span key={si} className={`state-tag ${state === addition.homeState ? 'state-tag-home' : ''}`}>
                              {state}
                              {state === addition.homeState && <span className="home-badge">🏠</span>}
                              <button className="state-tag-remove" onClick={() => removeState(index, state)}>×</button>
                            </span>
                          ))}
                          <input
                            type="text"
                            className="state-add-input"
                            placeholder="Add state..."
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                addState(index, e.target.value);
                                e.target.value = '';
                              }
                            }}
                          />
                        </div>

                        {(addition.states || []).length > 0 && (
                          <div className="addition-field-row home-state-row">
                            <label>🏠 Home:</label>
                            <select
                              value={addition.homeState || ''}
                              onChange={(e) => updateAddition(index, 'homeState', e.target.value)}
                            >
                              <option value="">Not set</option>
                              {(addition.states || []).map(s => (
                                <option key={s} value={s}>{s}</option>
                              ))}
                            </select>
                            {addition.homeState && (
                              <button
                                className="btn-tiny btn-home"
                                onClick={() => handleHome(addition)}
                                title="Run home action now"
                              >
                                🏠 Home Now
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Named actions with motor parameters */}
                  <div className="addition-actions">
                    <label className="actions-label">⚡ Actions:</label>
                    {(addition.actions || []).map((action, ai) => (
                      <div key={ai} className="action-card">
                        <div className="action-main-row">
                          <input
                            type="text"
                            className="action-name"
                            value={action.name || ''}
                            onChange={(e) => {
                              const acts = [...(addition.actions || [])];
                              acts[ai] = { ...acts[ai], name: e.target.value };
                              updateAddition(index, 'actions', acts);
                            }}
                            placeholder="Action name (e.g., open)"
                          />
                          {(addition.states || []).length > 0 && (
                            <>
                              <span className="action-arrow">→</span>
                              <select
                                className="action-target-state"
                                value={action.targetState || ''}
                                onChange={(e) => {
                                  const acts = [...(addition.actions || [])];
                                  acts[ai] = { ...acts[ai], targetState: e.target.value };
                                  updateAddition(index, 'actions', acts);
                                }}
                              >
                                <option value="">No state change</option>
                                {(addition.states || []).map(s => (
                                  <option key={s} value={s}>{s}</option>
                                ))}
                              </select>
                            </>
                          )}
                          <button
                            className={`btn-tiny btn-test ${testStatus[addition.port + action.name] || ''}`}
                            onClick={() => handleTestAction(addition.port, action, addition.type)}
                            title="Test this action on the robot now"
                            disabled={testStatus[addition.port + action.name] === 'testing'}
                          >
                            {testStatus[addition.port + action.name] === 'testing' ? '⏳' :
                             testStatus[addition.port + action.name] === 'done' ? '✅' :
                             testStatus[addition.port + action.name] === 'error' ? '❌' : '🧪 Test'}
                          </button>
                          <button
                            className="action-remove"
                            onClick={() => {
                              const acts = (addition.actions || []).filter((_, j) => j !== ai);
                              updateAddition(index, 'actions', acts);
                            }}
                          >✕</button>
                        </div>

                        {/* Motor parameters row */}
                        {addition.type === 'dc_motor' && (
                          <div className="action-params-row">
                            <div className="param-field">
                              <label>Direction:</label>
                              <select
                                value={action.motorDirection || 'forward'}
                                onChange={(e) => {
                                  const acts = [...(addition.actions || [])];
                                  acts[ai] = { ...acts[ai], motorDirection: e.target.value };
                                  updateAddition(index, 'actions', acts);
                                }}
                              >
                                <option value="forward">Forward</option>
                                <option value="reverse">Reverse</option>
                              </select>
                            </div>
                            <div className="param-field">
                              <label>Speed:</label>
                              <input
                                type="number"
                                min="0"
                                max="100"
                                value={action.speed || 50}
                                onChange={(e) => {
                                  const acts = [...(addition.actions || [])];
                                  acts[ai] = { ...acts[ai], speed: parseInt(e.target.value) || 50 };
                                  updateAddition(index, 'actions', acts);
                                }}
                              />
                            </div>
                            <div className="param-field">
                              <label>Duration:</label>
                              <input
                                type="number"
                                min="0.1"
                                max="10"
                                step="0.1"
                                value={action.duration || 0.5}
                                onChange={(e) => {
                                  const acts = [...(addition.actions || [])];
                                  acts[ai] = { ...acts[ai], duration: parseFloat(e.target.value) || 0.5 };
                                  updateAddition(index, 'actions', acts);
                                }}
                              />
                              <span className="param-unit">s</span>
                            </div>
                          </div>
                        )}

                        {addition.type === 'servo' && (
                          <div className="action-params-row">
                            <div className="param-field">
                              <label>Angle:</label>
                              <input
                                type="number"
                                min="0"
                                max="180"
                                value={action.angle || 90}
                                onChange={(e) => {
                                  const acts = [...(addition.actions || [])];
                                  acts[ai] = { ...acts[ai], angle: parseInt(e.target.value) || 90 };
                                  updateAddition(index, 'actions', acts);
                                }}
                              />
                              <span className="param-unit">°</span>
                            </div>
                          </div>
                        )}

                        <input
                          type="text"
                          className="action-desc-full"
                          value={action.description || ''}
                          onChange={(e) => {
                            const acts = [...(addition.actions || [])];
                            acts[ai] = { ...acts[ai], description: e.target.value };
                            updateAddition(index, 'actions', acts);
                          }}
                          placeholder="Description (e.g., Spin forward at speed 70 for 0.5s to open the claw)"
                        />
                      </div>
                    ))}
                    <button
                      className="btn-tiny"
                      onClick={() => {
                        const newAction = addition.type === 'servo'
                          ? { name: '', targetState: '', angle: 90, description: '' }
                          : { name: '', targetState: '', motorDirection: 'forward', speed: 50, duration: 0.5, description: '' };
                        const acts = [...(addition.actions || []), newAction];
                        updateAddition(index, 'actions', acts);
                      }}
                    >
                      + Add Action
                    </button>
                  </div>

                  <div className="addition-desc">
                    <textarea
                      value={addition.description || ''}
                      onChange={(e) => updateAddition(index, 'description', e.target.value)}
                      placeholder="Any extra notes about this hardware..."
                      rows={2}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}

          {completeness.length > 0 && (
            <div className="clarification-box">
              <h4>📊 Setup completeness</h4>
              <ul>
                {completeness.map((item, idx) => (
                  <li key={`cmp_${idx}`}>
                    {item.label}: {Math.round((item.score || 0) * 100)}% complete
                    {item.missing?.length > 0 ? ` (missing: ${item.missing.join(', ')})` : ' ✅'}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <details style={{ marginTop: 12 }}>
            <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 13, color: '#666' }}>Or describe hardware with AI text...</summary>
            <div style={{ marginTop: 8 }}>
              <div className="nl-input-area">
                <textarea
                  value={nlInput}
                  onChange={(e) => setNlInput(e.target.value)}
                  placeholder='Example: "I connected a claw gripper motor to port M3"'
                  rows={2}
                  disabled={loading}
                />
                <button className="btn-primary btn-small" onClick={handleNLParse} disabled={!nlInput.trim() || loading}>
                  {loading ? 'Thinking...' : 'Add'}
                </button>
              </div>
              {clarificationQuestions.length > 0 && (
                <div className="clarification-box">
                  <h4>Details needed:</h4>
                  <ul>{clarificationQuestions.map((q, idx) => <li key={idx}>{q.question}</li>)}</ul>
                </div>
              )}
            </div>
          </details>
        </section>

        {/* Calibration Teaching */}
        <section className="config-section">
          <details>
            <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 16 }}>🎓 Teach Your Robot (Calibration)</summary>
            <p className="section-desc" style={{ marginTop: 8 }}>
              Have a conversation with the AI to teach your robot about how far it moves, how fast it turns, and more!
            </p>
            <CalibrationChat robotConnected={robotConnected} onAchievement={onAchievement} />
          </details>
        </section>

        {/* Notes */}
        <section className="config-section">
          <h2>📝 Notes</h2>
          <textarea
            className="config-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Any other notes about your robot setup..."
            rows={3}
          />
        </section>

        {/* Physical Constraints */}
        {constraints.length > 0 && (
          <section className="config-section">
            <h2>⚠️ Physical Rules</h2>
            <p className="section-desc">
              The AI follows these rules when generating programs. They were auto-detected from your robot description, or you can edit them.
            </p>
            <ul className="constraints-list">
              {constraints.map((c, i) => (
                <li key={i} className="constraint-item">
                  <span>{c}</span>
                  <button className="btn-remove-small" onClick={() => setConstraints(constraints.filter((_, j) => j !== i))}>×</button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Save Button */}
        <div className="config-save-area">
          {saveStatus && <span className="save-status">{saveStatus}</span>}
          <button className="btn-primary btn-save" onClick={handleSave}>
            💾 Save Configuration
          </button>
        </div>
      </div>
    </div>
  );
}
