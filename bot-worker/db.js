const fs = require('fs/promises');
const path = require('path');
const { Pool } = require('pg');

const usePostgres = Boolean(process.env.DATABASE_URL);
const dataFile = process.env.JSON_DB_PATH || path.join(process.env.DATA_DIR || '/var/data', 'wingo-db.json');
let pool = null;

const initial = {
  settings: { channelId: '', active: false, confidenceThreshold: 65, updatedAt: new Date().toISOString() },
  runtime: { connected: false, phone: '', botActive: false, uptimeStartedAt: null, lastError: '', lastSeenIssue: '', reconnectRequestedAt: null, updatedAt: new Date().toISOString() },
  pairingRequests: [],
  signals: []
};


async function ensureFile() {
  await fs.mkdir(path.dirname(dataFile), { recursive: true });
  try { await fs.access(dataFile); } catch { await fs.writeFile(dataFile, JSON.stringify(initial, null, 2)); }
}

async function read() {
  await ensureFile();
  return JSON.parse(await fs.readFile(dataFile, 'utf8'));
}

async function write(state) {
  await ensureFile();
  const tmp = `${dataFile}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, dataFile);
}

async function init() {
  if (!usePostgres) { await ensureFile(); return; }
  pool = new Pool({ connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, max: Number(process.env.DB_POOL_MAX || 4), connectionTimeoutMillis: 10_000 });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wingo_settings (id INTEGER PRIMARY KEY CHECK (id=1), channel_id TEXT NOT NULL DEFAULT '', active BOOLEAN NOT NULL DEFAULT FALSE, confidence_threshold INTEGER NOT NULL DEFAULT 65, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS wingo_runtime (id INTEGER PRIMARY KEY CHECK (id=1), connected BOOLEAN NOT NULL DEFAULT FALSE, phone TEXT NOT NULL DEFAULT '', bot_active BOOLEAN NOT NULL DEFAULT FALSE, uptime_started_at TIMESTAMPTZ, last_error TEXT NOT NULL DEFAULT '', last_seen_issue TEXT NOT NULL DEFAULT '', reconnect_requested_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS wingo_pairing_requests (id BIGSERIAL PRIMARY KEY, phone TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', code TEXT, expires_at TIMESTAMPTZ, error TEXT, processing_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE INDEX IF NOT EXISTS idx_wingo_pairing_status ON wingo_pairing_requests(status, created_at);
    CREATE TABLE IF NOT EXISTS wingo_signals (id BIGSERIAL PRIMARY KEY, issue_number TEXT NOT NULL UNIQUE, prediction_size TEXT NOT NULL, prediction_color TEXT NOT NULL, confidence NUMERIC(5,2) NOT NULL, base_issue TEXT, result_number TEXT, result_size TEXT, result_color TEXT, outcome TEXT, message_id TEXT, sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), settled_at TIMESTAMPTZ);
    CREATE INDEX IF NOT EXISTS idx_wingo_signals_sent_at ON wingo_signals(sent_at DESC);
    INSERT INTO wingo_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
    INSERT INTO wingo_runtime (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
  `);
}

async function getSettings() {
  if (!usePostgres) return (await read()).settings;
  const { rows } = await pool.query('SELECT channel_id, active, confidence_threshold, updated_at FROM wingo_settings WHERE id=1');
  const row = rows[0];
  return { channelId: row.channel_id, active: row.active, confidenceThreshold: Number(row.confidence_threshold), updatedAt: row.updated_at };
}

async function getRuntime() {
  if (!usePostgres) return (await read()).runtime;
  const { rows } = await pool.query('SELECT connected, phone, bot_active, uptime_started_at, last_error, last_seen_issue, reconnect_requested_at, updated_at FROM wingo_runtime WHERE id=1');
  const row = rows[0];
  return { connected: row.connected, phone: row.phone, botActive: row.bot_active, uptimeStartedAt: row.uptime_started_at, lastError: row.last_error, lastSeenIssue: row.last_seen_issue, reconnectRequestedAt: row.reconnect_requested_at, updatedAt: row.updated_at };
}

