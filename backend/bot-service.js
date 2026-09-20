const pino = require('pino');
const winston = require('winston');
const {
  default: makeWASocket,
  DisconnectReason,
  Browsers,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const authStore = require('./auth-store');
const { fetchHistory, incrementIssueNumber, deriveSize, deriveColor } = require('./wingo-api');
const { predict } = require('./predictor');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()]
});

const baileysLogger = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'silent' });
const LOOP_MS = Number(process.env.SIGNAL_LOOP_MS || 60_000);
const PAIRING_POLL_MS = Number(process.env.PAIRING_POLL_MS || 1_000);
const CHANNEL_SEND_RETRIES = Number(process.env.CHANNEL_SEND_RETRIES || 3);
const RECONNECT_COOLDOWN_MS = Number(process.env.RECONNECT_COOLDOWN_MS || 5_000);

let sock = null;
let connected = false;
let reconnecting = false;
let stopping = false;
let startedAt = null;
let lastReconnectHandledAt = 0;
let registered = false;
let loopTimer = null;
let pairingTimer = null;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function getPhoneFromJid(jid) {
  if (!jid) return '';
  return String(jid).split(':')[0].split('@')[0];
}

function formatSignalMessage({ issueNumber, size, color, confidence }) {
  const sizeEmoji = size === 'BIG' ? '📈' : '📉';
  const colorEmoji = color === 'GREEN' ? '🟢' : '🔴';
  return [
    '🎯 WinGo 1M Signal',
    '━━━━━━━━━━━━━━━━',
    `📊 Period: ${issueNumber}`,
    `🎲 Prediction: ${size} ${sizeEmoji}`,
    `🎨 Color: ${color} ${colorEmoji}`,
    `📈 Confidence: ${confidence}%`,
    `⏱️ Time: ${new Date().toLocaleTimeString('en-GB', { hour12: false, timeZone: process.env.TIME_ZONE || 'UTC' })}`,
    '━━━━━━━━━━━━━━━━',
    '⚠️ Play responsibly'
  ].join('\n');
}

function formatResultMessage(signal, result, won) {
  return [
    won ? '✅ WIN!' : '❌ LOSS',
    `Period: ${result.issueNumber}`,
    `Result: ${result.number} (${result.size}, ${result.color})`,
    `Our Signal: ${signal.predictionSize} ${signal.predictionColor} ${won ? '✅' : '❌'}`
  ].join('\n');
}

async function updateRuntime(db, patch) {
  try { await db.updateRuntime(patch); } catch (error) {
    logger.error('Runtime state update failed', { message: error.message });
  }
}

async function createSocket(db) {
  const { state, saveCreds } = await authStore.getAuthState();
  registered = Boolean(state.creds.registered);
  const newSocket = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, baileysLogger)
    },
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    logger: baileysLogger,
    connectTimeoutMs: 30_000,
    defaultQueryTimeoutMs: 30_000,
    keepAliveIntervalMs: 15_000,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    syncFullHistory: false
  });

  newSocket.ev.on('creds.update', saveCreds);
  newSocket.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, isNewLogin } = update;
    if (isNewLogin) logger.info('WhatsApp new login detected');

    if (connection === 'open') {
      connected = true;
      registered = true;
      const phone = getPhoneFromJid(newSocket.user?.id);
      const settings = await db.getSettings();
      await updateRuntime(db, {
        connected: true,
        phone,
        botActive: Boolean(settings.active),
        uptimeStartedAt: startedAt,
        lastError: ''
      });
      await db.markLatestPairingPaired(phone);
      logger.info('WhatsApp connection opened', { phone });
    }

    if (connection === 'close') {
      connected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
      await updateRuntime(db, {
        connected: false,
        phone: getPhoneFromJid(newSocket.user?.id),
        lastError: lastDisconnect?.error?.message || `Connection closed (${statusCode || 'unknown'})`
      });
      logger.warn('WhatsApp connection closed', { statusCode, loggedOut });
      if (!stopping) {
        if (loggedOut) {
          await authStore.clear();
          await reconnectSocket(db);
        } else {
          await sleep(RECONNECT_COOLDOWN_MS);
          await reconnectSocket(db);
        }
      }
    }
  });

  return newSocket;
}

async function reconnectSocket(db) {
  if (reconnecting || stopping) return;
  reconnecting = true;
  try {
    try { sock?.end?.(new Error('reconnecting')); } catch {}
    sock = await createSocket(db);
  } catch (error) {
    await updateRuntime(db, { connected: false, lastError: error.message || 'WhatsApp reconnect failed' });
    logger.error('WhatsApp reconnect failed', { message: error.message, stack: error.stack });
  } finally {
    reconnecting = false;
  }
}

async function sendChannelMessage(channelId, text) {
  if (!sock || !connected) throw new Error('WhatsApp is not connected');
  let lastError = null;
  for (let attempt = 1; attempt <= CHANNEL_SEND_RETRIES; attempt += 1) {
    try {
      const result = await sock.sendMessage(channelId, { text });
      return result?.key?.id || '';
    } catch (error) {
      lastError = error;
      if (attempt < CHANNEL_SEND_RETRIES) await sleep(800 * attempt);
    }
  }
  throw lastError || new Error('Failed to send WhatsApp channel message');
}

