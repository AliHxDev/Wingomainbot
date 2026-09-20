import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';

function formatDuration(ms) {
  let seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400); seconds %= 86400;
  const hours = Math.floor(seconds / 3600); seconds %= 3600;
  const minutes = Math.floor(seconds / 60); seconds %= 60;
  return `${days ? `${days}d ` : ''}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function StatusPill({ connected }) {
  return <span className={`rounded-full px-3 py-1 text-xs font-bold ${connected ? 'bg-emerald-400/15 text-emerald-300' : 'bg-red-400/15 text-red-300'}`}>{connected ? 'CONNECTED' : 'OFFLINE'}</span>;
}

function WinRateChart({ signals }) {
  const settled = [...signals].filter((s) => s.outcome === 'WIN' || s.outcome === 'LOSS').slice(0, 20).reverse();
  const points = settled.length > 1 ? settled.map((signal, index) => `${(index / (settled.length - 1)) * 100},${signal.outcome === 'WIN' ? 15 : 85}`).join(' ') : '0,50 100,50';
  return (
    <div className="mt-5 h-48 rounded-xl border border-zinc-800 bg-zinc-950 p-3">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full">
        <polyline fill="none" stroke="currentColor" strokeWidth="2" points={points} className="text-zinc-200" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

export default function Dashboard() {
  const [status, setStatus] = useState(null);
  const [signals, setSignals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());

  async function refresh() {
    try {
      const [nextStatus, nextSignals] = await Promise.all([api.getStatus(), api.getSignals(100)]);
      setStatus(nextStatus); setSignals(nextSignals.signals || []); setError('');
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  }

  useEffect(() => {
    refresh();
    const poll = setInterval(refresh, 5000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(poll); clearInterval(clock); };
  }, []);

  async function toggle() {
    if (!status) return;
    setAction(true);
    try { await api.toggleBot(!status.botActive); await refresh(); } catch (err) { setError(err.message); } finally { setAction(false); }
  }

  const latest = signals[0];
  const nextDrawMs = 60_000 - (now % 60_000);
  const winRate = useMemo(() => status?.stats?.winRate ?? 0, [status]);

  if (loading && !status) return <div className="panel p-8 text-zinc-400">Loading dashboard…</div>;

  return (
    <div className="space-y-6">
      {error && <div className="rounded-xl border border-red-900/60 bg-red-500/10 p-4 text-sm text-red-300">{error}</div>}
      <div className="grid gap-4 md:grid-cols-4">
        <div className="panel p-5"><div className="label">WhatsApp</div><div className="flex items-center gap-2"><StatusPill connected={status?.connected} /></div><div className="mt-3 text-sm text-zinc-400">{status?.phone || 'Not paired'}</div></div>
        <div className="panel p-5"><div className="label">Bot</div><div className="text-2xl font-bold">{status?.botActive ? 'Running' : 'Paused'}</div><div className="mt-3 text-sm text-zinc-400">Bot service: {status?.workerBotActive ? 'active' : 'idle'}</div></div>
        <div className="panel p-5"><div className="label">Win rate</div><div className="text-2xl font-bold">{winRate.toFixed(2)}%</div><div className="mt-3 text-sm text-zinc-400">{status?.stats?.wins || 0} wins · {status?.stats?.losses || 0} losses</div></div>
        <div className="panel p-5"><div className="label">Next cycle</div><div className="text-2xl font-bold">{Math.ceil(nextDrawMs / 1000)}s</div><div className="mt-3 text-sm text-zinc-400">Bot service uptime {formatDuration(status?.uptime || 0)}</div></div>
      </div>

      <div className="flex flex-col justify-between gap-4 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 md:flex-row md:items-center">
        <div><div className="text-sm text-zinc-500">Target channel</div><div className="mt-1 font-mono text-sm text-white">{status?.channel || 'Not configured'}</div></div>
        <button className={status?.botActive ? 'btn-danger' : 'btn-primary'} onClick={toggle} disabled={action || !status?.channel || !status?.connected}>{action ? 'Updating…' : status?.botActive ? 'Pause bot' : 'Start bot'}</button>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="panel p-6">
          <div className="flex items-center justify-between"><div><div className="label">Latest signal</div><div className="text-xl font-bold">{latest ? latest.issueNumber : 'Waiting for signal'}</div></div>{latest && <span className="rounded-full bg-zinc-800 px-3 py-1 text-xs font-semibold">{latest.outcome || 'PENDING'}</span>}</div>
          {latest && <div className="mt-6 grid grid-cols-3 gap-3"><div className="rounded-xl bg-zinc-950 p-4"><div className="text-xs text-zinc-500">Prediction</div><div className="mt-1 font-bold">{latest.predictionSize}</div></div><div className="rounded-xl bg-zinc-950 p-4"><div className="text-xs text-zinc-500">Color</div><div className="mt-1 font-bold">{latest.predictionColor}</div></div><div className="rounded-xl bg-zinc-950 p-4"><div className="text-xs text-zinc-500">Confidence</div><div className="mt-1 font-bold">{latest.confidence}%</div></div></div>}
        </div>
        <div className="panel p-6"><div className="label">Recent outcome chart</div><div className="mt-1 text-xl font-bold">Wins / Losses</div><WinRateChart signals={signals} /></div>
      </div>

      <div className="panel overflow-hidden">
        <div className="border-b border-zinc-800 p-6"><div className="label">Signal history</div><div className="text-xl font-bold">Latest 100 signals</div></div>
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="bg-zinc-950/70 text-xs uppercase tracking-wider text-zinc-500"><tr><th className="px-6 py-4">Period</th><th className="px-6 py-4">Prediction</th><th className="px-6 py-4">Result</th><th className="px-6 py-4">Confidence</th><th className="px-6 py-4">Outcome</th></tr></thead><tbody className="divide-y divide-zinc-800">{signals.map((signal) => <tr key={signal.id}><td className="px-6 py-4 font-mono">{signal.issueNumber}</td><td className="px-6 py-4">{signal.predictionSize} · {signal.predictionColor}</td><td className="px-6 py-4">{signal.resultNumber ? `${signal.resultNumber} · ${signal.resultSize} · ${signal.resultColor}` : 'Pending'}</td><td className="px-6 py-4">{signal.confidence}%</td><td className="px-6 py-4"><span className={signal.outcome === 'WIN' ? 'text-emerald-300' : signal.outcome === 'LOSS' ? 'text-red-300' : 'text-zinc-400'}>{signal.outcome || 'PENDING'}</span></td></tr>)}{signals.length === 0 && <tr><td colSpan="5" className="px-6 py-10 text-center text-zinc-500">No signals have been sent yet.</td></tr>}</tbody></table></div>
      </div>
    </div>
  );
}
