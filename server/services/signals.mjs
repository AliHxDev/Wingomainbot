import { query, withTransaction } from '../db/index.mjs';

export async function getLatestSignal() {
  const { rows } = await query(`SELECT id, issue, prediction_size, prediction_color, confidence, status, actual_number, actual_size, actual_color, sent_at, result_at, whatsapp_message_id, created_at FROM signals ORDER BY created_at DESC LIMIT 1`);
  return rows[0] ? mapSignal(rows[0]) : null;
}

export async function listSignals(limit = 50) {
  const { rows } = await query(`SELECT id, issue, prediction_size, prediction_color, confidence, status, actual_number, actual_size, actual_color, sent_at, result_at, whatsapp_message_id, created_at FROM signals ORDER BY created_at DESC LIMIT $1`, [limit]);
  return rows.map(mapSignal);
}

export async function findSignalByIssue(issue) {
  const { rows } = await query('SELECT * FROM signals WHERE issue = $1 LIMIT 1', [issue]);
  return rows[0] ? mapSignal(rows[0]) : null;
}

export async function createSignal({ issue, predictionSize, predictionColor, confidence, whatsappMessageId }) {
  const { rows } = await query(`INSERT INTO signals (issue, prediction_size, prediction_color, confidence, whatsapp_message_id)
    VALUES ($1,$2,$3,$4,$5) ON CONFLICT (issue) DO NOTHING
    RETURNING id, issue, prediction_size, prediction_color, confidence, status, actual_number, actual_size, actual_color, sent_at, result_at, whatsapp_message_id, created_at`,
    [issue, predictionSize, predictionColor, confidence, whatsappMessageId || null]);
  return rows[0] ? mapSignal(rows[0]) : null;
}

export async function settleSignal(issue, result) {
  return withTransaction(async (client) => {
    const { rows: signalRows } = await client.query('SELECT * FROM signals WHERE issue = $1 FOR UPDATE', [issue]);
    const signal = signalRows[0];
    if (!signal || signal.status !== 'PENDING') return null;
    const outcome = signal.prediction_size === result.size && signal.prediction_color === result.baseColor ? 'WIN' : 'LOSS';
    const updated = await client.query(`UPDATE signals SET status=$1, actual_number=$2, actual_size=$3, actual_color=$4, result_at=NOW() WHERE id=$5
      RETURNING id, issue, prediction_size, prediction_color, confidence, status, actual_number, actual_size, actual_color, sent_at, result_at, whatsapp_message_id, created_at`,
      [outcome, result.number, result.size, result.color, signal.id]);
    await client.query(`INSERT INTO signal_results (signal_id, outcome, actual_number, actual_size, actual_color) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (signal_id) DO NOTHING`,
      [signal.id, outcome, result.number, result.size, result.color]);
    return mapSignal(updated.rows[0]);
  });
}

export async function getStatistics() {
  const { rows } = await query(`SELECT COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE status='WIN')::int AS wins,
    COUNT(*) FILTER (WHERE status='LOSS')::int AS losses,
    COUNT(*) FILTER (WHERE status='PENDING')::int AS pending
    FROM signals`);
  const r = rows[0];
  const decided = r.wins + r.losses;
  return { total:r.total, wins:r.wins, losses:r.losses, pending:r.pending, winRate: decided ? (r.wins/decided)*100 : 0 };
}

function mapSignal(row) {
  return {
    id: String(row.id), issue: row.issue,
    predictionSize: row.prediction_size, predictionColor: row.prediction_color,
    confidence: row.confidence, status: row.status,
    actualNumber: row.actual_number, actualSize: row.actual_size, actualColor: row.actual_color,
    sentAt: row.sent_at, resultAt: row.result_at, whatsappMessageId: row.whatsapp_message_id, createdAt: row.created_at,
  };
}
