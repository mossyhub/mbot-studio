import OpenAI, { AzureOpenAI } from 'openai';

let client = null;

function isAzureOpenAI() {
  return !!(process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_DEPLOYMENT);
}

function getApiKey() {
  return process.env.AI_API_KEY || process.env.GITHUB_TOKEN || '';
}

function getClient() {
  if (!client) {
    if (isAzureOpenAI()) {
      client = new AzureOpenAI({
        endpoint: process.env.AZURE_OPENAI_ENDPOINT,
        apiKey: process.env.AZURE_OPENAI_API_KEY,
        apiVersion: '2024-10-21',
      });
    } else {
      client = new OpenAI({
        baseURL: process.env.AI_BASE_URL || 'https://api.openai.com/v1',
        apiKey: getApiKey(),
      });
    }
  }
  return client;
}

function getCurrentModel() {
  if (isAzureOpenAI()) return process.env.AZURE_OPENAI_DEPLOYMENT;
  return process.env.AI_MODEL || 'gpt-4o';
}

/**
 * Build the system prompt for the calibration teaching assistant.
 * This AI guides the child through measuring the robot's physical behavior.
 */
function buildCalibrationPrompt(robotConfig) {
  const existingCalibrations = robotConfig.calibrations || {};
  const calSummary = Object.keys(existingCalibrations).length > 0
    ? formatExistingCalibrations(existingCalibrations)
    : 'No calibration data yet.';

  return `You are a friendly robot calibration assistant helping an 8-year-old child teach their mBot2 robot about how it moves in the real world.

## Your Role
You guide the child through a fun, conversational process of testing and measuring the robot's movement.
The goal is to collect real-world data so the AI can later convert requests like "move forward 12 inches" into the correct speed and duration.

## How Calibration Works
1. You suggest a test (e.g., "Let's see how far your robot goes at speed 50 for 2 seconds!")
2. You tell the robot to move (by returning a robotCommand)
3. You ask the child to measure the distance with a ruler or tape measure
4. The child reports the measurement
5. You save the data point and suggest the next test
6. After enough data points (3-5 per movement type), you summarize what was learned

## Available Tests
- **Forward movement**: Test different speeds (30, 50, 70) and durations (1s, 2s, 3s) to build a speed/distance model
- **Backward movement**: Same as forward but in reverse
- **Turning**: Test turning at different speeds to measure actual degrees turned
- **Custom hardware**: Any motors or servos attached to the robot

## Response Format
ALWAYS respond with valid JSON in one of these formats:

### When chatting / asking questions / giving instructions:
{"chat": "Your friendly message here", "quickReplies": ["Ready!", "Let me measure", "Skip this"]}

### When you want to run a test on the robot:
{"chat": "Okay! I'm going to move your robot forward at speed 50 for 2 seconds. Watch how far it goes! 🚗💨", "robotCommand": {"type": "move_forward", "speed": 50, "duration": 2}, "quickReplies": ["Tell you the distance", "Do it again", "Try a different speed"]}

### When recording a measurement the child reported:
{"chat": "Awesome! So at speed 50 for 2 seconds, your robot went 14 inches. That's great data! 📊 Ready for the next test?", "calibrationData": {"forward": [{"speed": 50, "duration": 2, "distance_inches": 14}]}, "quickReplies": ["Yes, next test!", "Test same speed again", "I'm done for now"]}

### When calibration session is complete:
{"chat": "Great job! 🎉 Here's what I learned about your robot: At speed 50, it goes about 7 inches per second. Now when you say 'go forward 12 inches', I'll know exactly what to do!", "quickReplies": ["Test something else", "I'm done!"], "summary": true}

## Robot Commands You Can Send
- {"type": "move_forward", "speed": 30-70, "duration": 1-5}
- {"type": "move_backward", "speed": 30-70, "duration": 1-5}
- {"type": "turn_left", "speed": 30-70, "angle": 45-360}
- {"type": "turn_right", "speed": 30-70, "angle": 45-360}
- {"type": "dc_motor", "port": "M3", "speed": -100 to 100, "duration": 0.5-5}
- {"type": "servo", "port": "S1", "angle": 0-180}

## calibrationData Keys
Use these keys when saving measurement data:
- "forward" — forward movement tests
- "backward" — backward movement tests
- "turn_left" — left turn tests
- "turn_right" — right turn tests
- "dc_motor_M3" (or whichever port) — for custom hardware

Each entry should have appropriate fields:
- Forward/backward: {"speed": number, "duration": number, "distance_inches": number}
- Turns: {"speed": number, "requested_angle": number, "actual_angle": number}

## Existing Calibration Data
${calSummary}

## Conversation Rules
1. Be VERY friendly, patient, and encouraging — this is for a young child!
2. Use emojis and fun language
3. Give clear, simple instructions: "Put a piece of tape where the front of the robot is, then tell me to go!"
4. Start with ONE test at a time — don't overwhelm the child
5. When the child says a measurement, parse the number (e.g., "about 14 inches" → 14, "maybe 8 or 9" → 8.5)
6. After 3+ data points for a movement type, you can offer to move on
7. Always offer quickReplies to make it easy for the child to respond
8. If the child says something unrelated, gently guide them back to calibration
9. IMPORTANT: When you say you're going to move the robot, ALWAYS include the robotCommand so it actually moves!
10. If the child asks to stop or says they're done, summarize what was learned
11. Parse measurements flexibly: "14 inches", "about 14", "14 in", "14", "around 14 inches", "14.5" should all work

## Starting a Session
If the child says they want to teach the robot or calibrate, start by explaining the process in a fun way and asking what they want to test first. Suggest starting with forward movement since it's the most useful.`;
}

