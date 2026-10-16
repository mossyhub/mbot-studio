// Bounded programming missions for the installed AV runtime. A completed driver
// sequence verifies code, never distance, heading, joint position, or grip.
export const LEVELS = [
  { id: 1, name: 'Explorer', subtitle: 'Meet your robot · sequences & timing' },
  { id: 2, name: 'Builder', subtitle: 'Make patterns · repeats & numbers' },
  { id: 3, name: 'Inventor', subtitle: 'Think ahead · variables & decisions' },
];
const wait = duration => ({type:'wait',duration});
const forward = duration => ({type:'move_forward',speed:20,duration});
const led = color => ({type:'set_led',color});
const text = text => ({type:'display_text',text,size:16});
const tone = frequency => ({type:'play_tone',frequency,duration:0.2});
const repeat = (times, ...actions) => ({type:'repeat',times,do:actions});
const variable = name => ({type:'var_get',name});
const goal = (label, check) => ({label,check});
const has = (e,type) => e.types.has(type);
const of = (e,type) => e.program.filter(b=>b.type===type);
const duration = b => b.duration ?? 1;
const moving = b => (b.speed ?? 30) > 0 && duration(b) > 0;
const safe = e => e.program.every(b => !['move_forward','move_backward'].includes(b.type) || ((b.speed ?? 30) <= 30 && duration(b) <= 2));
const sequence = (e,types) => { let i=0; for(const b of e.program) if(b.type===types[i]) i++; return i===types.length; };
const motionNote = 'Clear a floor space, keep away from edges, and have Stop ready. Completion confirms commands, not a measured path.';
function mission(id,title,level,icon,description,goals,starter,hint,extra={}) {
  return {id,title,level,stars:level,icon,description,goals,starter,hint,...extra};
}
export const CHALLENGES = [
  mission('ch_forward','First Steps',1,'🚗','Give your robot its first short journey.',[
    goal('Forward at positive speed for 2 seconds total (up to 5).',e=>{const n=of(e,'move_forward').filter(moving).reduce((s,b)=>s+duration(b),0);return n>=2-1e-9&&n<=5;}),
  ],[forward(1)],'Your starter moves for 1 second. Change the duration; or use several short forward moves that add up to 2 seconds.',{safety:motionNote}),
  mission('ch_pause_route','Pause & Return',1,'⏸️','Plan a gentle forward–pause–backward sequence.',[
    goal('Forward, wait at least 0.5 seconds, then backward.',e=>sequence({program:e.program.filter(b=>b.type==='wait'?duration(b)>=0.5:moving(b))},['move_forward','wait','move_backward'])),
    goal('Keep driving speed at most 30 and each drive at most 2 seconds.',safe),
  ],[forward(0.5)],'Add a wait after forward. Then add a short backward move. Reversing does not guarantee the same starting position.',{safety:motionNote}),
  mission('ch_hello_screen','Hello, Screen!',1,'💬','Write a little greeting on CyberPi.',[
    goal('Display a non-empty text message.',e=>of(e,'display_text').some(b=>b.text?.trim())),
    goal('Leave a pause of at least 1 second after the message.',e=>{const i=e.program.findIndex(b=>b.type==='display_text'&&b.text?.trim());return i>=0&&e.program.slice(i+1).some(b=>b.type==='wait'&&duration(b)>=1);}),
  ],[text('Hello!')],'Use a wait after your display text. The LCD shows text; it does not speak it.'),
  mission('ch_led_party','Light Show',1,'💡','Make a three-color signal with time to see each change.',[
    goal('Use at least 3 distinct LED colors.',e=>new Set(of(e,'set_led').map(b=>b.color)).size>=3),
    goal('Pause at least 0.2 seconds between each of the first 3 colors.',e=>{const lights=e.program.map((b,i)=>b.type==='set_led'?i:-1).filter(i=>i>=0);return lights.length>=3&&lights.slice(0,2).every((i,n)=>e.program.slice(i+1,lights[n+1]).some(b=>b.type==='wait'&&duration(b)>=0.2));}),
  ],[led('red')],'Try a color, a short wait, another color, another wait, then your third color.'),
  mission('ch_sound_signal','Sound Signal',1,'🔔','Give your robot a short, friendly sound cue.',[
    goal('Play a positive-duration tone or a built-in sound.',e=>of(e,'play_tone').some(b=>(b.duration??0.5)>0)||has(e,'play_sound')),
    goal('Show a text message after the sound.',e=>{const i=e.program.findIndex(b=>['play_tone','play_sound'].includes(b.type));return i>=0&&e.program.slice(i+1).some(b=>b.type==='display_text'&&b.text?.trim());}),
  ],[tone(440)],'Finish your sound cue with a message such as “Ready”. Keep volume comfortable.'),
  mission('ch_repeat_signal','Signal on Repeat',2,'🔁','Use a bounded repeat to make a signal twice.',[
    goal('Use a repeat that actually runs.',e=>has(e,'repeat')),
    goal('Execute at least 2 LED changes and 2 positive waits.',e=>of(e,'set_led').length>=2&&of(e,'wait').filter(b=>duration(b)>0).length>=2),
  ],[repeat(2,led('green'))],'Put a wait inside the repeat too. A zero-times repeat does not run.'),
  mission('ch_text_frames','Tiny Storyboard',2,'🎞️','Create a readable text-frame animation, not a camera movie.',[
    goal('Show at least 3 different non-empty text frames.',e=>of(e,'display_animation').some(b=>new Set(b.frames.filter(s=>s.trim())).size>=3)),
    goal('Hold every animation frame for at least 0.3 seconds.',e=>of(e,'display_animation').length>0&&of(e,'display_animation').every(b=>(b.interval??0.5)>=0.3)),
  ],[{type:'display_animation',frames:['Ready'],interval:0.5}],'Add two more text frames in the animation block. Each frame costs two robot steps.'),
  mission('ch_two_notes','Two-Note Composer',2,'🎵','Build a small musical question and answer.',[
    goal('Play at least 2 different tone frequencies with positive durations.',e=>new Set(of(e,'play_tone').filter(b=>(b.duration??0.5)>0).map(b=>b.frequency??440)).size>=2),
    goal('Pause between the two tones.',e=>sequence({program:e.program.filter(b=>b.type!=='wait'||duration(b)>0)},['play_tone','wait','play_tone'])),
  ],[tone(440)],'Add a short wait and a tone at a different frequency. Try a higher or lower note.'),
  mission('ch_math_pause','Number Workshop',2,'➕','Calculate a pause instead of typing its answer.',[
    goal('Use +, −, × or ÷ in a reached numeric input.',e=>['op_add','op_sub','op_mul','op_div'].some(t=>has(e,t))),
    goal('Produce a wait of exactly 2 seconds.',e=>of(e,'wait').some(b=>Math.abs(duration(b)-2)<1e-9)),
  ],[wait(1)],'Drop a math reporter into wait’s duration. Choose numbers whose result is 2.'),
  mission('ch_tiny_turns','Turn Sampler',2,'🧭','Compare a small left request and a small right request.',[
    goal('Request both a left and a right turn, each greater than 0 and at most 30.',e=>['turn_left','turn_right'].every(t=>of(e,t).some(b=>b.angle>0&&b.angle<=30))),
    goal('Pause for a positive duration between qualifying turn requests.',e=>{
      const paused={program:e.program.filter(b=>b.type==='wait'?duration(b)>0:['turn_left','turn_right'].includes(b.type)&&b.angle>0&&b.angle<=30)};
      return sequence(paused,['turn_left','wait','turn_right'])||sequence(paused,['turn_right','wait','turn_left']);
    }),
  ],[{type:'turn_left',angle:10}],'Use angle-only turns. A requested angle is not a measured chassis heading.',{safety:motionNote,observation:'Optional observation: did the two turns look similar? Surface slip changes the result. No physical accuracy badge is awarded.'}),
  mission('ch_variable_timing','Memory Maker',3,'🧠','Store a number, update it, and use the new value.',[
    goal('Set and change a static number variable, then read a variable.',e=>has(e,'set_variable')&&has(e,'change_variable')&&has(e,'var_get')),
    goal('Produce waits of both 1 and 2 seconds.',e=>[1,2].every(n=>of(e,'wait').some(b=>duration(b)===n))),
  ],[{type:'set_variable',name:'seconds',source:'number',value:1}],'Use your variable in a wait, change it by 1, then use it in another wait. These numbers are calculated before the robot starts.'),
  mission('ch_static_choice','Choose a Signal',3,'🔀','Make a decision using numbers known before Run.',[
    goal('Evaluate a static if with a numeric comparison.',e=>(has(e,'if_predicate')||has(e,'if_else_predicate'))&&['op_gt','op_lt','op_eq'].some(t=>has(e,t))),
    goal('The chosen branch produces an LED signal and a text message.',e=>e.program.some((b,i)=>b.type==='set_led'&&/\.(then|else)\[/.test(e.paths[i])&&e.program.some((other,j)=>other.type==='display_text'&&other.text?.trim()&&e.paths[j].startsWith(e.paths[i].replace(/\[\d+\]$/, ''))))),
  ],[{type:'if_else_predicate',cond:{type:'op_gt',a:2,b:1},then:[led('green')],else:[]}],'Add a text message to the selected branch. This is a static decision, not live obstacle or sensor control.'),
  mission('ch_nested_pattern','Pattern Architect',3,'🧩','Compose a finite pattern inside another pattern.',[
    goal('Run a repeat inside another repeat.',e=>has(e,'nested_repeat')),
    goal('Produce at least 4 LED changes and 4 positive waits.',e=>of(e,'set_led').length>=4&&of(e,'wait').filter(b=>duration(b)>0).length>=4),
  ],[repeat(2,repeat(2,led('blue')))],'Add a short wait to the inner pattern. Count the expanded steps; stay within 32.'),
  mission('ch_elbow_care','Elbow Check',3,'🦾','Send two nearby S1 elbow commands with a pause.',[
    goal('Command S1 twice with values between 65 and 100, differing by 5–15.',e=>{const a=of(e,'servo').filter(b=>b.port==='S1');return a.length===2&&a.every(b=>b.angle>=65&&b.angle<=100&&(b.speed??0)===0)&&Math.abs(a[0].angle-a[1].angle)>=5&&Math.abs(a[0].angle-a[1].angle)<=15;}),
    goal('Pause at least 0.5 seconds between elbow commands.',e=>sequence({program:e.program.filter(b=>b.type!=='wait'||duration(b)>=0.5)},['servo','wait','servo'])),
  ],[wait(0.5)],'With an adult, check elbow clearance and safe configured values first. Add two nearby S1 commands; servo speed must be 0.',{hardware:{type:'servo',port:'S1'},safety:'Adult supervision: clear the arm and confirm mechanical limits before Run. These values are setup-specific, not measured joint angles.',observation:'Optional observation: describe how the arm moved. Completion verifies the sequence, not its pose.'}),
  mission('ch_claw_pulses','Gentle Claw Pulses',3,'🤏','Try a short close–pause–open command sequence on M1.',[
    goal('M1: one positive close pulse then one negative open pulse; each power 1–20, duration 0.1–0.3 seconds.',e=>{const a=of(e,'dc_motor');return a.length===2&&a.every(b=>b.port==='M1'&&Math.abs(b.speed)>=1&&Math.abs(b.speed)<=20&&duration(b)>=0.1&&duration(b)<=0.3)&&a[0].speed>0&&a[1].speed<0;}),
    goal('Pause at least 0.5 seconds between pulses.',e=>sequence({program:e.program.filter(b=>b.type!=='wait'||duration(b)>=0.5)},['dc_motor','wait','dc_motor'])),
  ],[wait(0.5)],'M1 positive closes; negative opens. Use tiny pulses and never keep driving a stalled claw. This claw has a weak grip.',{hardware:{type:'dc_motor',port:'M1'},safety:'Adult supervision: fingers clear, no object required. Check the mechanism is not at a hard stop. Low-power pulses may not move it.',observation:'Optional observation: did the jaws move? There is no grip-force or grasp confirmation; earning this mission does not prove a pickup.'}),
];
export function challengeAvailability(challenge, config) {
  return challenge.hardware && !config?.additions?.some(a=>a.port===challenge.hardware.port&&a.type===challenge.hardware.type)
    ? `Configure ${challenge.hardware.port} ${challenge.hardware.type === 'servo' ? 'elbow servo' : 'claw motor'} in My Robot first.` : null;
}
export function evaluateChallenge(challenge,evidence,config) {
  return challenge.goals.map(g=>({label:g.label,done:!challengeAvailability(challenge,config)&&Boolean(g.check(evidence))}));
}
// Test fixtures only; never loaded by Start Programming and never submitted to hardware.
export const CHALLENGE_SOLUTIONS = {
  ch_forward:[forward(2)],
  ch_pause_route:[forward(0.5),wait(0.5),{type:'move_backward',speed:20,duration:0.5}],
  ch_hello_screen:[text('Hello!'),wait(1)],
  ch_led_party:[led('red'),wait(0.3),led('green'),wait(0.3),led('blue')],
  ch_sound_signal:[{type:'play_sound',sound:'hello'},text('Ready')],
  ch_repeat_signal:[repeat(2,led('green'),wait(0.3))],
  ch_text_frames:[{type:'display_animation',frames:['Ready','Set','Hello!'],interval:0.5}],
  ch_two_notes:[tone(440),wait(0.2),tone(523)],
  ch_math_pause:[wait({type:'op_add',a:1,b:1})],
  ch_tiny_turns:[{type:'turn_left',angle:10},wait(0.5),{type:'turn_right',angle:10}],
  ch_variable_timing:[{type:'set_variable',name:'seconds',source:'number',value:1},wait(variable('seconds')),{type:'change_variable',name:'seconds',by:1},wait(variable('seconds'))],
  ch_static_choice:[{type:'if_else_predicate',cond:{type:'op_gt',a:2,b:1},then:[led('green'),text('Yes')],else:[led('red')]}],
  ch_nested_pattern:[repeat(2,repeat(2,led('blue'),wait(0.2)))],
  ch_elbow_care:[{type:'servo',port:'S1',angle:80,speed:0},wait(0.5),{type:'servo',port:'S1',angle:90,speed:0}],
  ch_claw_pulses:[{type:'dc_motor',port:'M1',speed:15,duration:0.2},wait(0.5),{type:'dc_motor',port:'M1',speed:-15,duration:0.2}],
};
export const LEGACY_CHALLENGES = {ch_square:'Square Dance',ch_spiral:'Spiral Out',ch_figure8:'Figure Eight',ch_obstacle:'Wall Avoider',ch_line_follow:'Line Follower',ch_guard:'Guard Robot',ch_color_sort:'Color Reporter',ch_dance:'Dance Party',ch_song:'Music Robot',ch_emotions:'Emotional Robot',ch_story:'Story Teller',ch_servo_wave:'Robot Wave',ch_claw_grab:'Grab & Go',ch_counter:'Lap Counter',ch_distance_display:'Distance Dashboard',ch_mood_ring:'Mood Ring Robot',ch_maze:'Maze Runner',ch_timer:'Speed Run',ch_clap:'Clap Control',ch_explorer:'Room Explorer'};
