import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const api = async (path, options = {}) => {
  const response = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({ error: 'Invalid server response' }));
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
};

const fmtTime = (value) => value ? new Date(value).toLocaleTimeString() : '—';
const fmtDate = (value) => value ? new Date(value).toLocaleString() : '—';

function StatusPill({ status, children }) {
  return <span className={`pill pill-${status || 'neutral'}`}><span className="pill-dot" />{children}</span>;
}

function SetupWizard({ onDone }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setError('');
    if (password !== confirm) return setError('Passwords do not match');
    setBusy(true);
    try { await api('/api/auth/setup', { method: 'POST', body: JSON.stringify({ username, password }) }); onDone(); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return <div className="auth-shell"><div className="auth-card">
    <div className="brand-mark">W</div><h1>WinGo Signal Console</h1>
    <p className="muted">Create the one-time administrator account to begin.</p>
    <form onSubmit={submit} className="stack">
      <label>Username<input value={username} onChange={e => setUsername(e.target.value)} minLength="3" required /></label>
      <label>Password<input type="password" value={password} onChange={e => setPassword(e.target.value)} minLength="8" required /></label>
      <label>Confirm password<input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} minLength="8" required /></label>
      {error && <div className="error-box">{error}</div>}
      <button className="btn btn-primary" disabled={busy}>{busy ? 'Creating…' : 'Create Admin'}</button>
    </form>
  </div></div>;
}

function Login({ onDone }) {
  const [username, setUsername] = useState(''); const [password, setPassword] = useState('');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async e => { e.preventDefault(); setBusy(true); setError(''); try { await api('/api/auth/login', { method:'POST', body:JSON.stringify({ username, password }) }); onDone(); } catch(err){ setError(err.message); } finally { setBusy(false); } };
  return <div className="auth-shell"><div className="auth-card">
    <div className="brand-mark">W</div><h1>Welcome back</h1><p className="muted">Sign in to control the WinGo bot.</p>
    <form onSubmit={submit} className="stack">
      <label>Username<input value={username} onChange={e=>setUsername(e.target.value)} required /></label>
      <label>Password<input type="password" value={password} onChange={e=>setPassword(e.target.value)} required /></label>
      {error && <div className="error-box">{error}</div>}
      <button className="btn btn-primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign In'}</button>
    </form>
  </div></div>;
}

function App() {
  const [state, setState] = useState({ loading:true, setupRequired:false, authed:false });
  const [data, setData] = useState(null);
  const [notice, setNotice] = useState('');
  const load = async () => {
    try {
      const auth = await api('/api/auth/status');
      if (auth.setupRequired) return setState({ loading:false, setupRequired:true, authed:false });
      if (!auth.authenticated) return setState({ loading:false, setupRequired:false, authed:false });
      setState({ loading:false, setupRequired:false, authed:true });
      await refresh();
    } catch (err) { setNotice(err.message); setState(s=>({ ...s, loading:false })); }
  };
  const refresh = async () => {
    const payload = await api('/api/dashboard'); setData(payload); setNotice('');
  };
  useEffect(() => { load(); const t = setInterval(() => { if (state.authed) refresh().catch(()=>{}); }, 8000); return () => clearInterval(t); }, [state.authed]);
  if (state.loading) return <div className="center"><div className="loader" /></div>;
  if (state.setupRequired) return <SetupWizard onDone={load} />;
  if (!state.authed) return <Login onDone={load} />;
  if (!data) return <div className="center"><div className="loader" /></div>;
  return <Dashboard data={data} refresh={refresh} notice={notice} setNotice={setNotice} />;
}

