require('dotenv').config();

const fs = require('fs/promises');
const path = require('path');
const pino = require('pino');
const winston = require('winston');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers
} = require('@whiskeysockets/baileys');
const db = require('./db');
const { fetchHistory, incrementIssueNumber, deriveSize, deriveColor } = require('./wingo-api');
const { predict } = require('./predictor');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.errors({ stack: true }), winston.format.json()),
  transports: [new winston.transports.Console()]
});

const AUTH_DIR = process.env.AUTH_DIR || '/var/data/auth_info_baileys';
const LOOP_MS = Number(process.env.SIGNAL_LOOP_MS || 60_000);
const PAIRING_POLL_MS = Number(process.env.PAIRING_POLL_MS || 1_000);
const CHANNEL_SEND_RETRIES = Number(process.env.CHANNEL_SEND_RETRIES || 3);
const HTTP_RECONNECT_COOLDOWN_MS = Number(process.env.RECONNECT_COOLDOWN_MS || 5_000);

let sock = null;
let authState = null;
let saveCreds = null;
let connected = false;
let reconnecting = false;
let workerStartedAt = null;
let latestRuntime = null;
let stopping = false;
let lastReconnectHandledAt = 0;

const baileysLogger = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'silent' });

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
    `⏱️ Time: ${new Date().toLocaleTimeString('en-GB', { hour12: false })}`,
    '━━━━━━━━━━━━━━━━',
    '⚠️ Play responsibly'
  ].join('\n');
}

function formatResultMessage(signal, result, won) {
  const label = won ? '✅ WIN!' : '❌ LOSS';
  return [
    label,
    `Period: ${result.issueNumber}`,
    `Result: ${result.number} (${result.size}, ${result.color})`,
    `Our Signal: ${signal.predictionSize} ${signal.predictionColor} ${won ? '✅' : '❌'}`
  ].join('\n');
}

async function wipeAuthDirectory() {
  await fs.rm(AUTH_DIR, { recursive: true, force: true });
  await fs.mkdir(AUTH_DIR, { recursive: true });
}

async function createSocket(forceFresh = false) {
  if (forceFresh) await wipeAuthDirectory();
  await fs.mkdir(AUTH_DIR, { recursive: true });
  const state = await useMultiFileAuthState(AUTH_DIR);
  authState = state.state;
  saveCreds = state.saveCreds;
  const newSocket = makeWASocket({
    auth: state.state,
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
    const { connection, lastDisconnect, qr, isNewLogin } = update;
    if (qr) logger.info('WhatsApp QR payload received; QR is intentionally disabled in UI');
    if (isNewLogin) logger.info('WhatsApp new login detected');
    if (connection === 'open') {
      connected = true;
      const phone = getPhoneFromJid(newSocket.user?.id);
      latestRuntime = await db.updateRuntime({ connected: true, phone, botActive: Boolean((await db.getSettings()).active), uptimeStartedAt: workerStartedAt, lastError: '' });
      await db.markLatestPairingPaired(phone);
      logger.info('WhatsApp connection opened', { phone });
    }
    if (connection === 'close') {
      connected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
      await db.updateRuntime({ connected: false, phone: getPhoneFromJid(newSocket.user?.id), lastError: lastDisconnect?.error?.message || `Connection closed (${statusCode || 'unknown'})` });
      logger.warn('WhatsApp connection closed', { statusCode, loggedOut });
      if (!stopping && loggedOut) {
        try {
          await wipeAuthDirectory();
          await reconnectSocket(true);
        } catch (error) {
          logger.error('Failed to rebuild session after logout', { message: error.message, stack: error.stack });
        }
      } else if (!stopping) {
        await sleep(HTTP_RECONNECT_COOLDOWN_MS);
        await reconnectSocket(false);
      }
    }
  });

  return newSocket;
}

