import makeWASocket, { Browsers, DisconnectReason } from '@whiskeysockets/baileys';
import { query } from '../db/index.mjs';
import { env } from '../config/env.mjs';
import { logger } from '../utils/logger.mjs';
import { createDatabaseAuthState } from './whatsappAuth.mjs';
import { getChannelConfig } from './channel.mjs';
import { patchBotState } from './botState.mjs';

export class WhatsAppManager {
  constructor() {
    this.socket = null;
    this.auth = null;
    this.creating = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.lastPairingCode = null;
    this.status = 'disconnected';
    this.lastError = null;
    this.phone = null;
    this.stopped = false;
  }

  async init() {
    this.stopped = false;
    await this.restore();
  }

  async restore() {
    const { rows } = await query('SELECT creds FROM whatsapp_auth WHERE id=1');
    const hasCreds = Boolean(rows[0]?.creds);
    if (hasCreds) await this.ensureSocket('restore');
    else await patchBotState({ status:'disconnected', lastError:null });
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

  async ensureSocket(reason='manual') {
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
    await patchBotState({ status:'connecting', lastError:null });
    const socket = makeWASocket({
      auth: this.auth.state,
      printQRInTerminal: false,
      browser: Browsers.ubuntu('WinGo Signal Console'),
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: 30_000,
      defaultQueryTimeoutMs: 30_000,
      logger,
    });
    this.socket = socket;
    socket.ev.on('creds.update', this.auth.saveCreds);
    socket.ev.on('connection.update', update => this._handleConnectionUpdate(update, socket, reason).catch(error => logger.error({err:error}, 'WhatsApp connection handler failed')));
    logger.info({ reason }, 'WhatsApp socket created');
    return socket;
  }

  async _handleConnectionUpdate(update, socket, reason) {
    if (socket !== this.socket) return;
    const { connection, lastDisconnect } = update;
    if (update.qr) logger.debug('Baileys emitted QR data; QR terminal display remains disabled');
    if (connection === 'open') {
      this.status = 'open'; this.reconnectAttempt = 0; this.lastError = null; this.lastPairingCode = null;
      this.phone = socket.user?.id?.split(':')[0] || socket.user?.id || null;
      await patchBotState({ status:'open', connectedAt:new Date().toISOString(), lastError:null });
      logger.info({ phone:this.phone }, 'WhatsApp connection opened');
      return;
    }
    if (connection !== 'close') return;

    const statusCode = lastDisconnect?.error?.output?.statusCode;
    const loggedOut = statusCode === DisconnectReason.loggedOut;
    const badSession = statusCode === DisconnectReason.badSession;
    const restartRequired = statusCode === DisconnectReason.restartRequired;
    this.status = 'disconnected';
    this.lastError = lastDisconnect?.error?.message || `Disconnected (${statusCode ?? 'unknown'})`;
    await patchBotState({ status:loggedOut ? 'logged_out':'disconnected', lastError:this.lastError });
    this.socket = null;
    this.phone = null;

    if (loggedOut || badSession) {
      if (this.auth) await this.auth.clear().catch(error => logger.error({err:error}, 'Failed clearing WhatsApp auth state'));
      this.auth = null;
      this.lastPairingCode = null;
      logger.warn({ statusCode }, 'WhatsApp auth state invalid; pairing is required again');
      return;
    }

    if (this.stopped) return;
    if (restartRequired) {
      this.reconnectAttempt = 0;
      await this.ensureSocket('restart-required');
      return;
    }
    this.scheduleReconnect(reason);
  }

  scheduleReconnect(reason='disconnect') {
    if (this.reconnectTimer || this.stopped || this.socket) return;
    this.reconnectAttempt += 1;
    const max = env.WA_RECONNECT_MAX_BACKOFF_MS;
    const delay = Math.min(max, 1000 * (2 ** Math.min(this.reconnectAttempt - 1, 5)));
    logger.warn({ reason, reconnectAttempt:this.reconnectAttempt, delay }, 'Scheduling WhatsApp reconnect');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.ensureSocket('backoff-reconnect').catch(error => logger.error({err:error}, 'WhatsApp reconnect failed'));
    }, delay);
  }

  async requestPairingCode(phoneNumber) {
    this.stopped = false;
    if (this.socket && this.status === 'open') {
      throw new Error('WhatsApp is already connected; use Logout WhatsApp before pairing another number.');
    }

    let lastError = null;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const socket = await this.ensureSocket('pairing');
      if (!socket) throw new Error('Unable to create WhatsApp socket');
      if (socket !== this.socket) continue;

      // Baileys needs the underlying WebSocket to finish its initial handshake
      // before registration-node requests are reliable. Render cold starts can
      // take several seconds, so a fixed short sleep is not sufficient.
      const waitMs = Math.min(15000, 1000 + (attempt - 1) * 1000);
      await new Promise(resolve => setTimeout(resolve, waitMs));
      if (socket !== this.socket) continue;

      try {
        const code = await socket.requestPairingCode(phoneNumber);
        if (!code) throw new Error('WhatsApp returned an empty pairing code');
        this.lastPairingCode = code;
        this.phone = phoneNumber;
        this.lastError = null;
        await patchBotState({ status:'pairing', lastError:null });
        logger.info({ phone: phoneNumber, attempt }, 'WhatsApp pairing code generated');
        return code;
      } catch (error) {
        lastError = error;
        logger.warn({ err:error, attempt, phone:phoneNumber }, 'WhatsApp pairing-code request failed; retrying');
        if (this.socket === socket && this.status === 'disconnected') {
          this.socket = null;
          this.auth = null;
        }
      }
    }

    const message = lastError?.message || 'WhatsApp pairing code could not be generated';
    this.lastError = message;
    await patchBotState({ status:'disconnected', lastError:message });
    throw new Error(`Unable to generate WhatsApp pairing code after several connection attempts: ${message}`);
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
        results.push({ jid, messageId:sent?.key?.id || null });
      } catch (error) {
        failures.push({ jid, error });
        logger.warn({ jid, err:error }, 'WhatsApp message delivery failed for recipient');
      }
    }
    if (!results.length) throw new Error(failures[0]?.error?.message || 'WhatsApp message could not be delivered');
    return results;
  }

  async reconnect() {
    this.stopped = false;
    this.clearReconnectTimer();
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
    const socket = this.socket;
    const auth = this.auth;
    this.socket = null;
    this.auth = null;
    try {
      socket?.ev?.removeAllListeners?.('creds.update');
      socket?.ev?.removeAllListeners?.('connection.update');
    } catch {}
    try { if (socket) await socket.logout(); } catch (error) { logger.debug({err:error}, 'WhatsApp logout request failed after socket teardown'); }
    if (auth) await auth.clear().catch(error => logger.error({err:error}, 'Failed clearing WhatsApp auth after logout'));
    this.status = 'disconnected'; this.phone=null; this.lastPairingCode=null;
    await patchBotState({ status:'logged_out', connectedAt:null, lastError:null });
  }

  async shutdown() {
    this.stopped = true;
    this.clearReconnectTimer();
    const socket = this.socket; this.socket = null;
    try { socket?.ws?.close(); } catch {}
    this.auth = null;
    this.status = 'disconnected';
  }

  clearReconnectTimer() { if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer=null; } }
}
