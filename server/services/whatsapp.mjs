import * as Baileys from '@whiskeysockets/baileys';

const makeWASocket = typeof Baileys.default === 'function'
  ? Baileys.default
  : typeof Baileys.default?.default === 'function'
    ? Baileys.default.default
    : Baileys.makeWASocket;

const Browsers = Baileys.Browsers;
const DisconnectReason = Baileys.DisconnectReason;

if (typeof makeWASocket !== 'function') {
  throw new Error('Baileys makeWASocket export is unavailable. Check the installed @whiskeysockets/baileys version.');
}
import { query } from '../db/index.mjs';
import { env } from '../config/env.mjs';
import { logger } from '../utils/logger.mjs';
import { createDatabaseAuthState } from './whatsappAuth.mjs';
import { getChannelConfig } from './channel.mjs';
import { patchBotState } from './botState.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function safeErrorMessage(error) {
  if (!error) return 'Unknown WhatsApp error';
  const message = String(error.message || error);
  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}

export class WhatsAppManager {
  constructor() {
    this.socket = null;
    this.auth = null;
    this.creating = null;
    this.pairingPromise = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.lastPairingCode = null;
    this.status = 'disconnected';
    this.lastError = null;
    this.phone = null;
    this.stopped = false;
    this.pairingActive = false;
    this.pairingExpiresTimer = null;
    this.pairingRecoveryAttempts = 0;
    this.pairingRecoveryTimer = null;
  }

  async init() {
    this.stopped = false;
    await this.restore();
  }

  async restore() {
    const { rows } = await query('SELECT creds FROM whatsapp_auth WHERE id=1');
    const hasCreds = Boolean(rows[0]?.creds);
    if (hasCreds) await this.ensureSocket('restore');
    else await patchBotState({ status: 'disconnected', lastError: null });
  }

  getStatus() {
    return {
      status: this.status,
      phone: this.phone,
      connected: this.status === 'open',
      lastError: this.lastError,
      pairingCode: this.lastPairingCode,
      reconnectAttempt: this.reconnectAttempt,
    };
  }

  async ensureSocket(reason = 'manual') {
    if (this.stopped) return null;
    if (this.socket) return this.socket;
    if (this.creating) return this.creating;
    this.creating = this._createSocket(reason).finally(() => { this.creating = null; });
    return this.creating;
  }

  async _createSocket(reason) {
    this.auth = await createDatabaseAuthState();
    this.status = 'connecting';
    this.lastError = null;
    await patchBotState({ status: 'connecting', lastError: null });

    // Persist freshly-created credentials immediately. This is important on
    // ephemeral Render instances because the first pairing attempt can happen
    // before Baileys emits a creds.update event.
    await this.auth.saveCreds();

    const socket = makeWASocket({
      auth: this.auth.state,
      printQRInTerminal: false,
      browser: Browsers.macOS('Desktop'),
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: 30_000,
      defaultQueryTimeoutMs: 30_000,
      logger,
    });

    this.socket = socket;
    socket.ev.on('creds.update', this.auth.saveCreds);
    socket.ev.on('connection.update', update => this._handleConnectionUpdate(update, socket, reason).catch(error => logger.error({ err: error }, 'WhatsApp connection handler failed')));
    logger.info({ reason }, 'WhatsApp socket created');
    return socket;
  }

