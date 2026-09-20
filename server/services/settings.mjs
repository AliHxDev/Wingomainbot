import { query } from '../db/index.mjs';
import { env } from '../config/env.mjs';

export async function getSettings() {
  const { rows } = await query('SELECT key, value FROM app_settings');
  const settings = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return {
    confidenceThreshold: Number(settings.confidence_threshold ?? env.CONFIDENCE_THRESHOLD),
    pollIntervalSeconds: Number(settings.poll_interval_seconds ?? env.POLL_INTERVAL_SECONDS),
  };
}

export async function updateSettings({ confidenceThreshold, pollIntervalSeconds }) {
  const values = [
    ['confidence_threshold', confidenceThreshold],
    ['poll_interval_seconds', pollIntervalSeconds],
  ];
  for (const [key, value] of values) {
    await query(`INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [key, JSON.stringify(value)]);
  }
  return getSettings();
}

export async function getConfidenceThreshold() {
  const settings = await getSettings();
  return settings.confidenceThreshold;
}
