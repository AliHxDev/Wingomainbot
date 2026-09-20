import { pool } from './index.mjs';
import { logger } from '../utils/logger.mjs';

const statements = [
  `CREATE TABLE IF NOT EXISTS app_users (
    id BIGSERIAL PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS whatsapp_auth (
    id SMALLINT PRIMARY KEY CHECK (id = 1),
    creds JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS whatsapp_keys (
    key_type TEXT NOT NULL,
    key_id TEXT NOT NULL,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (key_type, key_id)
  )`,
  `CREATE TABLE IF NOT EXISTS channel_config (
    id SMALLINT PRIMARY KEY CHECK (id = 1),
    recipients JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS bot_state (
    id SMALLINT PRIMARY KEY CHECK (id = 1),
    running BOOLEAN NOT NULL DEFAULT FALSE,
    status TEXT NOT NULL DEFAULT 'stopped',
    current_period TEXT,
    last_issue TEXT,
    last_poll_at TIMESTAMPTZ,
    last_error TEXT,
    connected_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS signals (
    id BIGSERIAL PRIMARY KEY,
    issue TEXT NOT NULL UNIQUE,
    prediction_size TEXT NOT NULL CHECK (prediction_size IN ('BIG','SMALL')),
    prediction_color TEXT NOT NULL CHECK (prediction_color IN ('RED','GREEN')),
    confidence INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','WIN','LOSS')),
    actual_number INTEGER CHECK (actual_number BETWEEN 0 AND 9),
    actual_size TEXT CHECK (actual_size IN ('BIG','SMALL')),
    actual_color TEXT,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    result_at TIMESTAMPTZ,
    whatsapp_message_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS signal_results (
    id BIGSERIAL PRIMARY KEY,
    signal_id BIGINT NOT NULL UNIQUE REFERENCES signals(id) ON DELETE CASCADE,
    outcome TEXT NOT NULL CHECK (outcome IN ('WIN','LOSS')),
    actual_number INTEGER NOT NULL CHECK (actual_number BETWEEN 0 AND 9),
    actual_size TEXT NOT NULL CHECK (actual_size IN ('BIG','SMALL')),
    actual_color TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_signals_status_created ON signals(status, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_signals_issue ON signals(issue)`,
  `CREATE INDEX IF NOT EXISTS idx_whatsapp_keys_updated ON whatsapp_keys(updated_at DESC)`,
];

export async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', ['wingo-whatsapp-bot-schema']);
    for (const statement of statements) await client.query(statement);
    await client.query(`INSERT INTO channel_config (id, recipients) VALUES (1, '[]'::jsonb) ON CONFLICT (id) DO NOTHING`);
    await client.query(`INSERT INTO bot_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
    const defaults = {
      confidence_threshold: 65,
      poll_interval_seconds: 60,
    };
    for (const [key, value] of Object.entries(defaults)) {
      await client.query(`INSERT INTO app_settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO NOTHING`, [key, JSON.stringify(value)]);
    }
  } finally {
    try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['wingo-whatsapp-bot-schema']); } catch {}
    client.release();
  }
  logger.info('Database schema initialized');
}
