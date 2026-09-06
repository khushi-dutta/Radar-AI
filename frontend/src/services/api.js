/**
 * API client.
 *
 * One place that knows about tokens, error shapes and the base URL, so no
 * component ever touches fetch directly.
 */

const TOKEN_KEY = 'radar.token';

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null; // private mode / storage disabled
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* non-fatal: the session simply will not persist */
  }
}

export class ApiError extends Error {
  constructor(message, { status, code, field } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

async function request(path, { method = 'GET', body, signal } = {}) {
  const token = getToken();
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      signal,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    // Distinguish "the network is gone" from "the server said no", because the
    // UI reacts very differently to the two.
    throw new ApiError('Cannot reach the server. Check your connection.', { status: 0, code: 'Offline' });
  }

  if (res.status === 204) return null;

  let payload = null;
  const text = await res.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!res.ok) {
    const e = payload?.error ?? {};
    // A 401 means the stored token is dead; clearing it here stops every
    // subsequent request from retrying with a credential we know is invalid.
    if (res.status === 401) setToken(null);
    throw new ApiError(e.message ?? `Request failed (${res.status})`, {
      status: res.status,
      code: e.code,
      field: e.field,
    });
  }
  return payload;
}

export const api = {
  register: (email, password) => request('/auth/register', { method: 'POST', body: { email, password } }),
  login: (email, password) => request('/auth/login', { method: 'POST', body: { email, password } }),
  me: () => request('/auth/me'),

  getWatchlist: ({ visit = false, signal } = {}) =>
    request(`/watchlist${visit ? '?visit=true' : ''}`, { signal }),
  refreshWatchlist: () => request('/watchlist/refresh', { method: 'POST' }),
  addStock: (symbol, extra = {}) => request('/watchlist', { method: 'POST', body: { symbol, ...extra } }),
  removeStock: (symbol) => request(`/watchlist/${encodeURIComponent(symbol)}`, { method: 'DELETE' }),
  updateStock: (symbol, patch) =>
    request(`/watchlist/${encodeURIComponent(symbol)}`, { method: 'PATCH', body: patch }),
  markAllSeen: () => request('/watchlist/mark-seen', { method: 'POST' }),
  markSeen: (symbol, reasonKey) => request(`/watchlist/${encodeURIComponent(symbol)}/seen`, { method: 'POST', body: reasonKey ? { reasonKey } : {} }),

  search: (q, signal) => request(`/search?q=${encodeURIComponent(q)}`, { signal }),
  marketStatus: () => request('/market/status'),

  getNews: (symbol) => request(`/watchlist/${encodeURIComponent(symbol)}/news`),
  getAlerts: () => request('/watchlist/alerts'),
  addAlert: (alert) => request('/watchlist/alerts', { method: 'POST', body: alert }),
  deleteAlert: (id) => request(`/watchlist/alerts/${id}`, { method: 'DELETE' }),
  getActivity: () => request('/watchlist/activity'),
};

/** SSE URL. EventSource cannot set headers, so the token rides the query. */
export function streamUrl() {
  const token = getToken();
  return `/api/stream/watchlist${token ? `?token=${encodeURIComponent(token)}` : ''}`;
}
