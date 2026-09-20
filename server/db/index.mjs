import pg from 'pg';
import { env } from '../config/env.mjs';
import { logger } from '../utils/logger.mjs';

const { Pool } = pg;
const url = new URL(env.DATABASE_URL);
const sslDisabled = url.searchParams.get('sslmode') === 'disable';

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: env.NODE_ENV === 'production' && !sslDisabled ? { rejectUnauthorized: false } : undefined,
  max: 8,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: 'wingo-whatsapp-bot',
});

pool.on('error', (error) => logger.error({ err: error }, 'PostgreSQL pool error'));

export async function query(text, params) {
  return pool.query(text, params);
}

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function closeDatabase() {
  await pool.end();
}
