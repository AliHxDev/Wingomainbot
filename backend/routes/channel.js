const express = require('express');
const { requireAuth } = require('./auth');

function validateChannelId(channelId) {
  return typeof channelId === 'string' && /^\d+@newsletter$/.test(channelId.trim());
}

function buildRouter(db) {
  const router = express.Router();

  router.post('/set-channel', requireAuth, async (req, res, next) => {
    try {
      const channelId = String(req.body?.channelId || '').trim();
      if (!validateChannelId(channelId)) {
        return res.status(400).json({ error: 'channelId must look like 120363123456789@newsletter' });
      }
      const settings = await db.updateSettings({ channelId });
      res.json({ success: true, channel: settings.channelId });
    } catch (error) {
      next(error);
    }
  });

  router.get('/channel', requireAuth, async (req, res, next) => {
    try {
      const settings = await db.getSettings();
      res.json({ channelId: settings.channelId });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { buildRouter, validateChannelId };