async function reconnectSocket(forceFresh) {
  if (reconnecting || stopping) return;
  reconnecting = true;
  try {
    try { sock?.end?.(new Error('reconnecting')); } catch {}
    sock = await createSocket(forceFresh);
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
  throw lastError || new Error('Failed to send channel message');
}

async function processPairingRequest() {
  if (!sock || authState?.creds?.registered) return;
  const request = await db.claimNextPairingRequest();
  if (!request) return;
  try {
    const phone = String(request.phone).replace(/\D/g, '');
    const code = await sock.requestPairingCode(phone);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await db.setPairingResult(request.id, { code, status: 'ready', expiresAt, error: '' });
    logger.info('Pairing code generated', { requestId: request.id });
  } catch (error) {
    await db.setPairingResult(request.id, { status: 'failed', error: error.message || 'Pairing code generation failed' });
    logger.error('Pairing-code generation failed', { requestId: request.id, message: error.message, stack: error.stack });
  }
}

async function processPendingSignals(history) {
  const pending = await db.getPendingSignals();
  if (!pending.length) return;
  const byIssue = new Map(history.map((item) => [item.issueNumber, item]));
  for (const signal of pending) {
    const result = byIssue.get(String(signal.issueNumber));
    if (!result) continue;
    const normalized = {
      issueNumber: result.issueNumber,
      resultNumber: result.number,
      resultSize: deriveSize(result.number),
      resultColor: deriveColor(result.number)
    };
    const won = signal.predictionSize === normalized.resultSize && signal.predictionColor === normalized.resultColor;
    normalized.outcome = won ? 'WIN' : 'LOSS';
    await db.settleSignal(signal.issueNumber, normalized);
    const settings = await db.getSettings();
    if (settings.channelId && connected) {
      await sendChannelMessage(settings.channelId, formatResultMessage(signal, {
        issueNumber: normalized.issueNumber,
        number: normalized.resultNumber,
        size: normalized.resultSize,
        color: normalized.resultColor
      }, won));
    }
    logger.info('Signal settled', { issueNumber: signal.issueNumber, outcome: normalized.outcome });
  }
}

async function generateAndSendSignal(history) {
  const settings = await db.getSettings();
  if (!settings.active || !settings.channelId || !connected) return;
  const pending = await db.getPendingSignals();
  if (pending.length > 0) return;
  if (history.length < 10) return;
  const latest = history[history.length - 1];
  const prediction = predict(history.slice(-30));
  const threshold = Math.max(0, Math.min(100, Number(settings.confidenceThreshold || 65)));
  if (prediction.confidence <= threshold) {
    logger.info('Prediction below threshold; no signal sent', { confidence: prediction.confidence, threshold, latestIssue: latest.issueNumber });
    return;
  }
  const issueNumber = incrementIssueNumber(latest.issueNumber);
  const text = formatSignalMessage({ issueNumber, size: prediction.size, color: prediction.color, confidence: prediction.confidence });
  const messageId = await sendChannelMessage(settings.channelId, text);
  await db.insertSignal({ issueNumber, predictionSize: prediction.size, predictionColor: prediction.color, confidence: prediction.confidence, baseIssue: latest.issueNumber, messageId });
  logger.info('Signal sent', { issueNumber, prediction, baseIssue: latest.issueNumber });
}

async function signalLoop() {
  try {
    await processPairingRequest();
    const settings = await db.getSettings();
    const runtime = await db.getRuntime();
    latestRuntime = runtime;
    if (runtime.reconnectRequestedAt && new Date(runtime.reconnectRequestedAt).getTime() > lastReconnectHandledAt) {
      lastReconnectHandledAt = new Date(runtime.reconnectRequestedAt).getTime();
      await reconnectSocket(false);
    }
    await db.updateRuntime({ botActive: Boolean(settings.active), uptimeStartedAt: workerStartedAt });
    const history = await fetchHistory();
    await processPendingSignals(history);
    await generateAndSendSignal(history);
    const latestIssue = history[history.length - 1]?.issueNumber || '';
    await db.updateRuntime({ lastSeenIssue: latestIssue, lastError: '' });
  } catch (error) {
    logger.error('Signal loop error', { message: error.message, stack: error.stack });
    await db.updateRuntime({ lastError: error.message || 'Unknown worker error' });
  }
}

async function start() {
  workerStartedAt = new Date();
  await db.init();
  await db.updateRuntime({ botActive: Boolean((await db.getSettings()).active), uptimeStartedAt: workerStartedAt, lastError: '' });
  sock = await createSocket(false);
  logger.info('Worker started', { authDir: AUTH_DIR, database: process.env.DATABASE_URL ? 'postgres' : 'json' });

  setInterval(() => processPairingRequest().catch((error) => logger.error('Pairing poll error', { message: error.message })), PAIRING_POLL_MS);
  setInterval(signalLoop, LOOP_MS);
  await signalLoop();
}

async function shutdown(signal) {
  stopping = true;
  logger.info('Worker shutting down', { signal });
  try { sock?.end?.(new Error('shutdown')); } catch {}
  await db.updateRuntime({ connected: false, botActive: false, lastError: `Worker stopped by ${signal}` });
  await db.close();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch(async (error) => {
  logger.error('Worker failed to start', { message: error.message, stack: error.stack });
  try { await db.updateRuntime({ connected: false, botActive: false, lastError: error.message }); } catch {}
  process.exit(1);
});
