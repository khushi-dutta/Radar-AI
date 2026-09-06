/**
 * Assembles the watchlist response: cache rows + user view-state -> scored,
 * sorted, self-describing payload.
 *
 * Performance shape, which is the whole answer to "what if someone adds 100
 * stocks": three DB queries regardless of list size (items, cached quotes,
 * benchmarks), then a pure O(n) scoring loop. There is no per-symbol await on
 * the read path, so a 100-symbol list costs essentially the same as a 5-symbol
 * one plus arithmetic.
 */

import { listItems, getViews } from '../models/watchlistModel.js';
import {
  getCachedRows,
  getBenchmarks,
  benchmarkForSymbol,
  toQuote,
  freshnessOf,
  ensureFresh,
} from './marketData.js';
import { computeSignificance, SIGNIFICANCE_THRESHOLD } from './significance.js';
import { lookup } from '../config/universe.js';
import { marketStatus, isMarketOpen, nextTradingDay, istDateKey } from '../utils/marketHours.js';

/**
 * How long a read may block waiting for a cold-cache refresh.
 *
 * A watchlist that renders stale-but-labelled in 2.5s beats one that spins for
 * 30s waiting on an unofficial API that may never answer. Past the deadline we
 * serve what we have; the freshness flags stop it from being a lie.
 */
const REFRESH_DEADLINE_MS = 2500;

function withDeadline(promise, ms) {
  return Promise.race([
    promise.catch(() => null), // upstream failures must not fail the read
    new Promise((resolve) => setTimeout(() => resolve('deadline'), ms)),
  ]);
}

const MARKET_LABELS = {
  open: 'Market open',
  pre_open: 'Pre-open',
  closed: 'Market closed',
};

export function marketMeta(now = new Date()) {
  const status = marketStatus(now);
  return {
    status,
    label: MARKET_LABELS[status] ?? 'Unknown',
    isOpen: status === 'open',
    istDate: istDateKey(now),
    nextTradingDay: status === 'open' ? null : nextTradingDay(now),
  };
}

/**
 * Roll per-symbol freshness into one honest headline for the whole list.
 * The worst symbol governs: claiming "live" while one row is 40 minutes old
 * is precisely the failure this product is supposed to avoid.
 */
function aggregateFreshness(perItem, now) {
  if (!perItem.length) {
    return { state: 'empty', staleCount: 0, unavailableCount: 0, oldestFetchedAt: null };
  }
  const rank = { live: 0, closed: 0, delayed: 1, stale: 2, unavailable: 3 };
  let worst = 'live';
  let staleCount = 0;
  let unavailableCount = 0;
  let oldest = null;

  for (const f of perItem) {
    if ((rank[f.state] ?? 0) > (rank[worst] ?? 0)) worst = f.state;
    if (f.state === 'stale' || f.state === 'delayed') staleCount++;
    if (f.state === 'unavailable') unavailableCount++;
    if (f.fetchedAt && (!oldest || f.fetchedAt < oldest)) oldest = f.fetchedAt;
  }

  return {
    state: worst,
    staleCount,
    unavailableCount,
    oldestFetchedAt: oldest,
    ageSeconds: oldest ? Math.max(0, Math.round((now.getTime() - new Date(oldest).getTime()) / 1000)) : null,
  };
}

function shapeItem({ item, row, quote, benchmark, view, significance, now }) {
  const freshness = freshnessOf(row, now);
  const meta = lookup(item.symbol);
  const pnlPct =
    quote?.price != null && item.buy_price
      ? Number((((quote.price - item.buy_price) / item.buy_price) * 100).toFixed(2))
      : null;

  return {
    symbol: item.symbol,
    displayName: item.display_name ?? quote?.displayName ?? meta?.name ?? item.symbol,
    sector: meta?.sector ?? row?.sector ?? null,
    currency: quote?.currency ?? 'INR',
    addedAt: item.added_at,

    price: quote?.price ?? null,
    previousClose: quote?.previousClose ?? null,
    dayChangePct: quote?.dayChangePct ?? null,
    dayHigh: quote?.dayHigh ?? null,
    dayLow: quote?.dayLow ?? null,
    volume: quote?.volume ?? null,
    avgVolume20d: quote?.avgVolume20d ?? null,
    high52w: quote?.high52w ?? null,
    low52w: quote?.low52w ?? null,
    high2w: quote?.high2w ?? null,
    low2w: quote?.low2w ?? null,
    sparkline: quote?.sparkline ?? null,

    buyPrice: item.buy_price,
    alertPrice: item.alert_price,
    pnlPct,

    benchmark,
    freshness,
    unavailable: !quote || Boolean(row?.unavailable),
    lastSeen: view
      ? { at: view.last_viewed_at, price: view.last_viewed_price, volume: view.last_viewed_volume }
      : null,
    significance,
  };
}

/**
 * Build the full watchlist payload for a user.
 * @param {string} userId
 * @param {{ now?: Date, refresh?: boolean }} opts
 */