function formatExistingCalibrations(calibrations) {
  let summary = 'Existing calibration data:\n';
  for (const [key, entries] of Object.entries(calibrations)) {
    if (!entries || entries.length === 0) continue;
    summary += `\n${key}: ${entries.length} data point(s)\n`;
    for (const e of entries) {
      if (e.distance_inches !== undefined) {
        summary += `  - Speed ${e.speed}, ${e.duration}s → ${e.distance_inches} inches\n`;
      } else if (e.actual_angle !== undefined) {
        summary += `  - Speed ${e.speed}, requested ${e.requested_angle}° → actually turned ${e.actual_angle}°\n`;
      }
    }
  }
  return summary;
}

/**
 * Calibration chat — conversational AI that guides the child through robot measurement
 */
export async function calibrationChat(userMessage, robotConfig, conversationHistory = []) {
  const systemPrompt = buildCalibrationPrompt(robotConfig);

  const messages = [
    { role: 'system', content: systemPrompt },
    ...conversationHistory.slice(-20),
    { role: 'user', content: userMessage },
  ];

  try {
    const response = await getClient().chat.completions.create({
      model: getCurrentModel(),
      messages,
      temperature: 0.7,
      max_tokens: 1000,
      response_format: { type: 'json_object' },
    });

    const content = response.choices[0].message.content;
    const parsed = JSON.parse(content);

    return {
      success: true,
      ...parsed,
    };
  } catch (error) {
    console.error('Calibration chat error:', error);
    return {
      success: false,
      chat: "Oops! I had trouble thinking about that. Let's try again! 🤔",
      quickReplies: ["Let's start over", "Try again"],
    };
  }
}

/**
 * Format calibration data for injection into the main AI system prompt.
 * This converts raw data points into human/AI-readable performance specs.
 */
export function formatCalibrationForPrompt(calibrations) {
  if (!calibrations || Object.keys(calibrations).length === 0) return '';

  let text = '\n## Measured Robot Performance (from calibration)\n';
  text += 'The child has measured how this specific robot actually moves. Use these measurements to calculate correct speeds and durations when the child asks for specific distances or angles.\n\n';

  // Forward movement
  if (calibrations.forward && calibrations.forward.length > 0) {
    text += '### Forward Movement\n';
    text += '| Speed | Duration | Distance (inches) | Rate (in/sec) |\n';
    text += '|-------|----------|--------------------|---------------|\n';
    for (const e of calibrations.forward) {
      const rate = (e.distance_inches / e.duration).toFixed(1);
      text += `| ${e.speed} | ${e.duration}s | ${e.distance_inches} in | ${rate} in/s |\n`;
    }
    // Calculate average rate per speed level
    const bySpeed = {};
    for (const e of calibrations.forward) {
      if (!bySpeed[e.speed]) bySpeed[e.speed] = [];
      bySpeed[e.speed].push(e.distance_inches / e.duration);
    }
    text += '\nAverage rates: ';
    for (const [speed, rates] of Object.entries(bySpeed)) {
      const avg = (rates.reduce((a, b) => a + b, 0) / rates.length).toFixed(1);
      text += `speed ${speed} ≈ ${avg} in/s, `;
    }
    text += '\n\n';
    text += 'To move forward X inches at speed S: duration = X / rate_for_speed_S\n';
    text += 'Example: To go 12 inches at speed 50, if rate is 7.0 in/s, use duration = 12/7.0 = 1.7 seconds\n\n';
  }

  // Backward movement
  if (calibrations.backward && calibrations.backward.length > 0) {
    text += '### Backward Movement\n';
    for (const e of calibrations.backward) {
      const rate = (e.distance_inches / e.duration).toFixed(1);
      text += `- Speed ${e.speed}, ${e.duration}s → ${e.distance_inches} in (${rate} in/s)\n`;
    }
    text += '\n';
  }

  // Turn calibration
  if (calibrations.turn_left && calibrations.turn_left.length > 0) {
    text += '### Left Turns\n';
    for (const e of calibrations.turn_left) {
      const ratio = (e.actual_angle / e.requested_angle).toFixed(2);
      text += `- Speed ${e.speed}, requested ${e.requested_angle}° → actually turned ${e.actual_angle}° (ratio: ${ratio})\n`;
    }
    text += 'To turn an exact angle: requested_angle = desired_angle / ratio\n\n';
  }

  if (calibrations.turn_right && calibrations.turn_right.length > 0) {
    text += '### Right Turns\n';
    for (const e of calibrations.turn_right) {
      const ratio = (e.actual_angle / e.requested_angle).toFixed(2);
      text += `- Speed ${e.speed}, requested ${e.requested_angle}° → actually turned ${e.actual_angle}° (ratio: ${ratio})\n`;
    }
    text += 'To turn an exact angle: requested_angle = desired_angle / ratio\n\n';
  }

  text += 'IMPORTANT: Always use these measured values to calculate real-world distances and angles instead of guessing!\n';

  return text;
}
