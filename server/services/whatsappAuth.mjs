import { initAuthCreds, BufferJSON } from '@whiskeysockets/baileys';
import { query, withTransaction } from '../db/index.mjs';

export async function createDatabaseAuthState() {
  const { rows } = await query('SELECT creds FROM whatsapp_auth WHERE id=1');
  let creds;
  if (rows[0]?.creds) creds = JSON.parse(JSON.stringify(rows[0].creds), BufferJSON.reviver);
  else creds = initAuthCreds();

  const keys = {
    get: async (type, ids) => {
      if (!ids.length) return {};
      const params = [type, ...ids];
      const paramSlots = ids.map((_, i) => `$${i+2}`).join(',');
      const { rows: keyRows } = await query(`SELECT key_id, value FROM whatsapp_keys WHERE key_type=$1 AND key_id IN (${paramSlots})`, params);
      const values = {};
      for (const row of keyRows) values[row.key_id] = JSON.parse(JSON.stringify(row.value), BufferJSON.reviver);
      return values;
    },
    set: async (data) => {
      await withTransaction(async (client) => {
        for (const category of Object.keys(data)) {
          for (const id of Object.keys(data[category] || {})) {
            const value = data[category][id];
            if (value == null) {
              await client.query('DELETE FROM whatsapp_keys WHERE key_type=$1 AND key_id=$2', [category, id]);
            } else {
              const serialized = JSON.stringify(value, BufferJSON.replacer);
              await client.query(`INSERT INTO whatsapp_keys (key_type,key_id,value,updated_at) VALUES ($1,$2,$3::jsonb,NOW())
                ON CONFLICT (key_type,key_id) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`, [category, id, serialized]);
            }
          }
        }
      });
    },
  };

  const saveCreds = async () => {
    const serialized = JSON.stringify(creds, BufferJSON.replacer);
    await query(`INSERT INTO whatsapp_auth (id,creds,updated_at) VALUES (1,$1::jsonb,NOW())
      ON CONFLICT (id) DO UPDATE SET creds=EXCLUDED.creds, updated_at=NOW()`, [serialized]);
  };

  const clear = async () => {
    await withTransaction(async (client) => {
      await client.query('DELETE FROM whatsapp_keys');
      await client.query('DELETE FROM whatsapp_auth WHERE id=1');
    });
  };

  return { state:{ creds, keys }, saveCreds, clear };
}