function Dashboard({ data, refresh, notice, setNotice }) {
  const [tab, setTab] = useState('overview');
  const [pairPhone, setPairPhone] = useState(''); const [pairCode, setPairCode] = useState(''); const [pairBusy, setPairBusy] = useState(false);
  const [recipients, setRecipients] = useState((data.channel?.recipients || []).join('\n'));
  const [threshold, setThreshold] = useState(String(data.settings.confidenceThreshold)); const [interval, setIntervalValue] = useState(String(data.settings.pollIntervalSeconds));
  const [saving, setSaving] = useState(false); const [actionBusy, setActionBusy] = useState(false);
  useEffect(() => {
    if (!pairCode || data.whatsapp.status === 'open') return;
    const timer = setInterval(async () => {
      try {
        const status = await api('/api/whatsapp/status');
        if (status.pairingCode && status.pairingCode !== pairCode) setPairCode(status.pairingCode);
        if (status.status === 'open') { setPairCode(''); await refresh(); }
      } catch {}
    }, 2000);
    return () => clearInterval(timer);
  }, [pairCode, data.whatsapp.status]);

  const stats = data.statistics;
  const latest = data.latestSignal;
  const next = data.bot.currentPeriod || '—';

  const act = async (path, method='POST', body) => { setActionBusy(true); try { await api(path,{method, body: body ? JSON.stringify(body):undefined}); await refresh(); setNotice('Saved'); } catch(e){ setNotice(e.message); } finally { setActionBusy(false); } };
  const saveConfig = async e => { e.preventDefault(); setSaving(true); try { const list=recipients.split(/[\n,]+/).map(x=>x.trim()).filter(Boolean); await api('/api/channel',{method:'PUT',body:JSON.stringify({recipients:list})}); await api('/api/settings',{method:'PUT',body:JSON.stringify({confidenceThreshold:Number(threshold),pollIntervalSeconds:Number(interval)})}); await refresh(); setNotice('Configuration saved'); } catch(e){ setNotice(e.message); } finally { setSaving(false); } };
  const pair = async () => { setPairBusy(true); setNotice(''); try { const r=await api('/api/whatsapp/pairing',{method:'POST',body:JSON.stringify({phoneNumber:pairPhone})}); setPairCode(r.code || ''); await refresh(); } catch(e){ setNotice(e.message); } finally { setPairBusy(false); } };
  const logout = async () => { try { await api('/api/auth/logout',{method:'POST'}); window.location.reload(); } catch(e){setNotice(e.message);} };
  const botStatus = data.bot.running ? 'running':'stopped';
  return <div className="app-shell">
    <header className="topbar"><div><div className="eyebrow">OPERATIONS CONSOLE</div><h2>WinGo Signal Bot</h2></div><div className="top-actions"><StatusPill status={data.whatsapp.status === 'open' ? 'ok' : data.whatsapp.status === 'connecting' ? 'warn':'neutral'}>WhatsApp {data.whatsapp.status}</StatusPill><button className="btn btn-ghost" onClick={logout}>Logout</button></div></header>
    <div className="layout"><aside className="sidebar"><div className="sidebar-brand"><span className="brand-mark small">W</span><span>WinGo 1M</span></div>{['overview','whatsapp','signals','settings'].map(item=><button key={item} className={`nav-item ${tab===item?'active':''}`} onClick={()=>setTab(item)}>{item[0].toUpperCase()+item.slice(1)}</button>)}<div className="sidebar-foot"><div className="muted tiny">Bot process</div><StatusPill status={botStatus==='running'?'ok':'neutral'}>{botStatus}</StatusPill></div></aside>
      <main className="main">{notice && <div className="notice">{notice}</div>}
      {tab==='overview' && <Overview data={data} latest={latest} next={next} actionBusy={actionBusy} act={act} />}
      {tab==='whatsapp' && <section className="grid two"><Card title="WhatsApp pairing" subtitle="Baileys pairing-code login; QR authentication is disabled. Use the full international number without +. Code generation can take a few seconds while WhatsApp connects."><div className="status-grid"><div><span className="label">Connection</span><strong>{data.whatsapp.status}</strong></div><div><span className="label">Phone</span><strong>{data.whatsapp.phone || 'Not linked'}</strong></div><div><span className="label">Last error</span><strong className="truncate">{data.whatsapp.lastError || '—'}</strong></div></div><div className="divider"/><div className="stack"><label>Phone number (full international format, digits only)<input value={pairPhone} onChange={e=>setPairPhone(e.target.value.replace(/\D/g,''))} inputMode="numeric" aria-label="923001234567" /></label><button className="btn btn-primary" disabled={pairBusy} onClick={pair}>{pairBusy?'Generating…':'Generate Pairing Code'}</button>{pairCode && <div className="pair-code"><span>PAIRING CODE</span><code>{pairCode}</code><small>Enter this code in WhatsApp → Linked devices. If WhatsApp reconnects, the displayed code refreshes automatically.</small></div>}</div><div className="button-row"><button className="btn btn-ghost" disabled={actionBusy} onClick={()=>act('/api/whatsapp/reconnect')}>Reconnect</button><button className="btn btn-danger" disabled={actionBusy} onClick={()=>act('/api/whatsapp/logout')}>Logout WhatsApp</button></div></Card><Card title="Channel recipients" subtitle="One phone, group JID, or valid Baileys JID per line."><form onSubmit={saveConfig} className="stack"><label>Recipients<textarea rows="7" value={recipients} onChange={e=>setRecipients(e.target.value)} aria-label="Recipient JIDs" /></label><button className="btn btn-primary" disabled={saving}>{saving?'Saving…':'Save Recipients'}</button></form></Card></section>}
      {tab==='signals' && <Signals data={data} />}
      {tab==='settings' && <section className="grid two"><Card title="Engine settings" subtitle="Deterministic model controls."><form onSubmit={saveConfig} className="stack"><label>Confidence threshold<input type="number" min="50" max="95" value={threshold} onChange={e=>setThreshold(e.target.value)} /><span className="help">Signals are sent only at or above this score.</span></label><label>Poll interval (seconds)<input type="number" min="30" max="300" value={interval} onChange={e=>setIntervalValue(e.target.value)} /></label><button className="btn btn-primary" disabled={saving}>{saving?'Saving…':'Save Settings'}</button></form></Card><Card title="Bot controls" subtitle="The loop runs inside this Render Web Service."><div className="control-card"><div><span className="label">Status</span><strong>{data.bot.running?'Running':'Stopped'}</strong></div>{data.bot.running?<button className="btn btn-danger" onClick={()=>act('/api/bot/stop')}>Stop Bot</button>:<button className="btn btn-primary" onClick={()=>act('/api/bot/start')}>Start Bot</button>}</div><div className="divider"/><div className="status-grid"><div><span className="label">Current period</span><strong>{data.bot.currentPeriod || '—'}</strong></div><div><span className="label">Last poll</span><strong>{fmtTime(data.bot.lastPollAt)}</strong></div><div><span className="label">Bot error</span><strong>{data.bot.lastError || '—'}</strong></div></div></Card></section>}
      </main></div>
  </div>;
}


