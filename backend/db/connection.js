const fs = require('fs/promises');
const path = require('path');
const { Pool } = require('pg');

const usePostgres = Boolean(process.env.DATABASE_URL);
const dataFile = process.env.JSON_DB_PATH || path.join(process.env.DATA_DIR || '/var/data', 'wingo-db.json');
let pool = null;

const defaultState = {
  settings: {
    channelId: '',
    active: false,
    confidenceThreshold: 65,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  },
  runtime: {
    connected: false,
    phone: '',
    botActive: false,
    uptimeStartedAt: null,
    lastError: '',
    lastSeenIssue: '',
    reconnectRequestedAt: null,
    updatedAt: new Date().toISOString()
  },
  pairingRequests: [],
  signals: []
};

function normalizeConnectionString(connectionString) {
  if (!connectionString) return connectionString;
  return connectionString.includes('sslmode=')
    ? connectionString
    : `${connectionString}${connectionString.includes('?') ? '&' : '?'}sslmode=require`;
}

async function ensureJsonStore() {
  await fs.mkdir(path.dirname(dataFile), { recursive: true });
  try {
    await fs.access(dataFile);
  } catch {
    await fs.writeFile(dataFile, JSON.stringify(defaultState, null, 2), 'utf8');
  }
}

async function readJson() {
  await ensureJsonStore();
  const raw = await fs.readFile(dataFile, 'utf8');
  const parsed = JSON.parse(raw);
  return {
    ...defaultState,
    ...parsed,
    settings: { ...defaultState.settings, ...(parsed.settings || {}) },
    runtime: { ...defaultState.runtime, ...(parsed.runtime || {}) },
    pairingRequests: Array.isArray(parsed.pairingRequests) ? parsed.pairingRequests : [],
    signals: Array.isArray(parsed.signals) ? parsed.signals : []
  };
}

async function writeJson(nextState) {
  await ensureJsonStore();
  const temp = `${dataFile}.tmp`;
  await fs.writeFile(temp, JSON.stringify(nextState, null, 2), 'utf8');
  await fs.rename(temp, dataFile);
}

async function withJson(mutator) {
  const state = await readJson();
  const result = await mutator(state);
  await writeJson(state);
  return result;
}

