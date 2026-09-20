import { query } from '../db/index.mjs';

export async function getBotState() {
  const { rows } = await query('SELECT id, running, status, current_period, last_issue, last_poll_at, last_error, connected_at, updated_at FROM bot_state WHERE id = 1');
  const r = rows[0];
  return r ? {
    running: r.running, status: r.status, currentPeriod: r.current_period, lastIssue: r.last_issue,
    lastPollAt: r.last_poll_at, lastError: r.last_error, connectedAt: r.connected_at, updatedAt: r.updated_at,
  } : { running:false, status:'stopped' };
}

export async function patchBotState(patch) {
  const current = await getBotState();
  const next = { ...current, ...patch };
  await query(`UPDATE bot_state SET running=$1,status=$2,current_period=$3,last_issue=$4,last_poll_at=$5,last_error=$6,connected_at=$7,updated_at=NOW() WHERE id=1`, [
    next.running,
    next.status,
    next.currentPeriod ?? null,
    next.lastIssue ?? null,
    next.lastPollAt ?? null,
    next.lastError ?? null,
    next.connectedAt ?? null,
  ]);
  return getBotState();
}
