const express = require('express');
const { requireAuth } = require('./auth');

function buildRouter(db) {
  const router = express.Router();

  router.get('/status', async (req, res, next) => {
    try {
      const [runtime, settings] = await Promise.all([db.getRuntime(), db.getSettings()]);
      const stats = await db.getStats();
      const uptime = runtime.uptimeStartedAt ? Math.max(0, Date.now() - new Date(runtime.uptimeStartedAt).getTime()) : 0;
      res.json({
        connected: Boolean(runtime.connected),
        phone: runtime.phone || '',
        channel: settings.channelId || '',
        uptime,
        botActive: Boolean(settings.active),
        workerBotActive: Boolean(runtime.botActive),
        lastError: runtime.lastError || '',
        confidenceThreshold: settings.confidenceThreshold,
        stats
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/status/stats', requireAuth, async (req, res, next) => {
    try {
      res.json(await db.getStats());
    } catch (error) {
      next(error);
    }
  });

  router.get('/status/signals', requireAuth, async (req, res, next) => {
    try {
      const requestedLimit = Number(req.query.limit || 100);
      const limit = Number.isFinite(requestedLimit) ? Math.min(200, Math.max(1, Math.floor(requestedLimit))) : 100;
      res.json({ signals: await db.listSignals(limit) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/reconnect', requireAuth, async (req, res, next) => {
    try {
      const runtime = await db.updateRuntime({ reconnectRequestedAt: new Date().toISOString() });
      res.json({ success: true, requestedAt: runtime.reconnectRequestedAt });
    } catch (error) {
      next(error);
    }
  });

  router.post('/settings/confidence', requireAuth, async (req, res, next) => {
    try {
      const value = Number(req.body?.confidenceThreshold);
      if (!Number.isFinite(value) || value < 65 || value > 95) {
        return res.status(400).json({ error: 'confidenceThreshold must be between 65 and 95' });
      }
      const settings = await db.updateSettings({ confidenceThreshold: Math.round(value) });
      res.json({ success: true, confidenceThreshold: settings.confidenceThreshold });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { buildRouter };
