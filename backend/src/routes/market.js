import { Router } from 'express';
import { attachUser } from '../middleware/localUser.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { searchUniverse, lookup, SECTOR_INDICES } from '../config/universe.js';
import { getBenchmarks, getCachedRows, toQuote, freshnessOf } from '../services/marketData.js';
import { worker } from '../services/backgroundWorker.js';
import { buildWatchlist, marketMeta } from '../services/watchlistService.js';
import { probeSymbol } from '../providers/yahoo.js';
import { validateSearchQuery, normalizeSymbol } from '../utils/validation.js';

const router = Router();

/**
 * GET /api/market/status
 * Needs no user: it describes the exchange, not anyone's watchlist.
 */
router.get('/market/status', (req, res) => {
  const benchmarks = [...getBenchmarks().entries()].map(([sector, b]) => ({
    sector,
    label: b.label ?? SECTOR_INDICES[sector]?.label,
    indexSymbol: b.indexSymbol,
    dayChangePct: b.dayChangePct,
    fetchedAt: b.fetchedAt,
  }));

  res.json({
    market: marketMeta(),
    worker: worker.health(),
    benchmarks,
    serverTime: new Date().toISOString(),
  });
});

/**
 * GET /api/search?q=
 *
 * Local-first. The curated universe answers instantly, costs no upstream quota,
 * and keeps working during an outage. Only a query that looks like a ticker we
 * do not know falls through to a single upstream probe.
 */
router.get(
  '/search',
  attachUser,
  asyncRoute(async (req, res) => {
    const q = validateSearchQuery(req.query.q);
    if (q.length < 1) return res.json({ query: q, results: [] });

    const local = searchUniverse(q, 8);
    const results = local.map((e) => ({
      symbol: e.symbol,
      name: e.name,
      sector: e.sector,
      source: 'universe',
    }));

    if (!results.length && q.length >= 2 && /^[A-Za-z0-9&.\-]+$/.test(q)) {
      try {
        const symbol = normalizeSymbol(q);
        const probed = await probeSymbol(symbol);
        if (probed) {
          results.push({
            symbol: probed.symbol,
            name: probed.name ?? probed.symbol,
            sector: null,
            source: 'upstream',
          });
        }
      } catch {
        // A failed probe just means no extra suggestion; the local results
        // (possibly empty) still stand. Search must never 500.
      }
    }

    res.json({ query: q, results });
  })
);

/** Cached quote for a single symbol; used by the detail panel. */
router.get(
  '/quote/:symbol',
  attachUser,
  asyncRoute(async (req, res) => {
    const symbol = normalizeSymbol(req.params.symbol);
    const row = getCachedRows([symbol]).get(symbol) ?? null;
    const quote = toQuote(row);
    if (!quote) {
      return res.status(404).json({ error: { message: `No cached data for ${symbol}`, code: 'NotFound' } });
    }
    res.json({ quote, freshness: freshnessOf(row), meta: lookup(symbol) });
  })
);

/**
 * GET /api/stream/watchlist  (Server-Sent Events)
 *
 * SSE over WebSocket because the traffic is strictly one-way, it rides on plain
 * HTTP (no upgrade path, no separate server), and browsers reconnect on their
 * own. A watchlist has no client->server realtime messages to send, so a
 * duplex protocol would be complexity bought for nothing.
 */
router.get('/stream/watchlist', attachUser, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // stop nginx-style proxies buffering the stream
  });
  res.flushHeaders?.();

  let closed = false;
  const send = (event, data) => {
    if (closed) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send('connected', { at: new Date().toISOString(), market: marketMeta() });

  // Push a fresh scoring pass whenever the worker lands new prices. Note this
  // is driven by the shared worker, so one refresh cycle serves every connected
  // client rather than each client driving its own polling.
  const onRefresh = async (info) => {
    if (closed) return;
    try {
      const payload = await buildWatchlist(req.user.id, { refresh: false });
      send('watchlist', { ...payload, trigger: info.at });
    } catch (err) {
      send('error', { message: 'Failed to rebuild watchlist' });
      console.error('[sse] rebuild failed', err);
    }
  };
  worker.on('refreshed', onRefresh);

  // Proxies and load balancers drop idle connections; a comment line is the
  // cheapest legal SSE keep-alive.
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, 25_000);

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    worker.off('refreshed', onRefresh);
  };

  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('error', cleanup);
});

export default router;
