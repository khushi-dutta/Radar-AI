/**
 * Market data cache and refresh coordination.
 *
 * The single most important rule in this file: HTTP request handlers never call
 * upstream. They read the cache. Refreshing is the background worker's job, and
 * on-demand refresh is an explicitly coalesced exception. This is what keeps
 * "one user with 100 stocks" and "100 users with the same 10 stocks" from both
 * turning into a burst of upstream requests.
 */

import { db, nowIso } from '../config/database.js';
import { fetchSnapshot, ProviderError } from '../providers/yahoo.js';
import { SECTOR_INDICES, benchmarkFor, lookup, allIndexSymbols } from '../config/universe.js';
import { cacheTtlMs, isMarketOpen, marketStatus } from '../utils/marketHours.js';

// 3 months is the smallest range that still yields a real 20-day volume mean, a
// 10-day channel and a 30-point sparkline. The 52-week extremes ride along in
// the payload metadata regardless of range, so a larger fetch buys nothing.
const FETCH_RANGE = '3mo';

// Upstream is unofficial and rate-limits readily. A small pool is not a
// performance compromise here, it is what keeps us from being throttled.
const MAX_CONCURRENT_FETCHES = 4;

// After this many consecutive failures a symbol is marked unavailable and the
// UI greys it out rather than showing a stale price as though it were current.
const FAILURE_THRESHOLD = 3;

/* ------------------------------------------------------------- persistence */

/**
 * Write a snapshot, but never let an older observation overwrite a newer one.
 *
 * This matters because refreshes are concurrent and retried: a slow request
 * issued at T can easily land after a fast one issued at T+60s. Without the
 * guard on source_ts the cache would visibly tick backwards, which looks
 * exactly like a bug to a user watching a price. The `WHERE` on the upsert
 * makes the write monotonic in upstream time, so out-of-order arrivals are
 * dropped instead of applied.
 *
 * COALESCE on the derived columns is the second half of the same idea: a
 * partial payload must not blank out good history we already hold.
 */
const upsertQuoteStmt = db.prepare(`
INSERT INTO market_data_cache (
  symbol, display_name, currency, current_price, previous_close, day_change_pct,
  day_high, day_low, volume, avg_volume_20d, high_52w, low_52w, high_2w, low_2w,
  sector, sparkline, source_ts, fetched_at, history_fetched_at, market_status,
  last_error, last_error_at, consecutive_failures, unavailable
) VALUES (
  @symbol, @display_name, @currency, @current_price, @previous_close, @day_change_pct,
  @day_high, @day_low, @volume, @avg_volume_20d, @high_52w, @low_52w, @high_2w, @low_2w,
  @sector, @sparkline, @source_ts, @fetched_at, @history_fetched_at, @market_status,
  NULL, NULL, 0, 0
)
ON CONFLICT(symbol) DO UPDATE SET
  display_name       = COALESCE(excluded.display_name, market_data_cache.display_name),
  currency           = COALESCE(excluded.currency, market_data_cache.currency),
  current_price      = excluded.current_price,
  previous_close     = COALESCE(excluded.previous_close, market_data_cache.previous_close),
  day_change_pct     = excluded.day_change_pct,
  day_high           = COALESCE(excluded.day_high, market_data_cache.day_high),
  day_low            = COALESCE(excluded.day_low, market_data_cache.day_low),
  volume             = COALESCE(excluded.volume, market_data_cache.volume),
  avg_volume_20d     = COALESCE(excluded.avg_volume_20d, market_data_cache.avg_volume_20d),
  high_52w           = COALESCE(excluded.high_52w, market_data_cache.high_52w),
  low_52w            = COALESCE(excluded.low_52w, market_data_cache.low_52w),
  high_2w            = COALESCE(excluded.high_2w, market_data_cache.high_2w),
  low_2w             = COALESCE(excluded.low_2w, market_data_cache.low_2w),
  sector             = COALESCE(excluded.sector, market_data_cache.sector),
  sparkline          = COALESCE(excluded.sparkline, market_data_cache.sparkline),
  source_ts          = excluded.source_ts,
  fetched_at         = excluded.fetched_at,
  history_fetched_at = excluded.history_fetched_at,
  market_status      = excluded.market_status,
  last_error           = NULL,
  last_error_at        = NULL,
  consecutive_failures = 0,
  unavailable          = 0
WHERE market_data_cache.source_ts IS NULL
   OR excluded.source_ts >= market_data_cache.source_ts
`);

