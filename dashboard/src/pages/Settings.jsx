import { useEffect, useState } from 'react';
import { api, clearToken } from '../api/client';

export default function Settings({ onLogout }) {
  const [channel, setChannel] = useState('');
  const [threshold, setThreshold] = useState(65);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api.getStatus().then((status) => { setChannel(status.channel || ''); setThreshold(status.confidenceThreshold || 65); }).catch((err) => setError(err.message));
  }, []);

  async function saveChannel() {
    setSaving(true); setError(''); setMessage('');
    try { await api.setChannel(channel.trim()); setMessage('Channel updated.'); } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  async function reconnect() {
    setSaving(true); setError(''); setMessage('');
    try { await api.reconnect(); setMessage('Reconnect requested. The worker will reconnect shortly.'); } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  async function changeThreshold(event) {
    const value = Math.max(65, Math.min(95, Number(event.target.value)));
    setThreshold(value);
    setSaving(true); setError(''); setMessage('');
    try {
      const apiBase = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:10000').replace(/\/$/, '');
      const response = await fetch(`${apiBase}/api/settings/confidence`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('wingo_admin_token') || ''}`
        },
        body: JSON.stringify({ confidenceThreshold: value })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Failed to save confidence threshold');
      setMessage('Confidence threshold saved.');
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  function logout() { clearToken(); onLogout(); }

  return (
    <div className="max-w-3xl space-y-6">
      <div><div className="label">Settings</div><h1 className="text-3xl font-bold">Bot configuration</h1><p className="mt-2 text-zinc-400">Manage the WhatsApp target, confidence filter, and session connection.</p></div>
      {message && <div className="rounded-xl border border-emerald-900/60 bg-emerald-500/10 p-4 text-sm text-emerald-300">{message}</div>}
      {error && <div className="rounded-xl border border-red-900/60 bg-red-500/10 p-4 text-sm text-red-300">{error}</div>}
      <div className="panel p-6 space-y-6">
        <div><label className="label">Channel ID</label><input className="input" value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="120363123456789@newsletter" /><button className="btn-primary mt-3" disabled={saving || !channel.endsWith('@newsletter')} onClick={saveChannel}>Save channel</button></div>
        <div className="border-t border-zinc-800 pt-6"><label className="label">Minimum confidence: {threshold}%</label><input type="range" min="65" max="95" step="1" value={threshold} onChange={changeThreshold} className="w-full accent-white" /><div className="mt-2 flex justify-between text-xs text-zinc-600"><span>65%</span><span>95%</span></div></div>
        <div className="border-t border-zinc-800 pt-6"><button className="btn-muted" disabled={saving} onClick={reconnect}>Reconnect WhatsApp</button><p className="mt-2 text-xs text-zinc-500">The worker owns the Baileys session and will reconnect without a QR.</p></div>
        <div className="border-t border-zinc-800 pt-6"><button className="btn-danger" onClick={logout}>Logout dashboard</button></div>
      </div>
    </div>
  );
}
