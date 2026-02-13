import { Router } from 'express';
import { generateProgram, chatWithAI, fetchAvailableModels, getModel, setModel } from '../services/ai-service.js';
import { blocksToMicroPython } from '../services/code-generator.js';
import { loadConfig } from './config.js';
import { MqttService } from '../services/mqtt-service.js';
import { SessionStore } from '../services/session-store.js';
import { getSessionId, validateBlocks, validateMessage } from '../services/validation.js';

export const aiRoutes = Router();

const conversations = new SessionStore({
  maxMessagesPerSession: 20,
  maxSessions: 200,
});

/**
 * GET /api/ai/models
 * List available AI models from GitHub Models API
 */
aiRoutes.get('/models', async (req, res) => {
  try {
    const models = await fetchAvailableModels();
    res.json({ models, current: getModel() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/ai/model
 * Get the currently active model
 */
aiRoutes.get('/model', (req, res) => {
  res.json({ model: getModel() });
});

/**
 * PUT /api/ai/model
 * Switch the active AI model
 */
aiRoutes.put('/model', (req, res) => {
  const { model } = req.body;
  if (!model) {
    return res.status(400).json({ error: 'model is required' });
  }
  setModel(model);
  res.json({ success: true, model: getModel() });
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

    const hardwareStates = MqttService.getInstance().getHardwareStates();
    const result = await generateProgram(msgValidation.value, robotConfig, history, validatedCurrentBlocks, hardwareStates);

    conversations.append(sessionId, [
      { role: 'user', content: msgValidation.value },
      { role: 'assistant', content: JSON.stringify(result) },
    ]);

    // If we got a program, update assumed states for any actions that have targetState
    if (result.program) {
      const mqtt = MqttService.getInstance();
      for (const block of result.program) {
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
      result.pythonCode = blocksToMicroPython(result.program, robotConfig);
    }

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

    const hardwareStates = MqttService.getInstance().getHardwareStates();
    const result = await chatWithAI(msgValidation.value, robotConfig, history, hardwareStates);

    conversations.append(sessionId, [
      { role: 'user', content: msgValidation.value },
      { role: 'assistant', content: JSON.stringify(result) },
    ]);

    // If AI decided to generate a program, include Python code too
    if (result.program) {
      result.pythonCode = blocksToMicroPython(result.program, robotConfig);
    }

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
    const code = blocksToMicroPython(blocksValidation.value, robotConfig);
    res.json({ code });
  } catch (error) {
    res.status(500).json({ error: error.message });
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
