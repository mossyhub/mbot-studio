import express from 'express';
import { RecordingError, RECORDING_LIMITS } from '../services/recording-service.js';

// Mount before broad /api/robot handlers/body parsers. No singleton or MQTT side effects.
export function createRecordingRoutes({ service }) {
  if (!service) throw new TypeError('Recording service is required');
  const router = express.Router();
  const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });
  router.post('/', express.raw({ type: () => true, limit: RECORDING_LIMITS.uploadBytes, inflate: false }), asyncRoute(async (req, res) => {
    const metadata = await service.create({ audio: req.body, contentType: req.get('Content-Type'), name: req.query.name });
    res.status(201).json(metadata);
  }));
  router.get('/', asyncRoute(async (_req, res) => res.json({ recordings: await service.list() })));
  router.get('/:id/audio', asyncRoute(async (req, res) => {
    const { audio } = await service.getAsset(req.params.id);
    res.type('audio/mpeg').send(audio);
  }));
  router.post('/:id/sync', asyncRoute(async (req, res) => {
    const controller = new AbortController();
    const cancel = () => controller.abort(new RecordingError('recording_sync_canceled', 'Recording sync request canceled.', 409));
    const close = () => { if (!res.writableEnded) cancel(); };
    // Own the request BEFORE any asynchronous local asset read starts.
    req.once('aborted', cancel);
    res.once('close', close);
    try {
      if (req.aborted || res.destroyed) cancel();
      const metadata = await service.sync(req.params.id, { signal: controller.signal });
      if (!controller.signal.aborted) res.json(metadata);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      req.off('aborted', cancel);
      res.off('close', close);
    }
  }));
  router.delete('/:id', asyncRoute(async (req, res) => res.json(await service.delete(req.params.id))));
  router.use((error, _req, res, _next) => {
    if (error.type === 'entity.too.large') error = new RecordingError('recording_upload_too_large', 'Recording upload exceeds 1 MiB.', 413);
    else if (error.type === 'encoding.unsupported') error = new RecordingError('recording_encoding_unsupported', 'Compressed HTTP bodies are not supported.', 415);
    if (error instanceof RecordingError) return res.status(error.status).json({ error: error.message, code: error.code });
    // Never expose ffmpeg stderr, local filesystem paths, raw recordings or internal exceptions.
    return res.status(500).json({ error: 'Recording operation failed.', code: 'recording_internal_error' });
  });
  return router;
}
