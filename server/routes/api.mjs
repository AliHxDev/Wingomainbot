import express from 'express';
import { requireAuth } from '../middleware/auth.mjs';
import { validate } from '../middleware/validation.mjs';
import { pairingSchema, channelSchema, settingsSchema, signalLimitSchema } from '../utils/validation.mjs';
import { pairingLimiter } from '../middleware/security.mjs';
import { getChannelConfig, setChannelRecipients } from '../services/channel.mjs';
import { getSettings, updateSettings } from '../services/settings.mjs';
import { getBotState } from '../services/botState.mjs';
import { getLatestSignal, getStatistics, listSignals } from '../services/signals.mjs';

export function createApiRouter({ whatsapp, bot }) {
  const router = express.Router();
  router.use(requireAuth);

  router.get('/dashboard', async (req,res,next) => {
    try {
      const [settings,channel,botState,statistics,latestSignal,signals] = await Promise.all([
        getSettings(),getChannelConfig(),getBotState(),getStatistics(),getLatestSignal(),listSignals(50)
      ]);
      res.json({settings,channel,bot:botState,whatsapp:whatsapp.getStatus(),statistics,latestSignal,signals});
    } catch(error){next(error);}
  });

  router.get('/settings', async (req,res,next)=>{try{res.json(await getSettings())}catch(e){next(e)}});
  router.put('/settings', validate(settingsSchema), async (req,res,next)=>{try{res.json(await updateSettings(req.body))}catch(e){next(e)}});

  router.get('/channel', async (req,res,next)=>{try{res.json(await getChannelConfig())}catch(e){next(e)}});
  router.put('/channel', validate(channelSchema), async (req,res,next)=>{try{res.json(await setChannelRecipients(req.body.recipients))}catch(e){next(e)}});

  router.get('/bot/status', async (req,res,next)=>{try{res.json(await getBotState())}catch(e){next(e)}});
  router.post('/bot/start', async (req,res,next)=>{try{await bot.start();res.json(await getBotState())}catch(e){next(e)}});
  router.post('/bot/stop', async (req,res,next)=>{try{await bot.stop();res.json(await getBotState())}catch(e){next(e)}});

  router.get('/whatsapp/status', (req,res)=>res.json(whatsapp.getStatus()));
  router.post('/whatsapp/pairing', pairingLimiter, validate(pairingSchema), async (req,res,next)=>{
    try {
      const code = await whatsapp.requestPairingCode(req.body.phoneNumber);
      res.json({ code });
    } catch (error) {
      error.statusCode = 502;
      error.expose = true;
      next(error);
    }
  });
  router.post('/whatsapp/reconnect', async (req,res,next)=>{try{await whatsapp.reconnect();res.json(whatsapp.getStatus())}catch(e){next(e)}});
  router.post('/whatsapp/logout', async (req,res,next)=>{try{await whatsapp.logout();res.json(whatsapp.getStatus())}catch(e){next(e)}});

  router.get('/signals', validate(signalLimitSchema,'query'), async (req,res,next)=>{try{res.json({signals:await listSignals(req.query.limit)})}catch(e){next(e)}});
  router.get('/statistics', async (req,res,next)=>{try{res.json(await getStatistics())}catch(e){next(e)}});

  return router;
}
