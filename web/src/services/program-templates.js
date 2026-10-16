// Curated finite examples for the installed cooperative AV runtime.
const wait = duration => ({ type: 'wait', duration });
const tone = (frequency, duration = 0.25) => ({ type: 'play_tone', frequency, duration });
const text = text => ({ type: 'display_text', text, size: 16 });
const forward = duration => ({ type: 'move_forward', speed: 20, duration });
const backward = duration => ({ type: 'move_backward', speed: 20, duration });
export const TEMPLATES = [
  { id: 'tmpl_dance', name: 'Dance Party', icon: '💃', category: 'fun', difficulty: 'Level 2',
    description: 'Two small forward/back steps with beeps and gentle native turns. Clear the floor first.',
    blocks: [text('Dance!'), { type: 'repeat', times: 2, do: [forward(0.3), tone(523), { type: 'turn_right', angle: 15 }, backward(0.3), tone(659), { type: 'turn_left', angle: 15 }] }, { type: 'stop' }, text('Ta-da!')] },
  { id: 'tmpl_explorer', name: 'Room Explorer', icon: '🗺️', category: 'sensors', difficulty: 'Not supported yet',
    description: 'Autonomous wall avoidance needs a live sensor program runner.',
    unavailable: 'Not supported by this robot app: live sensor conditions and forever loops cannot run. Use Live Control and Refresh sensors for supervised exploration; a snapshot is not automatic collision avoidance.', blocks: [] },
  { id: 'tmpl_line', name: 'Line Follower', icon: '➖', category: 'sensors', difficulty: 'Not supported yet',
    description: 'Automatic line tracking is not implemented in this robot app.',
    unavailable: 'Requires a live line-sensor feedback loop. The editor catalog alone does not make it executable.', blocks: [] },
  { id: 'tmpl_guard', name: 'Guard Robot', icon: '🛡️', category: 'sensors', difficulty: 'Not supported yet',
    description: 'An automatic distance-triggered alarm needs live sensor conditions.',
    unavailable: 'Requires live sensor conditions. Try Light Show or Music Box for a runnable alarm sequence without automatic detection.', blocks: [] },
  { id: 'tmpl_route', name: 'Route Rehearsal', icon: '🧭', category: 'movement', difficulty: 'Level 2',
    description: 'Practice a short sequence, not a measured square. Native turn angles are not calibrated headings.',
    blocks: [text('Route'), forward(0.5), wait(0.3), { type: 'turn_right', angle: 20 }, forward(0.5), { type: 'stop' }, text('Done')] },
  { id: 'tmpl_zigzag', name: 'Gentle Zigzag', icon: '⚡', category: 'movement', difficulty: 'Level 2',
    description: 'Two short steps with alternating small turns. Watch the route and keep Stop nearby.',
    blocks: [forward(0.4), { type: 'turn_right', angle: 20 }, forward(0.4), { type: 'turn_left', angle: 20 }, { type: 'stop' }] },
  { id: 'tmpl_lightshow', name: 'Light Show', icon: '🌈', category: 'fun', difficulty: 'Level 1',
    description: 'A stationary red, green and blue sequence with pauses, repeated twice.',
    blocks: [{ type: 'repeat', times: 2, do: [{ type: 'set_led', color: 'red' }, wait(0.4), { type: 'set_led', color: 'green' }, wait(0.4), { type: 'set_led', color: 'blue' }, wait(0.4)] }, { type: 'set_led', color: 'off' }] },
  { id: 'tmpl_music', name: 'Music Box', icon: '🎵', category: 'fun', difficulty: 'Level 1',
    description: 'The opening two lines of Twinkle Twinkle, at a modest volume. No movement.',
    blocks: [{ type: 'set_volume', volume: 25 }, text('Music!'), ...[262,262,392,392,440,440,392,349,349,330,330,294,294,262].map((f,i)=>tone(f,i===6||i===13?0.5:0.25)), text('Encore?')] },
  { id: 'tmpl_greeting', name: 'Greeting Bot', icon: '👋', category: 'fun', difficulty: 'Level 1',
    description: 'Shows a greeting and plays two notes when you press Run—not when a sensor sees someone.',
    blocks: [text('Hi there!'), { type: 'set_led', color: 'green' }, tone(523), tone(659), wait(1), text('Ready to learn!')] },
  { id: 'tmpl_servo_wave', name: 'Arm Wave', icon: '🦾', category: 'movement', difficulty: 'Level 2', requires: 'servo',
    description: 'Two small elbow movements between 85 and 100. Clear the arm and claw; these are command values, not joint feedback.',
    blocks: [{ type: 'repeat', times: 2, do: [{ type: 'servo', port: 'S1', angle: 85 }, wait(0.5), { type: 'servo', port: 'S1', angle: 100 }, wait(0.5)] }] },
  { id: 'tmpl_claw_cycle', name: 'Grabber Pulse', icon: '✋', category: 'movement', difficulty: 'Level 2', requires: 'dc_motor',
    description: 'Briefly opens then closes the attached claw. This is not full travel or proof of a successful grasp.',
    blocks: [{ type: 'repeat', times: 1, do: [{ type: 'dc_motor', port: 'M1', speed: -40, duration: 0.2 }, wait(0.5), { type: 'dc_motor', port: 'M1', speed: 40, duration: 0.2 }] }, { type: 'stop' }] },
];

export function resolveTemplateBlocks(template, config) {
  const additions = config?.additions || [];
  const walk = blocks => blocks.map(block => {
    const next = { ...block };
    if (block.type === 'servo' || block.type === 'dc_motor') {
      const device = additions.find(a => a.type === block.type);
      if (device?.port) next.port = device.port;
    }
    for (const key of ['do', 'then', 'else']) if (Array.isArray(block[key])) next[key] = walk(block[key]);
    return next;
  });
  return walk(template.blocks);
}

export function templateUnavailableReason(template, config, status) {
  if (template.unavailable) return template.unavailable;
  if (template.requires && !(config?.additions || []).some(a => a.type === template.requires)) return `Configure the attached ${template.requires === 'servo' ? 'elbow servo' : 'claw motor'} in Setup first.`;
  if (status?.build !== 'mbot-av-control-v1' || !Array.isArray(status.capabilities)) return 'Robot runtime unverified. Connect the supported robot app to check this example.';
  const missing = new Set();
  const visit = blocks => blocks.forEach(b => { if (b.type !== 'repeat' && !status.capabilities.includes(b.type)) missing.add(b.type); if (b.do) visit(b.do); });
  visit(template.blocks);
  return missing.size ? `Robot does not advertise: ${[...missing].join(', ')}.` : '';
}
