/**
 * API client.
 *
 * One place that knows about error shapes and the base URL, so no component
 * ever touches fetch directly. There are no credentials to carry: the server
 * runs as a single local identity (see backend middleware/localUser.js).
 */

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
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      signal,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
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
    throw new ApiError(e.message ?? `Request failed (${res.status})`, {
      status: res.status,
      code: e.code,
      field: e.field,
    });
  }
  return payload;
}

export const api = {
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

/** SSE endpoint. EventSource cannot set headers, which no longer matters. */
export function streamUrl() {
  return '/api/stream/watchlist';
}