async function updateRuntime(patch) {
  if (!usePostgres) {
    const state = await read();
    state.runtime = { ...state.runtime, ...patch, updatedAt: new Date().toISOString() };
    await write(state);
    return state.runtime;
  }
  const current = await getRuntime();
  const next = { ...current, ...patch };
  const { rows } = await pool.query(`UPDATE wingo_runtime SET connected=$1, phone=$2, bot_active=$3, uptime_started_at=$4, last_error=$5, last_seen_issue=$6, reconnect_requested_at=$7, updated_at=NOW() WHERE id=1 RETURNING connected, phone, bot_active, uptime_started_at, last_error, last_seen_issue, reconnect_requested_at, updated_at`, [next.connected, next.phone || '', next.botActive, next.uptimeStartedAt || null, next.lastError || '', next.lastSeenIssue || '', next.reconnectRequestedAt || null]);
  const row = rows[0];
  return { connected: row.connected, phone: row.phone, botActive: row.bot_active, uptimeStartedAt: row.uptime_started_at, lastError: row.last_error, lastSeenIssue: row.last_seen_issue, reconnectRequestedAt: row.reconnect_requested_at, updatedAt: row.updated_at };
}

async function claimNextPairingRequest() {
  if (!usePostgres) {
    const state = await read();
    const now = Date.now();
    const request = state.pairingRequests.filter((r) => r.status === 'pending' && now - Date.parse(r.createdAt) < 120_000).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0];
    if (!request) return null;
    request.status = 'processing';
    request.processingAt = new Date().toISOString();
    request.updatedAt = request.processingAt;
    await write(state);
    return request;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`SELECT id, phone, status, code, expires_at, error, processing_at, created_at, updated_at FROM wingo_pairing_requests WHERE status='pending' AND created_at > NOW() - INTERVAL '2 minutes' ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1`);
    if (!rows[0]) { await client.query('COMMIT'); return null; }
    await client.query("UPDATE wingo_pairing_requests SET status='processing', processing_at=NOW(), updated_at=NOW() WHERE id=$1", [rows[0].id]);
    await client.query('COMMIT');
    return mapPairing(rows[0], 'processing');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

async function setPairingResult(id, data) {
  const { code = null, status = 'ready', error = '', expiresAt = null } = data;
  if (!usePostgres) {
    const state = await read();
    const request = state.pairingRequests.find((r) => String(r.id) === String(id));
    if (!request) return null;
    Object.assign(request, { code, status, error, expiresAt, updatedAt: new Date().toISOString() });
    await write(state);
    return request;
  }
  const { rows } = await pool.query(`UPDATE wingo_pairing_requests SET code=$2, status=$3, error=$4, expires_at=$5, updated_at=NOW() WHERE id=$1 RETURNING id, phone, status, code, expires_at, error, processing_at, created_at, updated_at`, [id, code, status, error, expiresAt]);
  return rows[0] ? mapPairing(rows[0]) : null;
}

async function markLatestPairingPaired(phone) {
  if (!usePostgres) {
    const state = await read();
    const request = state.pairingRequests.filter((r) => r.phone === phone && ['ready', 'processing'].includes(r.status)).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    if (!request) return null;
    request.status = 'paired'; request.updatedAt = new Date().toISOString(); await write(state); return request;
  }
  const { rows } = await pool.query(`UPDATE wingo_pairing_requests SET status='paired', updated_at=NOW() WHERE id=(SELECT id FROM wingo_pairing_requests WHERE phone=$1 AND status IN ('ready','processing') ORDER BY created_at DESC LIMIT 1) RETURNING id, phone, status, code, expires_at, error, processing_at, created_at, updated_at`, [phone]);
  return rows[0] ? mapPairing(rows[0]) : null;
}