export function saveSnapshot(snap) {
  const at = nowIso();
  const info = upsertQuoteStmt.run({
    symbol: snap.symbol,
    display_name: snap.displayName ?? lookup(snap.symbol)?.name ?? null,
    currency: snap.currency ?? 'INR',
    current_price: snap.price,
    previous_close: snap.previousClose,
    day_change_pct: snap.dayChangePct,
    day_high: snap.dayHigh,
    day_low: snap.dayLow,
    volume: snap.volume,
    avg_volume_20d: snap.avgVolume20d,
    high_52w: snap.high52w,
    low_52w: snap.low52w,
    high_2w: snap.high2w,
    low_2w: snap.low2w,
    sector: lookup(snap.symbol)?.sector ?? null,
    sparkline: snap.sparkline?.length ? JSON.stringify(snap.sparkline) : null,
    source_ts: snap.sourceTs,
    fetched_at: at,
    history_fetched_at: at,
    market_status: marketStatus(),
  });
  return info.changes > 0; // false => a newer observation already won
}

const recordFailureStmt = db.prepare(`
INSERT INTO market_data_cache (symbol, last_error, last_error_at, consecutive_failures, unavailable)
VALUES (@symbol, @error, @at, 1, @permanent)
ON CONFLICT(symbol) DO UPDATE SET
  last_error           = excluded.last_error,
  last_error_at        = excluded.last_error_at,
  consecutive_failures = market_data_cache.consecutive_failures + 1,
  unavailable          = CASE
    WHEN @permanent = 1 THEN 1
    WHEN market_data_cache.consecutive_failures + 1 >= ${FAILURE_THRESHOLD} THEN 1
    ELSE market_data_cache.unavailable
  END
`);

export function recordFailure(symbol, err) {
  recordFailureStmt.run({
    symbol,
    error: String(err?.message ?? err).slice(0, 300),
    at: nowIso(),
    permanent: err instanceof ProviderError && err.permanent ? 1 : 0,
  });
}

const saveBenchmarkStmt = db.prepare(`
INSERT INTO sector_benchmarks (sector, index_symbol, label, day_change_pct, current_price, source_ts, fetched_at)
VALUES (@sector, @index_symbol, @label, @day_change_pct, @current_price, @source_ts, @fetched_at)
ON CONFLICT(sector) DO UPDATE SET
  day_change_pct = excluded.day_change_pct,
  current_price  = excluded.current_price,
  source_ts      = excluded.source_ts,
  fetched_at     = excluded.fetched_at
WHERE sector_benchmarks.source_ts IS NULL
   OR excluded.source_ts >= sector_benchmarks.source_ts
`);

/** One index snapshot can back several sector keys; write each mapping. */
function saveBenchmarkSnapshot(snap) {
  const at = nowIso();
  for (const [sector, meta] of Object.entries(SECTOR_INDICES)) {
    if (meta.index !== snap.symbol) continue;
    saveBenchmarkStmt.run({
      sector,
      index_symbol: meta.index,
      label: meta.label,
      day_change_pct: snap.dayChangePct,
      current_price: snap.price,
      source_ts: snap.sourceTs,
      fetched_at: at,
    });
  }
}

/* ------------------------------------------------------------------- reads */

/** DB row -> the shape the significance engine expects. */
export function toQuote(row) {
  if (!row || row.current_price == null) return null;
  return {
    symbol: row.symbol,
    displayName: row.display_name,
    currency: row.currency ?? 'INR',
    price: row.current_price,
    previousClose: row.previous_close,
    dayChangePct: row.day_change_pct,
    dayHigh: row.day_high,
    dayLow: row.day_low,
    volume: row.volume,
    avgVolume20d: row.avg_volume_20d,
    high52w: row.high_52w,
    low52w: row.low_52w,
    high2w: row.high_2w,
    low2w: row.low_2w,
    sector: row.sector,
    sparkline: row.sparkline ? safeParse(row.sparkline) : null,
    fetchedAt: row.fetched_at,
    sourceTs: row.source_ts,
  };
}

