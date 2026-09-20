import { query } from '../db/index.mjs';
import { normalizeRecipients } from '../utils/whatsapp.mjs';

export async function getChannelConfig() {
  const { rows } = await query('SELECT recipients FROM channel_config WHERE id = 1');
  const recipients = rows[0]?.recipients || [];
  return { recipients };
}

export async function setChannelRecipients(recipients) {
  let normalized;
  try { normalized = normalizeRecipients(recipients); }
  catch (error) { error.statusCode = 400; throw error; }
  await query(`INSERT INTO channel_config (id, recipients, updated_at) VALUES (1, $1::jsonb, NOW())
    ON CONFLICT (id) DO UPDATE SET recipients = EXCLUDED.recipients, updated_at = NOW()`, [JSON.stringify(normalized)]);
  return { recipients: normalized };
}
