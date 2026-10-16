import { Router } from 'express';
import { generateProgram, chatWithAI, getAiDiagnostics, getModel } from '../services/ai-service.js';
import { programToMicroPython } from '../services/code-generator.js';
import { loadConfig } from './config.js';
import { MqttService } from '../services/mqtt-service.js';
import { SessionStore } from '../services/session-store.js';
import { getSessionId, validateBlocks, validateMessage } from '../services/validation.js';

// Use the same compiler and installed-runtime admission as Run. This is only
// a preview: never publish, repair returned parameters, or infer execution.
function preflightGeneratedProgram(result, mqtt, robotConfig) {
  if (!Object.hasOwn(result, 'program')) return result;
  const status = mqtt.getRobotStatus();
  if (status.application !== 'cooperative-v1' || status.build !== 'mbot-av-control-v1') {
    return result.program ? { ...result, pythonCode: programToMicroPython(result.program, robotConfig, mqtt) } : result;
  }
  try {
    return { ...result, pythonCode: programToMicroPython(result.program, robotConfig, mqtt) };
  } catch (error) {
    if (error.code === 'PYTHON_PREVIEW_UNAVAILABLE') {
      // Admission succeeded; preserve the usable editor proposal, but never
      // substitute a comment-only/legacy export for managed AV behavior.
      const { pythonCode, ...proposal } = result;
      return { ...proposal, previewUnavailable: { code: error.code, reason: error.message } };
    }
    const { program, pythonCode, explanation, ...rest } = result;
    return { ...rest, success: false, runnable: false, rejectedProgram: program,
      error: error.message,
      chat: `I couldn't make a runnable program for this robot: ${error.message}. No program was changed or run.`,
      errors: [{ code: error.code || 'PROGRAM_INVALID', message: error.message,
        sourceId: error.sourceId ?? null, path: error.path ?? 'program' }],
    };
  }
}

export const aiRoutes = Router();

const conversations = new SessionStore({
  maxMessagesPerSession: 20,
  maxSessions: 200,
});

/**
 * GET /api/ai/model
 * Get the currently active model
 */
aiRoutes.get('/model', (req, res) => {
  res.json({ model: getModel() });
});

/**
 * GET /api/ai/diagnostics
 * Debug helper for AI connectivity and mode
 */
aiRoutes.get('/diagnostics', (req, res) => {
  res.json(getAiDiagnostics());
});

/**
 * POST /api/ai/generate
 * Generate a block program from natural language
 */
aiRoutes.post('/generate', async (req, res) => {
  try {
    const { message, currentBlocks } = req.body;
    const sessionId = getSessionId(req.body?.sessionId, 'default');

    const msgValidation = validateMessage(message);
    if (!msgValidation.ok) {
      return res.status(400).json({ error: msgValidation.error });
    }

    let validatedCurrentBlocks = null;
    if (currentBlocks !== undefined) {
      const blocksValidation = validateBlocks(currentBlocks, 'currentBlocks');
      if (!blocksValidation.ok) {
        return res.status(400).json({ error: blocksValidation.error });
      }
      validatedCurrentBlocks = blocksValidation.value;
    }

    const robotConfig = loadConfig();
    const history = conversations.get(sessionId);

    const mqtt = MqttService.getInstance();
    const hardwareStates = mqtt.getHardwareStates();
    const result = preflightGeneratedProgram(await generateProgram(msgValidation.value, robotConfig, history, validatedCurrentBlocks, hardwareStates, mqtt.getRobotStatus()), mqtt, robotConfig);

    // Home actions are prepended in robot.js when the program is sent to the robot.
    // Do NOT add them here — it would cause double homing.

    // If we got a program, update assumed states for any actions that have targetState
    if (result.program) {
      const mqtt = MqttService.getInstance();
      // Generation is not execution. Retain legacy assumptions only for the
      // unknown/legacy runtime; cooperative hardware state is device-owned.
      for (const block of mqtt.isCooperativeApp() ? [] : result.program) {
        if (block.type === 'dc_motor' && block.port) {
          // Find the matching action in config to get targetState
          const addition = robotConfig.additions?.find(a => a.port === block.port);
          if (addition?.actions) {
            for (const action of addition.actions) {
              const dir = action.motorDirection || 'forward';
              const spd = action.speed || 50;
              const signedSpeed = dir === 'reverse' ? -spd : spd;
              // Match by speed/duration signature
              if (signedSpeed === block.speed && action.targetState) {
                mqtt.setHardwareState(block.port, action.targetState, action.name);
                break;
              }
            }
          }
        }
      }
    }

    // A proposal is recorded only after its preview has been constructed.
    if (!result.previewUnavailable) conversations.append(sessionId, [
      { role: 'user', content: msgValidation.value },
      { role: 'assistant', content: JSON.stringify(result) },
    ]);
    res.json(result);
  } catch (error) {
    console.error('Generate error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/ai/chat
 * Chat with the AI assistant
 */
aiRoutes.post('/chat', async (req, res) => {
  try {
    const { message } = req.body;
    const sessionId = getSessionId(req.body?.sessionId, 'default');

    const msgValidation = validateMessage(message);
    if (!msgValidation.ok) {
      return res.status(400).json({ error: msgValidation.error });
    }

    const robotConfig = loadConfig();
    const history = conversations.get(sessionId);

    const mqtt = MqttService.getInstance();
    const hardwareStates = mqtt.getHardwareStates();
    const result = preflightGeneratedProgram(await chatWithAI(msgValidation.value, robotConfig, history, hardwareStates, mqtt.getRobotStatus()), mqtt, robotConfig);

    // A proposal is recorded only after its preview has been constructed.
    if (!result.previewUnavailable) conversations.append(sessionId, [
      { role: 'user', content: msgValidation.value },
      { role: 'assistant', content: JSON.stringify(result) },
    ]);
    res.json(result);
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/ai/blocks-to-code
 * Convert block JSON to MicroPython code (for when user edits blocks manually)
 */
aiRoutes.post('/blocks-to-code', (req, res) => {
  try {
    const { blocks } = req.body;
    const blocksValidation = validateBlocks(blocks, 'blocks');
    if (!blocksValidation.ok) {
      return res.status(400).json({ error: blocksValidation.error });
    }
    const robotConfig = loadConfig();
    const code = programToMicroPython(blocksValidation.value, robotConfig, MqttService.getInstance());
    res.json({ code });
  } catch (error) {
    res.status(error.status || 422).json({ error: error.message, errorCode: error.code || 'PYTHON_PREVIEW_UNAVAILABLE' });
  }
});

/**
 * POST /api/ai/clear
 * Clear conversation history
 */
aiRoutes.post('/clear', (req, res) => {
  const sessionId = getSessionId(req.body?.sessionId, 'default');
  conversations.clear(sessionId);
  res.json({ success: true });
});