  async _handleConnectionUpdate(update, socket, reason) {
    if (socket !== this.socket) return;
    const { connection, lastDisconnect } = update;
    if (update.qr) logger.debug('Baileys emitted QR data; QR terminal display remains disabled');

    if (connection === 'open') {
      this.status = 'open';
      this.reconnectAttempt = 0;
      this.lastError = null;
      this.lastPairingCode = null;
      this.pairingActive = false;
      this.pairingRecoveryAttempts = 0;
      if (this.pairingRecoveryTimer) clearTimeout(this.pairingRecoveryTimer);
      this.pairingRecoveryTimer = null;
      this.clearPairingExpiry();
      this.phone = socket.user?.id?.split(':')[0] || socket.user?.id || null;
      await patchBotState({ status: 'open', connectedAt: new Date().toISOString(), lastError: null });
      logger.info({ phone: this.phone }, 'WhatsApp connection opened');
      return;
    }

    if (connection !== 'close') return;

    const statusCode = lastDisconnect?.error?.output?.statusCode;
    const loggedOut = statusCode === DisconnectReason.loggedOut;
    const badSession = statusCode === DisconnectReason.badSession;
    const restartRequired = statusCode === DisconnectReason.restartRequired;
    this.status = 'disconnected';
    this.lastError = safeErrorMessage(lastDisconnect?.error) || `Disconnected (${statusCode ?? 'unknown'})`;
    await patchBotState({ status: loggedOut ? 'logged_out' : 'disconnected', lastError: this.lastError });
    this.socket = null;
    this.phone = this.pairingActive ? this.phone : null;

    if (loggedOut || badSession) {
      if (this.auth) await this.auth.clear().catch(error => logger.error({ err: error }, 'Failed clearing WhatsApp auth state'));
      this.auth = null;
      this.lastPairingCode = null;
      logger.warn({ statusCode }, 'WhatsApp auth state invalid; pairing is required again');
      return;
    }

    if (this.stopped || this.pairingPromise) return;
    if (this.pairingActive) {
      this.schedulePairingRecovery(reason, statusCode);
      return;
    }
    if (restartRequired) {
      this.reconnectAttempt = 0;
      await this.ensureSocket('restart-required');
      return;
    }
    this.scheduleReconnect(reason);
  }

  schedulePairingRecovery(reason = 'pairing-disconnect', statusCode = null) {
    if (this.pairingRecoveryTimer || !this.pairingActive || this.stopped) return;
    if (this.pairingRecoveryAttempts >= 3) {
      this.pairingActive = false;
      this.lastPairingCode = null;
      this.lastError = `WhatsApp pairing connection closed (${statusCode ?? 'unknown'}). Generate a new code.`;
      this.status = 'disconnected';
      patchBotState({ status: 'disconnected', lastError: this.lastError }).catch(error => logger.warn({ err: error }, 'Failed updating pairing recovery state'));
      return;
    }
    this.pairingRecoveryAttempts += 1;
    const delay = Math.min(10000, 2000 * this.pairingRecoveryAttempts);
    logger.warn({ reason, statusCode, attempt: this.pairingRecoveryAttempts, delay }, 'Pairing socket closed; refreshing pairing code');
    this.pairingRecoveryTimer = setTimeout(async () => {
      this.pairingRecoveryTimer = null;
      if (!this.pairingActive || this.stopped || !this.phone) return;
      const phoneNumber = this.phone;
      try {
        this.auth = null;
        this.socket = null;
        const socket = await this.ensureSocket('pairing-recovery');
        if (!socket) throw new Error('Unable to recreate WhatsApp pairing socket');
        await sleep(4000);
        if (socket !== this.socket || !this.pairingActive) return;
        const code = await socket.requestPairingCode(phoneNumber);
        if (!code) throw new Error('WhatsApp returned an empty pairing code during recovery');
        this.lastPairingCode = code;
        this.lastError = null;
        this.status = 'pairing';
        this.armPairingExpiry();
        await patchBotState({ status: 'pairing', lastError: null });
        logger.info({ phone: phoneNumber, attempt: this.pairingRecoveryAttempts }, 'WhatsApp pairing code refreshed');
      } catch (error) {
        this.lastError = safeErrorMessage(error);
        logger.warn({ err: error, attempt: this.pairingRecoveryAttempts }, 'WhatsApp pairing-code recovery failed');
        this.socket = null;
        this.auth = null;
        this.schedulePairingRecovery('recovery-failed', null);
      }
    }, delay);
  }

