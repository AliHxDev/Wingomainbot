import { env } from '../config/env.mjs';
import { logger } from '../utils/logger.mjs';
import { fetchWingoHistory, nextIssue } from './wingoApi.mjs';
import { predict } from './predictionEngine.mjs';
import { getChannelConfig } from './channel.mjs';
import { createSignal, findSignalByIssue, settleSignal } from './signals.mjs';
import { getSettings } from './settings.mjs';
import { getBotState, patchBotState } from './botState.mjs';
import { signalMessage, resultMessage } from '../utils/messages.mjs';

export class BotEngine {
  constructor(whatsapp) {
    this.whatsapp = whatsapp;
    this.timer = null;
    this.running = false;
    this.busy = false;
    this.lastHistory = [];
  }

  async init() {
    const state = await getBotState();
    this.running = Boolean(state.running);
    if (this.running) this.start(true);
  }

  async start(persist=true) {
    if (this.running) return;
    this.running = true;
    if (persist) await patchBotState({ running:true, status:this.whatsapp.getStatus().status, lastError:null });
    await this.tick().catch(error => logger.error({err:error}, 'Initial bot tick failed'));
    this.schedule();
  }

  async stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await patchBotState({ running:false, status:this.whatsapp.getStatus().status });
  }

  schedule() {
    if (!this.running) return;
    getSettings().then(settings => {
      this.timer = setTimeout(async () => {
        this.timer = null;
        await this.tick().catch(error => logger.error({err:error}, 'Bot tick failed'));
        this.schedule();
      }, settings.pollIntervalSeconds*1000);
    }).catch(error => {
      this.timer = setTimeout(async () => { this.timer=null; await this.tick().catch(()=>{}); this.schedule(); }, env.POLL_INTERVAL_SECONDS*1000);
      logger.error({err:error}, 'Unable to load polling settings');
    });
  }

  async tick() {
    if (!this.running || this.busy) return;
    this.busy = true;
    try {
      const history = await fetchWingoHistory();
      this.lastHistory = history;
      const latest = history[history.length-1];
      await patchBotState({ lastPollAt:new Date().toISOString(), lastIssue:latest.issue, currentPeriod:nextIssue(latest.issue), lastError:null });
      await this.settlePending(history);
      await this.generateForNext(history);
    } catch (error) {
      await patchBotState({ lastPollAt:new Date().toISOString(), lastError:error.message });
      throw error;
    } finally { this.busy = false; }
  }

  async settlePending(history) {
    for (const result of history) {
      const existing = await findSignalByIssue(result.issue);
      if (!existing || existing.status !== 'PENDING') continue;
      const settled = await settleSignal(result.issue, result);
      if (!settled) continue;
      const message = resultMessage({ outcome:settled.status, issue:settled.issue, result, signal:settled });
      await this.safeSend(message);
      logger.info({ issue:result.issue, outcome:settled.status }, 'WinGo signal settled');
    }
  }

  async generateForNext(history) {
    const settings = await getSettings();
    const targetIssue = nextIssue(history[history.length-1].issue);
    if (await findSignalByIssue(targetIssue)) return;
    const { recipients } = await getChannelConfig();
    if (!recipients.length || this.whatsapp.getStatus().status !== 'open') return;
    const prediction = predict(history.slice(-60).map(item=>({ number:item.number })));
    if (prediction.confidence < settings.confidenceThreshold) return;
    const now = new Date();
    const message = signalMessage({ issue:targetIssue, predictionSize:prediction.predictionSize, predictionColor:prediction.predictionColor, confidence:prediction.confidence, time:now.toLocaleTimeString('en-GB',{hour12:false,timeZone:'UTC'}) });
    const sent = await this.whatsapp.send(message);
    const messageId = sent[0]?.messageId || null;
    await createSignal({ issue:targetIssue, predictionSize:prediction.predictionSize, predictionColor:prediction.predictionColor, confidence:prediction.confidence, whatsappMessageId:messageId });
    logger.info({ issue:targetIssue, confidence:prediction.confidence }, 'WinGo signal sent');
  }

  async safeSend(message) {
    try { await this.whatsapp.send(message); }
    catch (error) { logger.warn({err:error}, 'Unable to send WhatsApp result message'); }
  }
}
