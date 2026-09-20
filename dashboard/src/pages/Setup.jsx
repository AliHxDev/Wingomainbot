import { useState } from 'react';
import { api } from '../api/client';

const steps = ['Phone', 'Pairing', 'Channel', 'Start'];

export default function Setup({ onComplete }) {
  const [step, setStep] = useState(0);
  const [phone, setPhone] = useState('923001234567');
  const [code, setCode] = useState('');
  const [channel, setChannel] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function requestPairing() {
    setLoading(true); setError(''); setMessage('');
    try {
      const result = await api.generateCode(phone);
      setCode(result.code || '');
      setMessage('Pairing code generated. Enter it in WhatsApp on your phone within 60 seconds.');
      setStep(1);
    } catch (err) {
      setError(err.message);
    } finally { setLoading(false); }
  }

  async function saveChannel() {
    setLoading(true); setError('');
    try {
      await api.setChannel(channel.trim());
      setStep(3);
      setMessage('Channel saved. Start the bot when your WhatsApp session shows connected.');
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  }

  async function startBot() {
    setLoading(true); setError('');
    try {
      await api.toggleBot(true);
      onComplete();
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <div>
        <div className="text-xs font-bold uppercase tracking-[0.25em] text-zinc-500">Setup Wizard</div>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">Connect WinGo Signal Bot</h1>
        <p className="mt-2 text-zinc-400">Pair WhatsApp without a QR, choose a channel, then activate signal delivery.</p>
      </div>

      <div className="grid grid-cols-4 gap-2">
        {steps.map((name, index) => (
          <div key={name} className={`rounded-xl border p-3 ${index <= step ? 'border-zinc-500 bg-zinc-800' : 'border-zinc-800 bg-zinc-900'}`}>
            <div className="text-xs text-zinc-500">0{index + 1}</div>
            <div className="mt-1 text-sm font-semibold">{name}</div>
          </div>
        ))}
      </div>

      {message && <div className="rounded-xl border border-emerald-900/60 bg-emerald-500/10 p-4 text-sm text-emerald-300">{message}</div>}
      {error && <div className="rounded-xl border border-red-900/60 bg-red-500/10 p-4 text-sm text-red-300">{error}</div>}

      <div className="panel p-6 md:p-8">
        {step === 0 && (
          <form onSubmit={(event) => { event.preventDefault(); requestPairing(); }} className="space-y-6">
            <div>
              <label className="label">WhatsApp phone</label>
              <input className="input" inputMode="numeric" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="923001234567" />
              <p className="mt-2 text-xs text-zinc-500">Use the full country code and digits only. Example: Pakistan 923001234567.</p>
            </div>
            <button className="btn-primary" disabled={loading || !phone.replace(/\D/g, '')}>{loading ? 'Requesting code…' : 'Generate pairing code'}</button>
          </form>
        )}

        {step === 1 && (
          <div className="space-y-6">
            <div>
              <label className="label">Pairing code</label>
              <div className="rounded-2xl border border-zinc-700 bg-zinc-950 px-6 py-8 text-center font-mono text-4xl font-black tracking-[0.35em] text-white">{code || '--------'}</div>
            </div>
            <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4 text-sm leading-6 text-zinc-300">
              On Android: WhatsApp → ⋮ → Linked devices → Link a device → Link with phone number → enter the code above. On iPhone: WhatsApp → Settings → Linked Devices → Link a Device → Link with phone number.
            </div>
            <button className="btn-primary" onClick={() => setStep(2)}>I paired WhatsApp — continue</button>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-6">
            <div>
              <label className="label">WhatsApp Channel / Newsletter ID</label>
              <input className="input" value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="120363123456789@newsletter" />
              <p className="mt-2 text-xs text-zinc-500">The bot sends text messages directly to this newsletter JID.</p>
            </div>
            <button className="btn-primary" disabled={loading || !channel.endsWith('@newsletter')} onClick={saveChannel}>{loading ? 'Saving…' : 'Save channel'}</button>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-6">
            <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-6">
              <div className="text-lg font-bold">Ready to start</div>
              <p className="mt-2 text-sm leading-6 text-zinc-400">The worker will fetch WinGo history every minute, analyze the latest 30 draws, send signals above the confidence threshold, and settle each signal after the next result arrives.</p>
            </div>
            <button className="btn-primary" disabled={loading} onClick={startBot}>{loading ? 'Starting…' : 'Start bot'}</button>
          </div>
        )}
      </div>
    </div>
  );
}
