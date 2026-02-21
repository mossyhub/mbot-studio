import React, { useState, useRef, useCallback, useEffect } from 'react';
import './HardwareWizard.css';

const SERVO_PORTS = ['S1', 'S2', 'S3', 'S4'];
const MOTOR_PORTS = ['M1', 'M2', 'M3', 'M4'];

export default function HardwareWizard({ usedPorts = [], existingGroups = [], robotConnected, onComplete, onCancel }) {
  const [step, setStep] = useState(0);
  const [port, setPort] = useState(null);
  const [hwType, setHwType] = useState(null);
  // Servo state
  const [servoAngle, setServoAngle] = useState(90);
  const [positions, setPositions] = useState([]);
  const [posName, setPosName] = useState('');
  // Motor state
  const [motorStyle, setMotorStyle] = useState(null); // 'gripper' or 'continuous'
  const [motorSpeed, setMotorSpeed] = useState(70);
  // Gripper calibration
  const [fwdName, setFwdName] = useState('');
  const [revName, setRevName] = useState('');
  const [fwdDuration, setFwdDuration] = useState(null);
  const [revDuration, setRevDuration] = useState(null);
  const [calibrating, setCalibrating] = useState(null); // 'forward' | 'reverse' | null
  const calibrateStart = useRef(null);
  // Continuous motor state
  const [contFwdName, setContFwdName] = useState('');
  const [contRevName, setContRevName] = useState('');
  const [contDuration, setContDuration] = useState(1);
  // Common
  const [label, setLabel] = useState('');
  const [partOf, setPartOf] = useState('');
  const [homeState, setHomeState] = useState('');
  const throttle = useRef(null);
  const wsRef = useRef(null);

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    wsRef.current = ws;
    return () => { if (wsRef.current) wsRef.current.close(); };
  }, []);

  const sendCommand = useCallback((command) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'command', command }));
    }
  }, []);

  const sendServo = useCallback((angle) => {
    if (!port) return;
    if (throttle.current) clearTimeout(throttle.current);
    throttle.current = setTimeout(() => {
      sendCommand({ type: 'servo', port, angle });
    }, 100);
  }, [port, sendCommand]);

  const sendMotorRun = useCallback((direction, duration) => {
    if (!port) return;
    const speed = direction === 'reverse' ? -motorSpeed : motorSpeed;
    sendCommand({ type: 'dc_motor', port, speed, duration: duration || 0 });
  }, [port, motorSpeed, sendCommand]);

  const sendMotorStop = useCallback(() => {
    if (!port) return;
    sendCommand({ type: 'dc_motor', port, speed: 0, duration: 0 });
  }, [port, sendCommand]);

  const handlePortSelect = (p) => {
    setPort(p);
    setHwType(p.startsWith('S') ? 'servo' : 'dc_motor');
    setMotorStyle(null);
    setPositions([]);
    setFwdName(''); setRevName('');
    setFwdDuration(null); setRevDuration(null);
    setContFwdName(''); setContRevName('');
    setLabel(''); setPartOf(''); setHomeState('');
  };

  const handleServoChange = (angle) => {
    setServoAngle(angle);
    sendServo(angle);
  };

  const handleSaveServoPosition = () => {
    if (!posName.trim()) return;
    setPositions(prev => [...prev, { name: posName.trim(), angle: servoAngle }]);
    if (!homeState) setHomeState(posName.trim());
    setPosName('');
  };

  const handleRemovePosition = (idx) => {
    setPositions(prev => {
      const next = prev.filter((_, i) => i !== idx);
      if (next.length === 0) setHomeState('');
      else if (homeState === prev[idx]?.name) setHomeState(next[0].name);
      return next;
    });
  };

  // Gripper calibration: hold-to-run with timing
  const startCalibrate = (direction) => {
    setCalibrating(direction);
    calibrateStart.current = Date.now();
    sendMotorRun(direction, 0); // 0 = run continuously
  };

  const stopCalibrate = () => {
    if (!calibrating) return;
    const elapsed = ((Date.now() - calibrateStart.current) / 1000);
    const duration = Math.round(elapsed * 10) / 10; // round to 0.1s
    const withMargin = Math.round((duration * 1.2) * 10) / 10; // 20% margin
    sendMotorStop();
    if (calibrating === 'forward') {
      setFwdDuration(withMargin);
    } else {
      setRevDuration(withMargin);
    }
    setCalibrating(null);
  };

  // Steps differ for servo vs motor
  const getSteps = () => {
    if (hwType === 'servo') {
      return ['port', 'test', 'positions', 'label', 'review'];
    } else if (motorStyle === 'gripper') {
      return ['port', 'style', 'calibrate', 'label', 'review'];
    } else if (motorStyle === 'continuous') {
      return ['port', 'style', 'names', 'label', 'review'];
    }
    return ['port', 'style']; // waiting for style selection
  };

  const getStepTitles = () => {
    if (hwType === 'servo') {
      return ['Select Port', 'Test It', 'Name Positions', 'Label & Group', 'Review'];
    } else if (motorStyle === 'gripper') {
      return ['Select Port', 'Motor Type', 'Calibrate Limits', 'Label & Group', 'Review'];
    } else if (motorStyle === 'continuous') {
      return ['Select Port', 'Motor Type', 'Name Directions', 'Label & Group', 'Review'];
    }
    return ['Select Port', 'Motor Type'];
  };

  const steps = getSteps();
  const stepTitles = getStepTitles();

  const canAdvance = () => {
    const currentStepName = steps[step];
    if (currentStepName === 'port') return !!port;
    if (currentStepName === 'style') return !!motorStyle;
    if (currentStepName === 'test') return true;
    if (currentStepName === 'positions') return positions.length >= 1;
    if (currentStepName === 'calibrate') return fwdName.trim() && revName.trim() && fwdDuration && revDuration;
    if (currentStepName === 'names') return contFwdName.trim() || contRevName.trim();
    if (currentStepName === 'label') return label.trim();
    return true;
  };

  const buildAddition = () => {
    const states = [];
    const actions = [];

    if (hwType === 'servo') {
      for (const pos of positions) {
        states.push(pos.name);
        actions.push({ name: pos.name, targetState: pos.name, angle: pos.angle });
      }
    } else if (motorStyle === 'gripper') {
      if (fwdName.trim()) {
        states.push(fwdName.trim());
        actions.push({ name: fwdName.trim(), targetState: fwdName.trim(), motorDirection: 'forward', speed: motorSpeed, duration: fwdDuration });
      }
      if (revName.trim()) {
        states.push(revName.trim());
        actions.push({ name: revName.trim(), targetState: revName.trim(), motorDirection: 'reverse', speed: motorSpeed, duration: revDuration });
      }
    } else {
      if (contFwdName.trim()) {
        states.push(contFwdName.trim());
        actions.push({ name: contFwdName.trim(), targetState: contFwdName.trim(), motorDirection: 'forward', speed: motorSpeed, duration: contDuration });
      }
      if (contRevName.trim()) {
        states.push(contRevName.trim());
        actions.push({ name: contRevName.trim(), targetState: contRevName.trim(), motorDirection: 'reverse', speed: motorSpeed, duration: contDuration });
      }
    }

    const purpose = states.length > 0
      ? states.map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' and ') + ` the ${label || port}`
      : `Controls ${label || port}`;

    return {
      port,
      type: hwType,
      label: label.trim() || port,
      partOf: partOf.trim() || '',
      purpose,
      motorStyle: hwType === 'dc_motor' ? motorStyle : undefined,
      orientation: hwType === 'servo' ? 'vertical' : undefined,
      feedbackType: hwType === 'servo' ? 'position' : 'none',
      states,
      homeState: homeState || (states.length > 0 ? states[0] : ''),
      stallBehavior: 'safe',
      actions,
    };
  };

  return (
    <div className="hw-wizard-overlay">
      <div className="hw-wizard">
        <div className="hw-wizard-header">
          <h2>Add Hardware</h2>
          <button className="hw-wizard-close" onClick={onCancel}>X</button>
        </div>

        <div className="hw-wizard-steps">
          {steps.map((s, i) => (
            <div key={s + i} className={`hw-step-dot ${i === step ? 'active' : i < step ? 'done' : ''}`}>
              {i < step ? '\u2713' : i + 1}
              <span className="hw-step-label">{stepTitles[i]}</span>
            </div>
          ))}
        </div>

        <div className="hw-wizard-body">
          {/* ===== PORT SELECTION ===== */}
          {steps[step] === 'port' && (
            <div className="hw-wizard-step">
              <h3>What port is it connected to?</h3>
              <p className="hw-hint">Servo motors plug into S ports. DC motors plug into M ports.</p>
              <div className="hw-port-grid">
                <div className="hw-port-group">
                  <h4>Servo Ports</h4>
                  <div className="hw-port-buttons">
                    {SERVO_PORTS.map(p => (
                      <button key={p} className={`hw-port-btn ${port === p ? 'selected' : ''} ${usedPorts.includes(p) ? 'used' : ''}`}
                        onClick={() => !usedPorts.includes(p) && handlePortSelect(p)} disabled={usedPorts.includes(p)}>
                        {p}{usedPorts.includes(p) && <span className="hw-port-used">in use</span>}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="hw-port-group">
                  <h4>Motor Ports</h4>
                  <div className="hw-port-buttons">
                    {MOTOR_PORTS.map(p => (
                      <button key={p} className={`hw-port-btn ${port === p ? 'selected' : ''} ${usedPorts.includes(p) ? 'used' : ''}`}
                        onClick={() => !usedPorts.includes(p) && handlePortSelect(p)} disabled={usedPorts.includes(p)}>
                        {p}{usedPorts.includes(p) && <span className="hw-port-used">in use</span>}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              {port && <p className="hw-selected">Selected: <strong>{port}</strong> ({hwType === 'servo' ? 'Servo Motor' : 'DC Motor'})</p>}
            </div>
          )}

          {/* ===== MOTOR STYLE (grippers vs continuous) ===== */}
          {steps[step] === 'style' && (
            <div className="hw-wizard-step">
              <h3>What kind of motor is this?</h3>
              <div className="hw-style-options">
                <button className={`hw-style-btn ${motorStyle === 'gripper' ? 'selected' : ''}`}
                  onClick={() => setMotorStyle('gripper')}>
                  <span className="hw-style-icon">🤏</span>
                  <span className="hw-style-title">Gripper / Claw / Gate</span>
                  <span className="hw-style-desc">Has physical stops at each end. Opens and closes (or up and down). We'll calibrate the travel time.</span>
                </button>
                <button className={`hw-style-btn ${motorStyle === 'continuous' ? 'selected' : ''}`}
                  onClick={() => setMotorStyle('continuous')}>
                  <span className="hw-style-icon">🔄</span>
                  <span className="hw-style-title">Wheel / Fan / Spinner</span>
                  <span className="hw-style-desc">Spins freely in both directions. No physical stops. Just forward, reverse, and stop.</span>
                </button>
              </div>
            </div>
          )}

          {/* ===== SERVO: TEST ===== */}
          {steps[step] === 'test' && hwType === 'servo' && (
            <div className="hw-wizard-step">
              <h3>Test {port} — move the slider to see it move</h3>
              {!robotConnected && <p className="hw-warning">Robot not connected! Connect it to test live.</p>}
              <div className="hw-test-servo">
                <div className="hw-angle-display">{servoAngle}°</div>
                <input type="range" min={0} max={180} value={servoAngle}
                  onChange={(e) => handleServoChange(Number(e.target.value))} className="hw-servo-slider" />
                <div className="hw-servo-labels"><span>0°</span><span>90°</span><span>180°</span></div>
                <p className="hw-hint">Drag the slider and watch the servo move. Find the positions you want to name in the next step.</p>
              </div>
            </div>
          )}

          {/* ===== SERVO: NAME POSITIONS ===== */}
          {steps[step] === 'positions' && (
            <div className="hw-wizard-step">
              <h3>Name the positions</h3>
              <p className="hw-hint">Set the angle, type a name, and click "Save Position" (e.g., "up" at 45°, "down" at 120°).</p>
              <div className="hw-servo-save-row">
                <div className="hw-angle-display">{servoAngle}°</div>
                <input type="range" min={0} max={180} value={servoAngle}
                  onChange={(e) => handleServoChange(Number(e.target.value))} className="hw-servo-slider-small" />
                <input type="text" value={posName} onChange={(e) => setPosName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSaveServoPosition()}
                  placeholder="Name (e.g. up)" className="hw-pos-name-input" maxLength={20} />
                <button className="btn-primary btn-small" onClick={handleSaveServoPosition} disabled={!posName.trim()}>Save</button>
              </div>
              {positions.length > 0 && (
                <div className="hw-positions-list">
                  <h4>Saved Positions:</h4>
                  {positions.map((pos, i) => (
                    <div key={i} className="hw-position-item">
                      <span className="hw-pos-name">{pos.name}</span>
                      <span className="hw-pos-angle">{pos.angle}°</span>
                      <button className="hw-pos-goto" onClick={() => handleServoChange(pos.angle)}>Go</button>
                      <button className="hw-pos-remove" onClick={() => handleRemovePosition(i)}>X</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ===== GRIPPER: CALIBRATE LIMITS ===== */}
          {steps[step] === 'calibrate' && (
            <div className="hw-wizard-step">
              <h3>Calibrate the limits</h3>
              <p className="hw-hint">
                Hold each button until the motor hits its physical stop. The wizard will time how long it takes.
                This lets us reliably go to "fully open" or "fully closed" every time.
              </p>

              <div className="hw-motor-params" style={{ marginBottom: 12 }}>
                <label>Speed: {motorSpeed}% <input type="range" min={30} max={100} step={5} value={motorSpeed} onChange={e => setMotorSpeed(Number(e.target.value))} /></label>
              </div>

              <div className="hw-calibrate-grid">
                {/* Forward limit */}
                <div className="hw-calibrate-card">
                  <div className="hw-calibrate-header">
                    <input type="text" value={fwdName} onChange={e => setFwdName(e.target.value)}
                      placeholder="Name this end (e.g. open)" maxLength={20} className="hw-cal-name" />
                    {fwdDuration && <span className="hw-cal-time">{fwdDuration}s</span>}
                  </div>
                  <button
                    className={`hw-cal-btn ${calibrating === 'forward' ? 'active' : ''}`}
                    onMouseDown={() => startCalibrate('forward')}
                    onMouseUp={stopCalibrate}
                    onMouseLeave={() => calibrating === 'forward' && stopCalibrate()}
                    onTouchStart={() => startCalibrate('forward')}
                    onTouchEnd={stopCalibrate}
                    disabled={!robotConnected}
                  >
                    {calibrating === 'forward' ? 'Release when it stops...' : (fwdDuration ? `Re-calibrate Forward (${fwdDuration}s)` : 'Hold: Run Forward')}
                  </button>
                  {fwdDuration && <p className="hw-cal-note">Will run forward for {fwdDuration}s (includes 20% margin to ensure it reaches the stop)</p>}
                </div>

                {/* Reverse limit */}
                <div className="hw-calibrate-card">
                  <div className="hw-calibrate-header">
                    <input type="text" value={revName} onChange={e => setRevName(e.target.value)}
                      placeholder="Name this end (e.g. close)" maxLength={20} className="hw-cal-name" />
                    {revDuration && <span className="hw-cal-time">{revDuration}s</span>}
                  </div>
                  <button
                    className={`hw-cal-btn ${calibrating === 'reverse' ? 'active' : ''}`}
                    onMouseDown={() => startCalibrate('reverse')}
                    onMouseUp={stopCalibrate}
                    onMouseLeave={() => calibrating === 'reverse' && stopCalibrate()}
                    onTouchStart={() => startCalibrate('reverse')}
                    onTouchEnd={stopCalibrate}
                    disabled={!robotConnected}
                  >
                    {calibrating === 'reverse' ? 'Release when it stops...' : (revDuration ? `Re-calibrate Reverse (${revDuration}s)` : 'Hold: Run Reverse')}
                  </button>
                  {revDuration && <p className="hw-cal-note">Will run reverse for {revDuration}s (includes 20% margin)</p>}
                </div>
              </div>

              {fwdDuration && revDuration && (
                <div className="hw-cal-summary">
                  On startup, the robot will run to the <strong>home position</strong> (you'll pick which one next) for the full duration to guarantee it reaches the physical stop.
                </div>
              )}
            </div>
          )}

          {/* ===== CONTINUOUS: NAME DIRECTIONS ===== */}
          {steps[step] === 'names' && (
            <div className="hw-wizard-step">
              <h3>Name the directions</h3>
              <p className="hw-hint">What does each direction do? Test and name them.</p>
              <div className="hw-motor-name-grid">
                <div className="hw-motor-name-row">
                  <span className="hw-dir-label">Forward =</span>
                  <input type="text" value={contFwdName} onChange={e => setContFwdName(e.target.value)} placeholder="e.g. spin, push" maxLength={20} />
                  <button className="btn-small btn-secondary" onClick={() => sendMotorRun('forward', contDuration)}>Test</button>
                </div>
                <div className="hw-motor-name-row">
                  <span className="hw-dir-label">Reverse =</span>
                  <input type="text" value={contRevName} onChange={e => setContRevName(e.target.value)} placeholder="e.g. pull, reverse spin" maxLength={20} />
                  <button className="btn-small btn-secondary" onClick={() => sendMotorRun('reverse', contDuration)}>Test</button>
                </div>
              </div>
              <div className="hw-motor-params">
                <label>Speed: {motorSpeed}% <input type="range" min={10} max={100} step={5} value={motorSpeed} onChange={e => setMotorSpeed(Number(e.target.value))} /></label>
                <label>Duration: {contDuration}s <input type="range" min={0.2} max={5} step={0.1} value={contDuration} onChange={e => setContDuration(Number(e.target.value))} /></label>
              </div>
            </div>
          )}

          {/* ===== LABEL & GROUP ===== */}
          {steps[step] === 'label' && (
            <div className="hw-wizard-step">
              <h3>Give it a name</h3>
              <div className="hw-label-form">
                <label>
                  <span className="hw-field-label">Label</span>
                  <input type="text" value={label} onChange={e => setLabel(e.target.value)}
                    placeholder={hwType === 'servo' ? 'e.g. Arm Servo' : 'e.g. Claw Motor'} maxLength={30} />
                </label>
                <label>
                  <span className="hw-field-label">Part of (assembly)</span>
                  {existingGroups.length > 0 ? (
                    <div className="hw-group-row">
                      <select value={partOf} onChange={e => setPartOf(e.target.value)}>
                        <option value="">-- New group --</option>
                        {existingGroups.map(g => <option key={g} value={g}>{g}</option>)}
                      </select>
                      {!partOf && <input type="text" value={partOf} onChange={e => setPartOf(e.target.value)} placeholder="e.g. Robot Arm" maxLength={30} />}
                    </div>
                  ) : (
                    <input type="text" value={partOf} onChange={e => setPartOf(e.target.value)} placeholder="e.g. Robot Arm" maxLength={30} />
                  )}
                </label>
                {(() => {
                  const addition = buildAddition();
                  if (addition.states.length === 0) return null;
                  return (
                    <label>
                      <span className="hw-field-label">Home / starting position</span>
                      <select value={homeState} onChange={e => setHomeState(e.target.value)}>
                        {addition.states.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                      {motorStyle === 'gripper' && (
                        <p className="hw-hint" style={{ marginTop: 4 }}>On startup or reset, the motor will run to this position for the full calibrated duration to ensure it's at the physical stop.</p>
                      )}
                    </label>
                  );
                })()}
              </div>
            </div>
          )}

          {/* ===== REVIEW ===== */}
          {steps[step] === 'review' && (
            <div className="hw-wizard-step">
              <h3>Review</h3>
              {(() => {
                const a = buildAddition();
                return (
                  <div className="hw-review-card">
                    <div className="hw-review-row"><strong>Port:</strong> {a.port}</div>
                    <div className="hw-review-row"><strong>Type:</strong> {a.type === 'servo' ? 'Servo' : motorStyle === 'gripper' ? 'DC Motor (Gripper)' : 'DC Motor (Continuous)'}</div>
                    <div className="hw-review-row"><strong>Label:</strong> {a.label}</div>
                    {a.partOf && <div className="hw-review-row"><strong>Part of:</strong> {a.partOf}</div>}
                    <div className="hw-review-row"><strong>Home:</strong> {a.homeState || 'none'}</div>
                    <div className="hw-review-row"><strong>Actions:</strong></div>
                    {a.actions.map((act, i) => (
                      <div key={i} className="hw-review-action">
                        <strong>{act.name}</strong>: {a.type === 'servo' ? `${act.angle}°` : `${act.motorDirection} @ ${act.speed}% for ${act.duration}s`}
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>
          )}
        </div>

        <div className="hw-wizard-footer">
          <button className="btn-secondary" onClick={step > 0 ? () => setStep(step - 1) : onCancel}>
            {step > 0 ? 'Back' : 'Cancel'}
          </button>
          {step < steps.length - 1 ? (
            <button className="btn-primary" onClick={() => setStep(step + 1)} disabled={!canAdvance()}>Next</button>
          ) : (
            <button className="btn-primary" onClick={() => onComplete(buildAddition())}>Add to Robot</button>
          )}
        </div>
      </div>
    </div>
  );
}