async function processPairingRequest(db) {
  const runtime = await db.getRuntime();
  if (runtime.connected || registered || !sock) return;
  const request = await db.claimNextPairingRequest();
  if (!request) return;
  try {
    const phone = String(request.phone).replace(/\D/g, '');
    const code = await sock.requestPairingCode(phone);
    await db.setPairingResult(request.id, {
      code,
      status: 'ready',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      error: ''
    });
    logger.info('WhatsApp pairing code generated', { requestId: request.id });
  } catch (error) {
    await db.setPairingResult(request.id, { status: 'failed', error: error.message || 'Pairing code generation failed' });
    logger.error('Pairing-code generation failed', { requestId: request.id, message: error.message, stack: error.stack });
  }
}

async function processPendingSignals(db, history) {
  const pending = await db.getPendingSignals();
  if (!pending.length) return;
  const byIssue = new Map(history.map((item) => [String(item.issueNumber), item]));
  for (const signal of pending) {
    const result = byIssue.get(String(signal.issueNumber));
    if (!result) continue;
    const normalized = {
      issueNumber: result.issueNumber,
      number: result.number,
      size: deriveSize(result.number),
      color: deriveColor(result.number)
    };
    const won = signal.predictionSize === normalized.size && signal.predictionColor === normalized.color;
    await db.settleSignal(signal.issueNumber, {
      resultNumber: normalized.number,
      resultSize: normalized.size,
      resultColor: normalized.color,
      outcome: won ? 'WIN' : 'LOSS'
    });
    const settings = await db.getSettings();
    if (settings.channelId && connected) {
      try {
        await sendChannelMessage(settings.channelId, formatResultMessage(signal, normalized, won));
      } catch (error) {
        logger.error('Failed to send result message', { issueNumber: signal.issueNumber, message: error.message });
      }
    }
  }
}

async function generateAndSendSignal(db, history) {
  const settings = await db.getSettings();
  if (!settings.active || !settings.channelId || !connected || history.length < 10) return;
  const pending = await db.getPendingSignals();
  if (pending.length > 0) return;

  const latest = history[history.length - 1];
  const prediction = predict(history.slice(-30));
  const threshold = Math.max(65, Math.min(95, Number(settings.confidenceThreshold || 65)));
  if (prediction.confidence <= threshold) return;

  const issueNumber = incrementIssueNumber(latest.issueNumber);
  const existing = await db.getSignalByIssue(issueNumber);
  if (existing) return;

  const messageId = await sendChannelMessage(settings.channelId, formatSignalMessage({
    issueNumber,
    size: prediction.size,
    color: prediction.color,
    confidence: prediction.confidence
  }));
  await db.insertSignal({
    issueNumber,
    predictionSize: prediction.size,
    predictionColor: prediction.color,
    confidence: prediction.confidence,
    baseIssue: latest.issueNumber,
    messageId
  });
  logger.info('WinGo signal sent', { issueNumber, prediction, baseIssue: latest.issueNumber });
}

async function signalLoop(db) {
  try {
    await processPairingRequest(db);
    const settings = await db.getSettings();
    const runtime = await db.getRuntime();
    if (runtime.reconnectRequestedAt) {
      const requestedAt = new Date(runtime.reconnectRequestedAt).getTime();
      if (requestedAt > lastReconnectHandledAt) {
        lastReconnectHandledAt = requestedAt;
        await updateRuntime(db, { reconnectRequestedAt: null });
        await reconnectSocket(db);
      }
    }
    await updateRuntime(db, { botActive: Boolean(settings.active), uptimeStartedAt: startedAt });
    const history = await fetchHistory();
    await processPendingSignals(db, history);
    await generateAndSendSignal(db, history);
    await updateRuntime(db, { lastSeenIssue: history[history.length - 1]?.issueNumber || '', lastError: '' });
  } catch (error) {
    logger.error('Signal loop error', { message: error.message, stack: error.stack });
    await updateRuntime(db, { lastError: error.message || 'Unknown bot error' });
  }
}

async function start(db) {
  startedAt = new Date();
  await authStore.init();
  sock = await createSocket(db);
  await updateRuntime(db, {
    connected: false,
    botActive: Boolean((await db.getSettings()).active),
    uptimeStartedAt: startedAt,
    lastError: ''
  });

  pairingTimer = setInterval(() => processPairingRequest(db).catch((error) => logger.error('Pairing poll error', { message: error.message })), PAIRING_POLL_MS);
  loopTimer = setInterval(() => signalLoop(db), LOOP_MS);
  await signalLoop(db);
  logger.info('Integrated WhatsApp bot started', { database: process.env.DATABASE_URL ? 'postgres' : 'json' });
}

async function stop(db, signal = 'shutdown') {
  stopping = true;
  if (pairingTimer) clearInterval(pairingTimer);
  if (loopTimer) clearInterval(loopTimer);
  try { sock?.end?.(new Error('shutdown')); } catch {}
  await updateRuntime(db, { connected: false, botActive: false, lastError: `Bot stopped by ${signal}` });
  await authStore.close();
}

module.exports = { start, stop, reconnectSocket };
