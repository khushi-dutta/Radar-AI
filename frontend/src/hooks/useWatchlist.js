import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, streamUrl } from '../services/api.js';

/**
 * Owns all watchlist state: the initial load, the live SSE stream, and the
 * optimistic mutations.
 *
 * The important bit is that SSE updates and user mutations write to the same
 * piece of state, so they must not fight. Mutations apply optimistically and
 * mark the symbol as "pending"; a stream frame arriving mid-flight is merged
 * rather than allowed to resurrect a row the user just deleted.
 */
export function useWatchlist({ enabled }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [connection, setConnection] = useState('connecting');


  // Symbols with an in-flight mutation. A stream frame must not undo them.
  const pendingRef = useRef(new Set());
  const dataRef = useRef(null);
  dataRef.current = data;

  const applyServerPayload = useCallback((payload) => {
    setData((prev) => {
      const pending = pendingRef.current;
      if (!pending.size) return payload;
      // Preserve local intent for rows the user is actively changing, and drop
      // rows they have optimistically removed.
      const prevSymbols = new Set((prev?.items ?? []).map((i) => i.symbol));
      const items = payload.items.filter((i) => !(pending.has(i.symbol) && !prevSymbols.has(i.symbol)));
      return { ...payload, items };
    });
  }, []);

  const load = useCallback(
    async ({ visit = false, quiet = false } = {}) => {
      if (!quiet) setLoading(true);
      try {
        const payload = await api.getWatchlist({ visit });
        applyServerPayload(payload);
        setError(null);
      } catch (err) {
        if (err.name === 'AbortError') return;
        setError(err);
      } finally {
        setLoading(false);
      }
    },
    [applyServerPayload]
  );

  // Guarded so the visit is registered exactly once per mount, rather than
  // twice under StrictMode's double-invoked effect.
  const visitedRef = useRef(false);
  useEffect(() => {
    if (!enabled || visitedRef.current) return;
    visitedRef.current = true;
    load({ visit: true });
  }, [enabled, load]);

  /* ------------------------------------------------------------------ SSE */

  useEffect(() => {
    if (!enabled) return undefined;

    let es;
    let retry = 0;
    let retryTimer;
    let cancelled = false;

    const connect = () => {
      if (cancelled) return;
      es = new EventSource(streamUrl());

      es.addEventListener('open', () => {
        retry = 0;
        setConnection('live');
      });

      es.addEventListener('watchlist', (evt) => {
        try {
          applyServerPayload(JSON.parse(evt.data));
          setConnection('live');
          setError(null);
        } catch {
          /* a malformed frame is not worth tearing the stream down for */
        }
      });

      es.addEventListener('error', () => {
        setConnection('reconnecting');
        es?.close();
        // EventSource auto-reconnects, but not with backoff. Doing it manually
        // stops a dead server from being hammered by every open tab.
        retry += 1;
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(retry, 5));
        retryTimer = setTimeout(connect, delay + Math.random() * 500);
      });
    };

    connect();
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      es?.close();
    };
  }, [enabled, applyServerPayload]);

  /**
   * Refetch when the tab comes back to the foreground.
   * A backgrounded tab may have missed stream frames or had its connection
   * dropped by the OS, and the user is about to look at these numbers.
   */
  useEffect(() => {
    if (!enabled) return undefined;
    const onVisible = () => {
      if (document.visibilityState === 'visible') load({ quiet: true });
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [enabled, load]);

  /* ------------------------------------------------------------ mutations */

  const withPending = useCallback(async (symbol, fn, rollback) => {
    pendingRef.current.add(symbol);
    try {
      await fn();
      await load({ quiet: true });
      return { ok: true };
    } catch (err) {
      rollback?.();
      return { ok: false, error: err };
    } finally {
      pendingRef.current.delete(symbol);
    }
  }, [load]);

  const addStock = useCallback(
    async (symbol, extra) => {
      const result = await withPending(symbol, () => api.addStock(symbol, extra));
      return result;
    },
    [withPending]
  );

  const removeStock = useCallback(
    async (symbol) => {
      const snapshot = dataRef.current;
      // Optimistic: the row disappears immediately, restored only if the
      // server rejects the delete.
      setData((prev) =>
        prev ? { ...prev, items: prev.items.filter((i) => i.symbol !== symbol) } : prev
      );
      return withPending(
        symbol,
        () => api.removeStock(symbol),
        () => setData(snapshot)
      );
    },
    [withPending]
  );

  const updateStock = useCallback(
    async (symbol, patch) => withPending(symbol, () => api.updateStock(symbol, patch)),
    [withPending]
  );

  const markAllSeen = useCallback(async () => {
    try {
      await api.markAllSeen();
      await load({ quiet: true });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err };
    }
  }, [load]);

  const markSeen = useCallback(
    async (symbol, reasonKey) => withPending(symbol, () => api.markSeen(symbol, reasonKey)),
    [withPending]
  );

  const refresh = useCallback(async () => {
    try {
      const payload = await api.refreshWatchlist();
      applyServerPayload(payload);
      setError(null);
      return { ok: true };
    } catch (err) {
      setError(err instanceof ApiError ? err : null);
      return { ok: false, error: err };
    }
  }, [applyServerPayload]);

  return {
    data,
    loading,
    error,
    connection,
    reload: load,
    refresh,
    addStock,
    removeStock,
    updateStock,
    markSeen,
    markAllSeen,
  };
}