export async function buildWatchlist(userId, { now = new Date(), refresh = true } = {}) {
  const items = listItems(userId);
  const symbols = items.map((i) => i.symbol);

  // Only ever a cold-cache safety net; the worker keeps the cache warm, and
  // ensureFresh no-ops for anything already inside its TTL.
  let refreshTimedOut = false;
  if (refresh && symbols.length) {
    const outcome = await withDeadline(ensureFresh(symbols, { now }), REFRESH_DEADLINE_MS);
    refreshTimedOut = outcome === 'deadline';
  }

  const rows = getCachedRows(symbols);
  const benchmarks = getBenchmarks();
  const views = getViews(userId);
  const status = marketStatus(now);

  const { findById } = await import('../models/userModel.js');
  const user = findById(userId);
  let userWeights = {};
  if (user && user.preferences) {
    try {
      userWeights = JSON.parse(user.preferences);
    } catch (e) {}
  }

  const shaped = items.map((item) => {
    const row = rows.get(item.symbol) ?? null;
    const quote = toQuote(row);
    const benchmark = benchmarkForSymbol(item.symbol, benchmarks);
    const view = views.get(item.symbol) ?? null;

    const significance = computeSignificance({
      quote,
      benchmark,
      view,
      item,
      now,
      marketStatus: status,
      userWeights,
    });

    return shapeItem({ item, row, quote, benchmark, view, significance, now });
  });

  // Unavailable rows sink to the bottom regardless of score: a card we cannot
  // price has nothing to say, and it should never outrank one that does.
  shaped.sort((a, b) => {
    if (a.unavailable !== b.unavailable) return a.unavailable ? 1 : -1;
    return b.significance.score - a.significance.score;
  });

  const freshness = aggregateFreshness(shaped.map((s) => s.freshness), now);

  // The anchor the "since you last checked" header describes.
  //
  // This is deliberately derived from user_stock_views -- the SAME baseline the
  // per-card numbers compare against -- rather than from users.last_seen_at.
  // Those are two different clocks and using one for the header and the other
  // for the cards made the page contradict itself: the header said "1 minute
  // ago" (this page load) above cards reporting three-day moves (the last
  // acknowledgement). Visiting is not acknowledging. Only "mark seen" moves
  // this, which is exactly what the button promises.
  const baselines = shaped.map((s) => s.lastSeen?.at).filter(Boolean).sort();
  const baselineAt = baselines.length ? baselines[0] : null;

  // Watchlist Pulse (Health Score): 0 - 100 based on significance score
  let totalScore = shaped.reduce((sum, s) => sum + s.significance.score, 0);
  const pulseScore = shaped.length > 0 ? Math.min(100, Math.round((totalScore / shaped.length) * 12)) : 0;

  // Watchlist Comparison: Average day change
  let validChanges = shaped.filter(s => s.dayChangePct !== null);
  const avgDayChange = validChanges.length > 0 
    ? Number((validChanges.reduce((sum, s) => sum + s.dayChangePct, 0) / validChanges.length).toFixed(2)) 
    : 0;

  // Correlations
  const { findDivergingCorrelations } = await import('../utils/math.js');
  const divergingCorrelations = findDivergingCorrelations(shaped);

  // Watchlist Digest: Quiet stocks (tight range, low volume)
  // "Quiet" defined as: volume < avgVolume20d * 0.8 AND dayHigh - dayLow < price * 0.01 (1% range)
  const quietStocks = shaped.filter(s => 
    s.volume && s.avgVolume20d && (s.volume < s.avgVolume20d * 0.8) &&
    s.dayHigh && s.dayLow && s.price && ((s.dayHigh - s.dayLow) / s.price < 0.015)
  ).map(s => s.symbol);

  return {
    asOf: now.toISOString(),
    market: marketMeta(now),
    data: {
      ...freshness,
      refreshTimedOut,
      isOpen: isMarketOpen(now),
    },
    threshold: SIGNIFICANCE_THRESHOLD,
    baselineAt,
    counts: {
      total: shaped.length,
      significant: shaped.filter((s) => s.significance.significant && !s.unavailable).length,
      unavailable: shaped.filter((s) => s.unavailable).length,
      unacknowledged: shaped.filter((s) => !s.lastSeen).length,
    },
    pulseScore,
    avgDayChange,
    divergingCorrelations,
    quietStocks,
    items: shaped,
  };
}

/**
 * Current cached prices for a user's symbols, for recording "what they saw".
 *
 * Deliberately server-side: the client could claim any price, and a forged
 * baseline would let someone silence a real move. The cost is that we record
 * the price at acknowledge-time rather than the exact pixel the user looked at
 * -- a sub-second discrepancy in exchange for a baseline that cannot be spoofed.
 */
export function observationsFor(userId, symbols = null) {
  const items = listItems(userId);
  const wanted = symbols ? new Set(symbols) : null;
  const targets = items.filter((i) => !wanted || wanted.has(i.symbol));
  const rows = getCachedRows(targets.map((i) => i.symbol));

  return targets.map((i) => {
    const q = toQuote(rows.get(i.symbol));
    return { symbol: i.symbol, price: q?.price ?? null, volume: q?.volume ?? null };
  });
}
