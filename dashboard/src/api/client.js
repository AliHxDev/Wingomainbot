const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:10000').replace(/\/$/, '');
const TOKEN_KEY = 'wingo_admin_token';

function token() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function saveToken(value) {
  localStorage.setItem(TOKEN_KEY, value);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('Content-Type', 'application/json');
  const currentToken = token();
  if (currentToken) headers.set('Authorization', `Bearer ${currentToken}`);

  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  let body = null;
  try { body = await response.json(); } catch {}
  if (!response.ok) {
    const error = new Error(body?.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return body;
}

export const api = {
  login: (password) => request('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) }),
  me: () => request('/api/auth/me'),
  generateCode: (phone) => request('/api/generate-code', { method: 'POST', body: JSON.stringify({ phone }) }),
  setChannel: (channelId) => request('/api/set-channel', { method: 'POST', body: JSON.stringify({ channelId }) }),
  getStatus: () => request('/api/status'),
  toggleBot: (active) => request('/api/toggle-bot', { method: 'POST', body: JSON.stringify({ active }) }),
  getStats: () => request('/api/status/stats'),
  getSignals: (limit = 100) => request(`/api/status/signals?limit=${limit}`),
  reconnect: () => request('/api/reconnect', { method: 'POST' }),
  setConfidence: (confidenceThreshold) => request('/api/settings/confidence', { method: 'POST', body: JSON.stringify({ confidenceThreshold }) })
};
