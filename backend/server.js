require('dotenv').config();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const winston = require('winston');
const db = require('./db/connection');
const { buildRouter: buildAuthRouter, requireAuth } = require('./routes/auth');
const { buildRouter: buildChannelRouter } = require('./routes/channel');
const { buildRouter: buildStatusRouter } = require('./routes/status');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()]
});

const app = express();
const port = Number(process.env.PORT || 10000);

app.disable('x-powered-by');
app.set('trust proxy', 1);
const allowedOrigins = (process.env.FRONTEND_URL || '').split(',').map((v) => v.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('CORS origin is not allowed'));
  },
  credentials: false
}));
app.use(express.json({ limit: '32kb' }));

const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again shortly.' }
});
const pairingLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Pairing-code rate limit reached. Please wait before requesting another code.' }
});
app.use(globalLimiter);

app.get('/health', async (req, res) => {
  const runtime = await db.getRuntime();
  res.json({ ok: true, service: 'wingo-backend', connected: runtime.connected, time: new Date().toISOString() });
});

app.use('/api/auth', buildAuthRouter(db));
app.post('/api/generate-code', pairingLimiter, async (req, res, next) => {
  try {
    const rawPhone = String(req.body?.phone || '').replace(/\D/g, '');
    if (!/^\d{8,15}$/.test(rawPhone)) {
      return res.status(400).json({ error: 'phone must contain 8 to 15 digits, including country code, without + or spaces' });
    }

    const request = await db.createPairingRequest(rawPhone);
    const deadline = Date.now() + Number(process.env.PAIRING_WAIT_MS || 25_000);
    let result = request;
    while (Date.now() < deadline) {
      result = await db.getPairingRequest(request.id);
      if (!result) break;
      if (result.status === 'ready' && result.code) {
        return res.json({ code: result.code, expiresIn: 60 });
      }
      if (result.status === 'failed') {
        return res.status(500).json({ error: result.error || 'Pairing code generation failed' });
      }
      if (result.status === 'paired') {
        return res.status(409).json({ error: 'WhatsApp is already paired. Open Settings to reconnect or replace the session.' });
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
    return res.status(504).json({ error: 'Pairing worker did not return a code in time. Confirm the Render Worker is running, then retry.' });
  } catch (error) {
    next(error);
  }
});

app.use('/api', buildChannelRouter(db));
app.post('/api/toggle-bot', requireAuth, async (req, res, next) => {
  try {
    const active = req.body?.active;
    if (typeof active !== 'boolean') return res.status(400).json({ error: 'active must be boolean' });
    const settings = await db.updateSettings({ active });
    res.json({ success: true, active: settings.active });
  } catch (error) {
    next(error);
  }
});
app.use('/api', buildStatusRouter(db));

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.use((error, req, res, next) => {
  logger.error('Unhandled request error', { message: error.message, stack: error.stack, path: req.path, method: req.method });
  if (res.headersSent) return next(error);
  res.status(500).json({ error: 'Internal server error' });
});

let server;
async function start() {
  await db.initDb();
  server = app.listen(port, () => logger.info('Backend listening', { port, driver: process.env.DATABASE_URL ? 'postgres' : 'json' }));
}

async function shutdown(signal) {
  logger.info('Shutting down backend', { signal });
  if (server) await new Promise((resolve) => server.close(resolve));
  await db.closeDb();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch((error) => {
  logger.error('Backend failed to start', { message: error.message, stack: error.stack });
  process.exit(1);
});