function Countdown() {
  const [remaining, setRemaining] = useState(60 - new Date().getSeconds());
  useEffect(() => { const t=setInterval(()=>setRemaining(60-new Date().getSeconds()),1000); return ()=>clearInterval(t); },[]);
  return <div className="countdown"><span className="label">Next WinGo period</span><strong>00:{String(Math.max(0,remaining)%60).padStart(2,'0')}</strong></div>;
}

function Overview({ data, latest, next, actionBusy, act }) {
  const winRate = data.statistics.winRate.toFixed(1);
  return <>
    <section className="hero-grid"><Card title="Live status" subtitle="Process and WinGo polling state."><div className="live-row"><div><span className="label">Bot</span><strong>{data.bot.running?'Running':'Stopped'}</strong></div><div><span className="label">WhatsApp</span><strong>{data.whatsapp.status}</strong></div><div><span className="label">Current period</span><strong>{next}</strong></div></div><div className="countdown-row"><Countdown /></div><div className="button-row"><button className="btn btn-ghost" disabled={actionBusy} onClick={()=>act('/api/whatsapp/reconnect')}>Reconnect</button>{data.bot.running?<button className="btn btn-danger" disabled={actionBusy} onClick={()=>act('/api/bot/stop')}>Stop Bot</button>:<button className="btn btn-primary" disabled={actionBusy} onClick={()=>act('/api/bot/start')}>Start Bot</button>}</div></Card><Card title="Latest signal" subtitle="Most recently sent prediction.">{latest?<div className="signal-focus"><div className="signal-badge">{latest.predictionSize==='BIG'?'🔺':'🔻'}</div><div><strong>{latest.predictionSize} · {latest.predictionColor}</strong><div className="muted">Period {latest.issue}</div></div><div className="confidence">{latest.confidence}%<span>confidence</span></div></div>:<div className="empty">No signal has been sent yet.</div>}</Card></section>
    <section className="stats-grid"><Stat label="WIN" value={data.statistics.wins} tone="win"/><Stat label="LOSS" value={data.statistics.losses} tone="loss"/><Stat label="WIN RATE" value={`${winRate}%`} tone="neutral"/><Stat label="PENDING" value={data.statistics.pending} tone="neutral"/></section>
    <Signals data={data} compact />
  </>;
}

function Stat({label,value,tone}){ return <div className={`stat-card ${tone}`}><span className="label">{label}</span><strong>{value}</strong></div>; }
function Card({title,subtitle,children}){ return <section className="card"><div className="card-head"><div><h3>{title}</h3>{subtitle&&<p className="muted">{subtitle}</p>}</div></div>{children}</section>; }
function Signals({data,compact=false}){ const rows=useMemo(()=>compact?data.signals.slice(0,8):data.signals,[data.signals,compact]); return <Card title={compact?'Recent signals':'Signal history'} subtitle="Predictions are settled only when the matching WinGo result is observed."><div className="table-wrap"><table><thead><tr><th>Period</th><th>Prediction</th><th>Confidence</th><th>Status</th><th>Result</th><th>Created</th></tr></thead><tbody>{rows.map(s=><tr key={s.id}><td className="mono">{s.issue}</td><td>{s.predictionSize} {s.predictionColor}</td><td>{s.confidence}%</td><td><StatusPill status={s.status==='WIN'?'ok':s.status==='LOSS'?'bad':'warn'}>{s.status}</StatusPill></td><td>{s.actualNumber == null?'—':`${s.actualNumber} (${s.actualSize}, ${s.actualColor})`}</td><td>{fmtDate(s.createdAt)}</td></tr>)}{rows.length===0&&<tr><td colSpan="6" className="empty-cell">No signals yet.</td></tr>}</tbody></table></div></Card>;}

createRoot(document.getElementById('root')).render(<App />);
