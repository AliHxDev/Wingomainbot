import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api, clearToken, saveToken } from './api/client';
import Setup from './pages/Setup';
import Dashboard from './pages/Dashboard';
import Settings from './pages/Settings';

function Login({ onLogin }) {
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  async function submit(event) {
    event.preventDefault(); setLoading(true); setError('');
    try { const result = await api.login(password); saveToken(result.token); onLogin(); } catch (err) { setError(err.message); } finally { setLoading(false); }
  }
  return <div className="flex min-h-screen items-center justify-center px-6"><form onSubmit={submit} className="panel w-full max-w-md p-8"><div className="text-xs font-bold uppercase tracking-[0.25em] text-zinc-500">WinGo Signal Bot</div><h1 className="mt-2 text-3xl font-black">Dashboard Login</h1><p className="mt-2 text-sm text-zinc-400">Use the ADMIN_PASSWORD configured on the backend.</p>{error && <div className="mt-6 rounded-xl border border-red-900/60 bg-red-500/10 p-4 text-sm text-red-300">{error}</div>}<label className="label mt-6">Password</label><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus /><button className="btn-primary mt-4 w-full" disabled={loading || !password}>{loading ? 'Signing in…' : 'Sign in'}</button></form></div>;
}

function Layout({ onLogout }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [status, setStatus] = useState(null);
  useEffect(() => { api.getStatus().then(setStatus).catch(() => setStatus(null)); const timer = setInterval(() => api.getStatus().then(setStatus).catch(() => {}), 10000); return () => clearInterval(timer); }, []);
  const setupNeeded = !status?.channel;
  const nav = [{ path: '/', label: 'Dashboard' }, { path: '/setup', label: 'Setup' }, { path: '/settings', label: 'Settings' }];
  return <div className="min-h-screen bg-zinc-950 text-zinc-100"><header className="sticky top-0 z-20 border-b border-zinc-800 bg-zinc-950/90 backdrop-blur"><div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 md:px-6"><button onClick={() => navigate('/')} className="font-black tracking-tight">WinGo<span className="text-zinc-500">Bot</span></button><nav className="flex items-center gap-1">{nav.map((item) => <NavLink key={item.path} to={item.path} className={({ isActive }) => `rounded-lg px-3 py-2 text-sm ${isActive ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-white'}`}>{item.label}</NavLink>)}<button onClick={() => { clearToken(); onLogout(); }} className="ml-2 rounded-lg px-3 py-2 text-sm text-zinc-500 hover:text-white">Logout</button></nav></div></header><main className="mx-auto max-w-7xl px-4 py-8 md:px-6"><Routes><Route path="/" element={setupNeeded ? <Navigate to="/setup" replace /> : <Dashboard />} /><Route path="/setup" element={<Setup onComplete={() => navigate('/')} />} /><Route path="/settings" element={<Settings onLogout={onLogout} />} /><Route path="*" element={<Navigate to="/" replace />} /></Routes></main><footer className="mx-auto max-w-7xl px-4 pb-8 text-xs text-zinc-600 md:px-6">Channel: {status?.channel || 'not configured'} · Threshold: {status?.confidenceThreshold || 65}% · {location.pathname}</footer></div>;
}

export default function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const [checking, setChecking] = useState(true);
  useEffect(() => { api.me().then(() => setAuthenticated(true)).catch(() => setAuthenticated(false)).finally(() => setChecking(false)); }, []);
  if (checking) return <div className="flex min-h-screen items-center justify-center bg-zinc-950 text-zinc-500">Checking session…</div>;
  return authenticated ? <Layout onLogout={() => setAuthenticated(false)} /> : <Login onLogin={() => setAuthenticated(true)} />;
}