async function getPendingSignals() {
  if (!usePostgres) return (await read()).signals.filter((s) => s.outcome === null).sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt));
  const { rows } = await pool.query(`SELECT id, issue_number, prediction_size, prediction_color, confidence, base_issue, result_number, result_size, result_color, outcome, message_id, sent_at, settled_at FROM wingo_signals WHERE outcome IS NULL ORDER BY sent_at ASC LIMIT 50`);
  return rows.map(mapSignal);
}

async function insertSignal(signal) {
  if (!usePostgres) {
    const state = await read();
    const existing = state.signals.find((s) => s.issueNumber === signal.issueNumber);
    if (existing) return existing;
    const row = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, issueNumber: signal.issueNumber, predictionSize: signal.predictionSize, predictionColor: signal.predictionColor, confidence: signal.confidence, baseIssue: signal.baseIssue || '', resultNumber: null, resultSize: null, resultColor: null, outcome: null, messageId: signal.messageId || '', sentAt: new Date().toISOString(), settledAt: null };
    state.signals.unshift(row); await write(state); return row;
  }
  const { rows } = await pool.query(`INSERT INTO wingo_signals (issue_number, prediction_size, prediction_color, confidence, base_issue, message_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (issue_number) DO NOTHING RETURNING id, issue_number, prediction_size, prediction_color, confidence, base_issue, result_number, result_size, result_color, outcome, message_id, sent_at, settled_at`, [signal.issueNumber, signal.predictionSize, signal.predictionColor, signal.confidence, signal.baseIssue || null, signal.messageId || null]);
  return rows[0] ? mapSignal(rows[0]) : getSignalByIssue(signal.issueNumber);
}

async function getSignalByIssue(issueNumber) {
  if (!usePostgres) return (await read()).signals.find((s) => s.issueNumber === String(issueNumber)) || null;
  const { rows } = await pool.query(`SELECT id, issue_number, prediction_size, prediction_color, confidence, base_issue, result_number, result_size, result_color, outcome, message_id, sent_at, settled_at FROM wingo_signals WHERE issue_number=$1`, [String(issueNumber)]);
  return rows[0] ? mapSignal(rows[0]) : null;
}

async function settleSignal(issueNumber, result) {
  if (!usePostgres) {
    const state = await read();
    const signal = state.signals.find((s) => s.issueNumber === String(issueNumber));
    if (!signal) return null;
    Object.assign(signal, { resultNumber: String(result.resultNumber), resultSize: result.resultSize, resultColor: result.resultColor, outcome: result.outcome, settledAt: new Date().toISOString() });
    await write(state); return signal;
  }
  const { rows } = await pool.query(`UPDATE wingo_signals SET result_number=$2, result_size=$3, result_color=$4, outcome=$5, settled_at=NOW() WHERE issue_number=$1 RETURNING id, issue_number, prediction_size, prediction_color, confidence, base_issue, result_number, result_size, result_color, outcome, message_id, sent_at, settled_at`, [String(issueNumber), String(result.resultNumber), result.resultSize, result.resultColor, result.outcome]);
  return rows[0] ? mapSignal(rows[0]) : null;
}

async function close() { if (pool) await pool.end(); }

function mapPairing(row, forcedStatus) {
  return { id: row.id, phone: row.phone, status: forcedStatus || row.status, code: row.code, expiresAt: row.expires_at, error: row.error || '', processingAt: row.processing_at, createdAt: row.created_at, updatedAt: row.updated_at };
}
function mapSignal(row) {
  return { id: row.id, issueNumber: row.issue_number, predictionSize: row.prediction_size, predictionColor: row.prediction_color, confidence: Number(row.confidence), baseIssue: row.base_issue, resultNumber: row.result_number, resultSize: row.result_size, resultColor: row.result_color, outcome: row.outcome, messageId: row.message_id, sentAt: row.sent_at, settledAt: row.settled_at };
}

module.exports = { init, close, getSettings, getRuntime, updateRuntime, claimNextPairingRequest, setPairingResult, markLatestPairingPaired, getPendingSignals, insertSignal, getSignalByIssue, settleSignal };
