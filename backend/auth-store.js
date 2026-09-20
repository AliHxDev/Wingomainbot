const fs = require('fs/promises');
const path = require('path');
const { BufferJSON, initAuthCreds, proto } = require('@whiskeysockets/baileys');

const usePostgres = Boolean(process.env.DATABASE_URL);
const fallbackFile = process.env.BAILEYS_AUTH_FILE || path.join(process.env.DATA_DIR || '/var/data', 'baileys-auth.json');

let pool = null;
let memory = null;

function clone(value) {
  return JSON.parse(JSON.stringify(value, BufferJSON.replacer), BufferJSON.reviver);
}

async function ensureFallback() {
  await fs.mkdir(path.dirname(fallbackFile), { recursive: true });
  try {
    await fs.access(fallbackFile);
  } catch {
    await fs.writeFile(fallbackFile, JSON.stringify({ creds: null, keys: {} }, BufferJSON.replacer), 'utf8');
  }
}

async function readFallback() {
  await ensureFallback();
  const raw = await fs.readFile(fallbackFile, 'utf8');
  const value = JSON.parse(raw, BufferJSON.reviver);
  return { creds: value.creds || null, keys: value.keys || {} };
}

async function writeFallback(value) {
  await ensureFallback();
  const temp = `${fallbackFile}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, BufferJSON.replacer), 'utf8');
  await fs.rename(temp, fallbackFile);
}

function keyName(type, id) {
  return `${type}:${id}`;
}

async function init() {
  if (!usePostgres) {
    memory = await readFallback();
    return;
  }
  pool = new (require('pg').Pool)({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 2,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000
  });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wingo_baileys_creds (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS wingo_baileys_keys (
      key_type TEXT NOT NULL,
      key_id TEXT NOT NULL,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (key_type, key_id)
    );
  `);
}

async function loadCreds() {
  if (!usePostgres) return memory?.creds ? clone(memory.creds) : null;
  const { rows } = await pool.query('SELECT data FROM wingo_baileys_creds WHERE id=1');
  return rows[0] ? clone(rows[0].data) : null;
}

async function saveCreds(creds) {
  const data = clone(creds);
  if (!usePostgres) {
    memory = memory || { creds: null, keys: {} };
    memory.creds = data;
    await writeFallback(memory);
    return;
  }
  await pool.query(`
    INSERT INTO wingo_baileys_creds (id, data, updated_at)
    VALUES (1, $1::jsonb, NOW())
    ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data, updated_at=NOW()
  `, [JSON.stringify(data)]);
}

async function getKeys(type, ids) {
  const result = {};
  if (!ids.length) return result;
  if (!usePostgres) {
    const keys = memory?.keys || {};
    for (const id of ids) {
      const stored = keys[keyName(type, id)];
      if (stored === undefined) continue;
      let value = clone(stored);
      if (type === 'app-state-sync-key') value = proto.Message.AppStateSyncKeyData.fromObject(value);
      result[id] = value;
    }
    return result;
  }
  const { rows } = await pool.query(
    'SELECT key_id, data FROM wingo_baileys_keys WHERE key_type=$1 AND key_id = ANY($2::text[])',
    [type, ids]
  );
  for (const row of rows) {
    let value = clone(row.data);
    if (type === 'app-state-sync-key') value = proto.Message.AppStateSyncKeyData.fromObject(value);
    result[row.key_id] = value;
  }
  return result;
}

async function setKeys(data) {
  if (!usePostgres) {
    memory = memory || { creds: null, keys: {} };
    for (const [type, entries] of Object.entries(data)) {
      for (const [id, value] of Object.entries(entries)) {
        const name = keyName(type, id);
        if (value === null || value === undefined) delete memory.keys[name];
        else memory.keys[name] = clone(value);
      }
    }
    await writeFallback(memory);
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [type, entries] of Object.entries(data)) {
      for (const [id, value] of Object.entries(entries)) {
        if (value === null || value === undefined) {
          await client.query('DELETE FROM wingo_baileys_keys WHERE key_type=$1 AND key_id=$2', [type, id]);
        } else {
          const encoded = clone(value);
          await client.query(`
            INSERT INTO wingo_baileys_keys (key_type, key_id, data, updated_at)
            VALUES ($1, $2, $3::jsonb, NOW())
            ON CONFLICT (key_type, key_id)
            DO UPDATE SET data=EXCLUDED.data, updated_at=NOW()
          `, [type, id, JSON.stringify(encoded)]);
        }
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function clear() {
  if (!usePostgres) {
    memory = { creds: null, keys: {} };
    await writeFallback(memory);
    return;
  }
  await pool.query('DELETE FROM wingo_baileys_keys');
  await pool.query('DELETE FROM wingo_baileys_creds WHERE id=1');
}

async function getAuthState() {
  const storedCreds = await loadCreds();
  const creds = storedCreds || initAuthCreds();
  const keys = {
    get: async (type, ids) => getKeys(type, ids),
    set: async (data) => setKeys(data)
  };
  return {
    state: { creds, keys },
    saveCreds: () => saveCreds(creds)
  };
}

async function close() {
  if (pool) await pool.end();
  pool = null;
}

module.exports = { init, getAuthState, saveCreds, clear, close };