function safeParse(json) {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Classify how much a caller should trust a cached row.
 *
 * The rule this encodes: never render stale data as if it were live. The API
 * always states its own age, and the UI is expected to show it. Silence about
 * freshness is the failure mode that actually costs users money.
 */
export function freshnessOf(row, now = new Date()) {
  if (!row?.fetched_at) {
    return { state: 'unavailable', ageSeconds: null, fetchedAt: null, label: 'No data yet' };
  }
  const ageMs = now.getTime() - new Date(row.fetched_at).getTime();
  const ageSeconds = Math.max(0, Math.round(ageMs / 1000));
  const ttl = cacheTtlMs(now);
  const open = isMarketOpen(now);

  if (row.unavailable) {
    return { state: 'unavailable', ageSeconds, fetchedAt: row.fetched_at, label: 'Data unavailable' };
  }
  if (!open) {
    // Off-hours the price is not supposed to be moving, so age is not a defect.
    return { state: 'closed', ageSeconds, fetchedAt: row.fetched_at, label: 'Market closed' };
  }
  if (ageMs <= ttl) {
    return { state: 'live', ageSeconds, fetchedAt: row.fetched_at, label: 'Live' };
  }
  if (ageMs <= ttl * 4) {
    return {
      state: 'delayed',
      ageSeconds,
      fetchedAt: row.fetched_at,
      label: `Delayed ~${Math.round(ageSeconds / 60)} min`,
    };
  }
  return {
    state: 'stale',
    ageSeconds,
    fetchedAt: row.fetched_at,
    label: `Stale since ${row.fetched_at}`,
  };
}

const selectBySymbolsStmt = (n) =>
  db.prepare(
    `SELECT * FROM market_data_cache WHERE symbol IN (${Array(n).fill('?').join(',')})`
  );

/** Batch cache read. One query for the whole watchlist, never one per symbol. */
export function getCachedRows(symbols) {
  if (!symbols.length) return new Map();
  const rows = selectBySymbolsStmt(symbols.length).all(...symbols);
  return new Map(rows.map((r) => [r.symbol, r]));
}

const selectBenchmarksStmt = db.prepare('SELECT * FROM sector_benchmarks');

/** sector key -> { dayChangePct, label, fetchedAt } */
export function getBenchmarks() {
  const out = new Map();
  for (const row of selectBenchmarksStmt.all()) {
    out.set(row.sector, {
      dayChangePct: row.day_change_pct,
      label: row.label,
      indexSymbol: row.index_symbol,
      fetchedAt: row.fetched_at,
    });
  }
  return out;
}

export function benchmarkForSymbol(symbol, benchmarks) {
  const meta = benchmarkFor(symbol);
  const sector = lookup(symbol)?.sector ?? 'BROAD';
  const b = benchmarks.get(sector);
  if (!b || b.dayChangePct == null) return null;
  return { dayChangePct: b.dayChangePct, label: b.label ?? meta.label };
}

/* -------------------------------------------------------------- refreshing */

/**
 * In-flight request registry: the single-flight guard.
 *
 * Without this, ten users opening the app at once on a cold cache would each
 * trigger their own fetch of the same ten symbols. With it, the first caller
 * fetches and the other nine await the same promise. This is the difference
 * between a cache and a cache stampede.
 */
const inFlight = new Map();

export function refreshSymbol(symbol) {
  const existing = inFlight.get(symbol);
  if (existing) return existing;

  const p = (async () => {
    try {
      const snap = await fetchSnapshot(symbol, { range: FETCH_RANGE });
      if (symbol.startsWith('^')) {
        saveBenchmarkSnapshot(snap);
      } else {
        saveSnapshot(snap);
      }
      return { symbol, ok: true };
    } catch (err) {
      if (!symbol.startsWith('^')) recordFailure(symbol, err);
      return { symbol, ok: false, error: err };
    } finally {
      inFlight.delete(symbol);
    }
  })();

  inFlight.set(symbol, p);
  return p;
}

/** Bounded-concurrency map. Keeps upstream pressure flat regardless of input size. */
async function pooled(items, worker, limit = MAX_CONCURRENT_FETCHES) {
  const results = [];
  let cursor = 0;
  const runners = Array(Math.min(limit, items.length))
    .fill(null)
    .map(async () => {
      while (cursor < items.length) {
        const i = cursor++;
        results[i] = await worker(items[i]);
      }
    });
  await Promise.all(runners);
  return results;
}

export function refreshSymbols(symbols) {
  return pooled([...new Set(symbols)], refreshSymbol);
}

/**
 * Refresh only the symbols whose cache has actually expired.
 *
 * Called on the read path when a user adds a brand-new symbol or the worker has
 * not caught up yet. Everything already fresh is skipped, so the common case
 * costs zero upstream requests.
 */
export async function ensureFresh(symbols, { now = new Date() } = {}) {
  if (!symbols.length) return;
  const rows = getCachedRows(symbols);
  const ttl = cacheTtlMs(now);
  const due = symbols.filter((s) => {
    const row = rows.get(s);
    if (!row?.fetched_at) return true;
    // Stop hammering a symbol upstream has repeatedly refused to serve.
    if (row.unavailable && row.consecutive_failures > FAILURE_THRESHOLD * 2) return false;
    return now.getTime() - new Date(row.fetched_at).getTime() > ttl;
  });
  if (due.length) await refreshSymbols(due);
}

export async function refreshBenchmarks() {
  return refreshSymbols(allIndexSymbols());
}

/** Every symbol any user is watching. The worker's unit of work. */
export function allWatchedSymbols() {
  return db
    .prepare('SELECT DISTINCT symbol FROM watchlist_items')
    .all()
    .map((r) => r.symbol);
}