  scheduleReconnect(reason = 'disconnect') {
    if (this.reconnectTimer || this.stopped || this.socket || this.pairingPromise) return;
    this.reconnectAttempt += 1;
    const max = env.WA_RECONNECT_MAX_BACKOFF_MS;
    const delay = Math.min(max, 1000 * (2 ** Math.min(this.reconnectAttempt - 1, 5)));
    logger.warn({ reason, reconnectAttempt: this.reconnectAttempt, delay }, 'Scheduling WhatsApp reconnect');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.ensureSocket('backoff-reconnect').catch(error => logger.error({ err: error }, 'WhatsApp reconnect failed'));
    }, delay);
  }

  async requestPairingCode(phoneNumber) {
    this.stopped = false;
    if (this.pairingPromise) return this.pairingPromise;
    if (this.socket && this.status === 'open') {
      throw new Error('WhatsApp is already connected; use Logout WhatsApp before pairing another number.');
    }

    const normalized = String(phoneNumber).replace(/\D/g, '');
    if (!/^\d{8,15}$/.test(normalized)) throw new Error('Use the full international phone number without + or punctuation.');

    this.pairingPromise = this._requestPairingCode(normalized).finally(() => { this.pairingPromise = null; });
    return this.pairingPromise;
  }

  async _requestPairingCode(phoneNumber) {
    this.clearReconnectTimer();
    this.lastPairingCode = null;
    this.lastError = null;
    this.phone = phoneNumber;
    this.pairingActive = false;
    this.pairingRecoveryAttempts = 0;
    if (this.pairingRecoveryTimer) clearTimeout(this.pairingRecoveryTimer);
    this.pairingRecoveryTimer = null;
    this.clearPairingExpiry();

    // A previous interrupted pairing can leave an unregistered credential
    // record and a half-open socket. Start pairing from a clean auth state.
    if (this.auth && !this.auth.state.creds.registered) {
      await this.auth.clear().catch(error => logger.warn({ err: error }, 'Failed clearing previous pairing state'));
    }
    if (this.socket) {
      const old = this.socket;
      this.socket = null;
      try { old.ev?.removeAllListeners?.('creds.update'); old.ev?.removeAllListeners?.('connection.update'); old.ws?.close(); } catch {}
    }
    this.auth = null;

    let lastError = null;
    const delays = [3000, 5000, 8000];

    for (let attempt = 1; attempt <= delays.length; attempt += 1) {
      const socket = await this.ensureSocket('pairing');
      if (!socket) {
        lastError = new Error('Unable to create WhatsApp socket');
        continue;
      }

      // Baileys pairing registration must be requested after the socket has
      // had time to complete its initial WebSocket handshake. Render cold
      // starts are slower than local development, so use bounded retries.
      await sleep(delays[attempt - 1]);
      if (socket !== this.socket) {
        lastError = new Error('WhatsApp socket changed during pairing initialization');
        continue;
      }

      try {
        if (this.auth?.state?.creds?.registered) {
          throw new Error('Existing WhatsApp credentials are already registered; logout and pair again.');
        }

        const code = await socket.requestPairingCode(phoneNumber);
        if (!code) throw new Error('WhatsApp returned an empty pairing code');

        this.lastPairingCode = code;
        this.lastError = null;
        this.status = 'pairing';
        this.pairingActive = true;
        this.pairingRecoveryAttempts = 0;
        this.armPairingExpiry();
        await patchBotState({ status: 'pairing', lastError: null });
        logger.info({ phone: phoneNumber, attempt }, 'WhatsApp pairing code generated');
        return code;
      } catch (error) {
        lastError = error;
        this.lastError = safeErrorMessage(error);
        logger.warn({ err: error, attempt, phone: phoneNumber }, 'WhatsApp pairing-code request failed');

        const failedSocket = this.socket;
        this.socket = null;
        this.auth = null;
        try {
          failedSocket?.ev?.removeAllListeners?.('creds.update');
          failedSocket?.ev?.removeAllListeners?.('connection.update');
          failedSocket?.ws?.close();
        } catch {}

        // Do not retain half-created pairing credentials. A fresh attempt gets
        // a new Noise identity and avoids retrying a broken registration state.
        try {
          const cleanup = await createDatabaseAuthState();
          await cleanup.clear();
        } catch (cleanupError) {
          logger.warn({ err: cleanupError }, 'Failed cleaning failed WhatsApp pairing state');
        }
      }
    }

    const message = safeErrorMessage(lastError) || 'WhatsApp pairing code could not be generated';
    this.pairingActive = false;
    this.clearPairingExpiry();
    this.status = 'disconnected';
    this.lastError = message;
    this.phone = phoneNumber;
    await patchBotState({ status: 'disconnected', lastError: message });
    throw new Error(`Unable to generate WhatsApp pairing code: ${message}`);
  }

  async send(text) {
    if (!this.socket || this.status !== 'open') throw new Error('WhatsApp is not connected');
    const { recipients } = await getChannelConfig();
    if (!recipients.length) throw new Error('No WhatsApp recipients configured');
    const results = [];
    const failures = [];
    for (const jid of recipients) {
      try {
        const sent = await this.socket.sendMessage(jid, { text });
        results.push({ jid, messageId: sent?.key?.id || null });
      } catch (error) {
        failures.push({ jid, error });
        logger.warn({ jid, err: error }, 'WhatsApp message delivery failed for recipient');
      }
    }
    if (!results.length) throw new Error(failures[0]?.error?.message || 'WhatsApp message could not be delivered');
    return results;
  }

  async reconnect() {
    this.stopped = false;
    this.clearReconnectTimer();
    this.pairingActive = false;
    if (this.pairingRecoveryTimer) clearTimeout(this.pairingRecoveryTimer);
    this.pairingRecoveryTimer = null;
    this.clearPairingExpiry();
    if (this.pairingPromise) throw new Error('WhatsApp pairing is currently in progress.');
    if (this.socket) {
      const old = this.socket;
      this.socket = null;
      try {
        old.ev?.removeAllListeners?.('creds.update');
        old.ev?.removeAllListeners?.('connection.update');
        old.ws?.close();
      } catch {}
    }
    this.auth = null;
    await this.ensureSocket('dashboard-reconnect');
  }

  async logout() {
    this.stopped = true;
    this.clearReconnectTimer();
    if (this.pairingPromise) throw new Error('WhatsApp pairing is currently in progress. Wait for it to finish before logging out.');
    const socket = this.socket;
    const auth = this.auth;
    this.socket = null;
    this.auth = null;
    try {
      socket?.ev?.removeAllListeners?.('creds.update');
      socket?.ev?.removeAllListeners?.('connection.update');
    } catch {}
    try { if (socket) await socket.logout(); } catch (error) { logger.debug({ err: error }, 'WhatsApp logout request failed after socket teardown'); }
    if (auth) await auth.clear().catch(error => logger.error({ err: error }, 'Failed clearing WhatsApp auth after logout'));
    this.status = 'disconnected';
    this.phone = null;
    this.lastPairingCode = null;
    this.lastError = null;
    await patchBotState({ status: 'logged_out', connectedAt: null, lastError: null });
  }

  async shutdown() {
    this.stopped = true;
    this.clearReconnectTimer();
    this.pairingActive = false;
    if (this.pairingRecoveryTimer) clearTimeout(this.pairingRecoveryTimer);
    this.pairingRecoveryTimer = null;
    this.clearPairingExpiry();
    const socket = this.socket;
    this.socket = null;
    try { socket?.ws?.close(); } catch {}
    this.auth = null;
    this.status = 'disconnected';
  }

  armPairingExpiry() {
    this.clearPairingExpiry();
    this.pairingExpiresTimer = setTimeout(() => {
      this.pairingExpiresTimer = null;
      if (!this.pairingActive || this.status === 'open') return;
      this.pairingActive = false;
      this.lastPairingCode = null;
      this.lastError = 'Pairing code expired. Generate a new code and try again.';
      this.status = 'disconnected';
      patchBotState({ status: 'disconnected', lastError: this.lastError }).catch(error => logger.warn({ err: error }, 'Failed updating expired pairing state'));
      const socket = this.socket;
      this.socket = null;
      try {
        socket?.ev?.removeAllListeners?.('creds.update');
        socket?.ev?.removeAllListeners?.('connection.update');
        socket?.ws?.close();
      } catch {}
    }, 120000);
  }

  clearPairingExpiry() {
    if (this.pairingExpiresTimer) clearTimeout(this.pairingExpiresTimer);
    this.pairingExpiresTimer = null;
  }

  clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