async function initDb() {
  if (!usePostgres) {
    await ensureJsonStore();
    return { driver: 'json', location: dataFile };
  }

  pool = new Pool({
    connectionString: normalizeConnectionString(process.env.DATABASE_URL),
    max: Number(process.env.DB_POOL_MAX || 5),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS wingo_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      channel_id TEXT NOT NULL DEFAULT '',
      active BOOLEAN NOT NULL DEFAULT FALSE,
      confidence_threshold INTEGER NOT NULL DEFAULT 65,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS wingo_runtime (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      connected BOOLEAN NOT NULL DEFAULT FALSE,
      phone TEXT NOT NULL DEFAULT '',
      bot_active BOOLEAN NOT NULL DEFAULT FALSE,
      uptime_started_at TIMESTAMPTZ,
      last_error TEXT NOT NULL DEFAULT '',
      last_seen_issue TEXT NOT NULL DEFAULT '',
      reconnect_requested_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS wingo_pairing_requests (
      id BIGSERIAL PRIMARY KEY,
      phone TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      code TEXT,
      expires_at TIMESTAMPTZ,
      error TEXT,
      processing_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_wingo_pairing_status ON wingo_pairing_requests(status, created_at);

    CREATE TABLE IF NOT EXISTS wingo_signals (
      id BIGSERIAL PRIMARY KEY,
      issue_number TEXT NOT NULL UNIQUE,
      prediction_size TEXT NOT NULL,
      prediction_color TEXT NOT NULL,
      confidence NUMERIC(5,2) NOT NULL,
      base_issue TEXT,
      result_number TEXT,
      result_size TEXT,
      result_color TEXT,
      outcome TEXT,
      message_id TEXT,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      settled_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_wingo_signals_sent_at ON wingo_signals(sent_at DESC);
  `);

  await pool.query(`
    INSERT INTO wingo_settings (id)
    VALUES (1)
    ON CONFLICT (id) DO NOTHING;
  `);
  await pool.query(`
    INSERT INTO wingo_runtime (id)
    VALUES (1)
    ON CONFLICT (id) DO NOTHING;
  `);

  return { driver: 'postgres' };
}

async function getSettings() {
  if (!usePostgres) {
    const state = await readJson();
    return state.settings;
  }
  const { rows } = await pool.query(`SELECT channel_id, active, confidence_threshold, created_at, updated_at FROM wingo_settings WHERE id = 1`);
  const row = rows[0];
  return {
    channelId: row.channel_id,
    active: row.active,
    confidenceThreshold: Number(row.confidence_threshold),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function updateSettings(patch) {
  const allowed = {};
  if (patch.channelId !== undefined) allowed.channelId = String(patch.channelId);
  if (patch.active !== undefined) allowed.active = Boolean(patch.active);
  if (patch.confidenceThreshold !== undefined) allowed.confidenceThreshold = Number(patch.confidenceThreshold);

  if (!usePostgres) {
    return withJson((state) => {
      state.settings = {
        ...state.settings,
        ...allowed,
        updatedAt: new Date().toISOString()
      };
      return state.settings;
    });
  }

  const current = await getSettings();
  const next = { ...current, ...allowed };
  const { rows } = await pool.query(
    `UPDATE wingo_settings
     SET channel_id = $1, active = $2, confidence_threshold = $3, updated_at = NOW()
     WHERE id = 1
     RETURNING channel_id, active, confidence_threshold, created_at, updated_at`,
    [next.channelId, next.active, next.confidenceThreshold]
  );
  const row = rows[0];
  return {
    channelId: row.channel_id,
    active: row.active,
    confidenceThreshold: Number(row.confidence_threshold),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function getRuntime() {
  if (!usePostgres) {
    const state = await readJson();
    return state.runtime;
  }
  const { rows } = await pool.query(`
    SELECT connected, phone, bot_active, uptime_started_at, last_error, last_seen_issue, reconnect_requested_at, updated_at
    FROM wingo_runtime WHERE id = 1
  `);
  const row = rows[0];
  return {
    connected: row.connected,
    phone: row.phone,
    botActive: row.bot_active,
    uptimeStartedAt: row.uptime_started_at,
    lastError: row.last_error,
    lastSeenIssue: row.last_seen_issue,
    reconnectRequestedAt: row.reconnect_requested_at,
    updatedAt: row.updated_at
  };
}

async function updateRuntime(patch) {
  if (!usePostgres) {
    return withJson((state) => {
      state.runtime = {
        ...state.runtime,
        ...patch,
        updatedAt: new Date().toISOString()
      };
      return state.runtime;
    });
  }

  const current = await getRuntime();
  const next = { ...current, ...patch };
  const { rows } = await pool.query(`
    UPDATE wingo_runtime
    SET connected = $1,
        phone = $2,
        bot_active = $3,
        uptime_started_at = $4,
        last_error = $5,
        last_seen_issue = $6,
        reconnect_requested_at = $7,
        updated_at = NOW()
    WHERE id = 1
    RETURNING connected, phone, bot_active, uptime_started_at, last_error, last_seen_issue, reconnect_requested_at, updated_at
  `, [
    next.connected,
    next.phone || '',
    next.botActive,
    next.uptimeStartedAt || null,
    next.lastError || '',
    next.lastSeenIssue || '',
    next.reconnectRequestedAt || null
  ]);
  const row = rows[0];
  return {
    connected: row.connected,
    phone: row.phone,
    botActive: row.bot_active,
    uptimeStartedAt: row.uptime_started_at,
    lastError: row.last_error,
    lastSeenIssue: row.last_seen_issue,
    reconnectRequestedAt: row.reconnect_requested_at,
    updatedAt: row.updated_at
  };
}

async function createPairingRequest(phone) {
  const id = cryptoRandomId();
  if (!usePostgres) {
    return withJson((state) => {
      state.pairingRequests = state.pairingRequests.filter((item) => item.status !== 'pending' || item.phone !== phone);
      state.pairingRequests.push({
        id,
        phone,
        status: 'pending',
        code: null,
        expiresAt: null,
        error: '',
        processingAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      return state.pairingRequests[state.pairingRequests.length - 1];
    });
  }
  const { rows } = await pool.query(`
    INSERT INTO wingo_pairing_requests (phone, status)
    VALUES ($1, 'pending')
    RETURNING id, phone, status, code, expires_at, error, processing_at, created_at, updated_at
  `, [phone]);
  return mapPairingRow(rows[0]);
}

async function getPairingRequest(id) {
  if (!usePostgres) {
    const state = await readJson();
    return state.pairingRequests.find((item) => String(item.id) === String(id)) || null;
  }
  const { rows } = await pool.query(`
    SELECT id, phone, status, code, expires_at, error, processing_at, created_at, updated_at
    FROM wingo_pairing_requests WHERE id = $1
  `, [id]);
  return rows[0] ? mapPairingRow(rows[0]) : null;
}

async function claimNextPairingRequest() {
  if (!usePostgres) {
    return withJson((state) => {
      const now = Date.now();
      const item = state.pairingRequests
        .filter((request) => request.status === 'pending' && now - Date.parse(request.createdAt) < 120_000)
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0];
      if (!item) return null;
      item.status = 'processing';
      item.processingAt = new Date().toISOString();
      item.updatedAt = item.processingAt;
      return item;
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`
      SELECT id, phone, status, code, expires_at, error, processing_at, created_at, updated_at
      FROM wingo_pairing_requests
      WHERE status = 'pending'
        AND created_at > NOW() - INTERVAL '2 minutes'
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `);
    if (!rows[0]) {
      await client.query('COMMIT');
      return null;
    }
    await client.query(`
      UPDATE wingo_pairing_requests
      SET status = 'processing', processing_at = NOW(), updated_at = NOW()
      WHERE id = $1
    `, [rows[0].id]);
    await client.query('COMMIT');
    return mapPairingRow({ ...rows[0], status: 'processing', processing_at: new Date() });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function setPairingResult(id, { code = null, status = 'ready', error = '', expiresAt = null }) {
  if (!usePostgres) {
    return withJson((state) => {
      const item = state.pairingRequests.find((request) => String(request.id) === String(id));
      if (!item) return null;
      item.code = code;
      item.status = status;
      item.error = error;
      item.expiresAt = expiresAt;
      item.updatedAt = new Date().toISOString();
      return item;
    });
  }
  const { rows } = await pool.query(`
    UPDATE wingo_pairing_requests
    SET code = $2, status = $3, error = $4, expires_at = $5, updated_at = NOW()
    WHERE id = $1
    RETURNING id, phone, status, code, expires_at, error, processing_at, created_at, updated_at
  `, [id, code, status, error, expiresAt]);
  return rows[0] ? mapPairingRow(rows[0]) : null;
}

async function markLatestPairingPaired(phone) {
  if (!usePostgres) {
    return withJson((state) => {
      const candidates = state.pairingRequests
        .filter((item) => item.phone === phone && ['ready', 'processing'].includes(item.status))
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      if (!candidates[0]) return null;
      candidates[0].status = 'paired';
      candidates[0].updatedAt = new Date().toISOString();
      return candidates[0];
    });
  }
  const { rows } = await pool.query(`
    UPDATE wingo_pairing_requests
    SET status = 'paired', updated_at = NOW()
    WHERE id = (
      SELECT id FROM wingo_pairing_requests
      WHERE phone = $1 AND status IN ('ready', 'processing')
      ORDER BY created_at DESC LIMIT 1
    )
    RETURNING id, phone, status, code, expires_at, error, processing_at, created_at, updated_at
  `, [phone]);
  return rows[0] ? mapPairingRow(rows[0]) : null;
}

async function insertSignal(signal) {
  if (!usePostgres) {
    return withJson((state) => {
      const existing = state.signals.find((item) => item.issueNumber === signal.issueNumber);
      if (existing) return existing;
      const row = {
        id: cryptoRandomId(),
        ...signal,
        sentAt: signal.sentAt || new Date().toISOString(),
        settledAt: null,
        outcome: null,
        resultNumber: null,
        resultSize: null,
        resultColor: null,
        messageId: signal.messageId || ''
      };
      state.signals.unshift(row);
      return row;
    });
  }
  const { rows } = await pool.query(`
    INSERT INTO wingo_signals
      (issue_number, prediction_size, prediction_color, confidence, base_issue, message_id)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (issue_number) DO NOTHING
    RETURNING id, issue_number, prediction_size, prediction_color, confidence, base_issue, result_number, result_size, result_color, outcome, message_id, sent_at, settled_at
  `, [signal.issueNumber, signal.predictionSize, signal.predictionColor, signal.confidence, signal.baseIssue || null, signal.messageId || null]);
  if (rows[0]) return mapSignalRow(rows[0]);
  const existing = await getSignalByIssue(signal.issueNumber);
  return existing;
}

async function getPendingSignals(limit = 25) {
  if (!usePostgres) {
    const state = await readJson();
    return state.signals.filter((signal) => signal.outcome === null).slice(0, limit);
  }
  const { rows } = await pool.query(`
    SELECT id, issue_number, prediction_size, prediction_color, confidence, base_issue, result_number, result_size, result_color, outcome, message_id, sent_at, settled_at
    FROM wingo_signals
    WHERE outcome IS NULL
    ORDER BY sent_at ASC
    LIMIT $1
  `, [limit]);
  return rows.map(mapSignalRow);
}

async function getSignalByIssue(issueNumber) {
  if (!usePostgres) {
    const state = await readJson();
    return state.signals.find((signal) => signal.issueNumber === String(issueNumber)) || null;
  }
  const { rows } = await pool.query(`
    SELECT id, issue_number, prediction_size, prediction_color, confidence, base_issue, result_number, result_size, result_color, outcome, message_id, sent_at, settled_at
    FROM wingo_signals WHERE issue_number = $1
  `, [String(issueNumber)]);
  return rows[0] ? mapSignalRow(rows[0]) : null;
}

async function settleSignal(issueNumber, result) {
  const outcome = result.outcome;
  if (!usePostgres) {
    return withJson((state) => {
      const item = state.signals.find((signal) => signal.issueNumber === String(issueNumber));
      if (!item) return null;
      item.resultNumber = String(result.resultNumber);
      item.resultSize = result.resultSize;
      item.resultColor = result.resultColor;
      item.outcome = outcome;
      item.settledAt = new Date().toISOString();
      return item;
    });
  }
  const { rows } = await pool.query(`
    UPDATE wingo_signals
    SET result_number = $2,
        result_size = $3,
        result_color = $4,
        outcome = $5,
        settled_at = NOW()
    WHERE issue_number = $1
    RETURNING id, issue_number, prediction_size, prediction_color, confidence, base_issue, result_number, result_size, result_color, outcome, message_id, sent_at, settled_at
  `, [String(issueNumber), String(result.resultNumber), result.resultSize, result.resultColor, outcome]);
  return rows[0] ? mapSignalRow(rows[0]) : null;
}

async function listSignals(limit = 100) {
  if (!usePostgres) {
    const state = await readJson();
    return state.signals.slice(0, limit);
  }
  const { rows } = await pool.query(`
    SELECT id, issue_number, prediction_size, prediction_color, confidence, base_issue, result_number, result_size, result_color, outcome, message_id, sent_at, settled_at
    FROM wingo_signals ORDER BY sent_at DESC LIMIT $1
  `, [limit]);
  return rows.map(mapSignalRow);
}

async function getStats() {
  if (!usePostgres) {
    const state = await readJson();
    const settled = state.signals.filter((s) => s.outcome === 'WIN' || s.outcome === 'LOSS');
    const wins = settled.filter((s) => s.outcome === 'WIN').length;
    const losses = settled.filter((s) => s.outcome === 'LOSS').length;
    return {
      totalSignals: state.signals.length,
      wins,
      losses,
      pending: state.signals.filter((s) => s.outcome === null).length,
      winRate: settled.length ? Number(((wins / settled.length) * 100).toFixed(2)) : 0
    };
  }
  const { rows } = await pool.query(`
    SELECT
      COUNT(*)::int AS total_signals,
      COUNT(*) FILTER (WHERE outcome = 'WIN')::int AS wins,
      COUNT(*) FILTER (WHERE outcome = 'LOSS')::int AS losses,
      COUNT(*) FILTER (WHERE outcome IS NULL)::int AS pending
    FROM wingo_signals
  `);
  const row = rows[0];
  const settled = row.wins + row.losses;
  return {
    totalSignals: row.total_signals,
    wins: row.wins,
    losses: row.losses,
    pending: row.pending,
    winRate: settled ? Number(((row.wins / settled) * 100).toFixed(2)) : 0
  };
}

async function closeDb() {
  if (pool) await pool.end();
}

function mapPairingRow(row) {
  return {
    id: row.id,
    phone: row.phone,
    status: row.status,
    code: row.code,
    expiresAt: row.expires_at,
    error: row.error || '',
    processingAt: row.processing_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapSignalRow(row) {
  return {
    id: row.id,
    issueNumber: row.issue_number,
    predictionSize: row.prediction_size,
    predictionColor: row.prediction_color,
    confidence: Number(row.confidence),
    baseIssue: row.base_issue,
    resultNumber: row.result_number,
    resultSize: row.result_size,
    resultColor: row.result_color,
    outcome: row.outcome,
    messageId: row.message_id,
    sentAt: row.sent_at,
    settledAt: row.settled_at
  };
}

function cryptoRandomId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

module.exports = {
  initDb,
  closeDb,
  getSettings,
  updateSettings,
  getRuntime,
  updateRuntime,
  createPairingRequest,
  getPairingRequest,
  claimNextPairingRequest,
  setPairingResult,
  markLatestPairingPaired,
  insertSignal,
  getPendingSignals,
  getSignalByIssue,
  settleSignal,
  listSignals,
  getStats
};
