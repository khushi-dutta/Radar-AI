/**
 * Upstream market-data provider: Yahoo Finance's public chart endpoint.
 *
 * Why this endpoint and not the `quote` one (or the yahoo-finance2 client):
 * `quote` requires a crumb+cookie handshake and is aggressively rate-limited
 * (it returned HTTP 429 on the very first call while building this). The chart
 * endpoint needs no auth and returns, in a SINGLE request, both the live quote
 * and a year of daily OHLCV. That means the 20-day average volume and the
 * breakout channel are computed from raw bars we can inspect, rather than
 * trusted from an opaque vendor field.
 *
 * This is an unofficial API. It is treated as hostile: every call is bounded by
 * a timeout, retried with jittered backoff, and classified into permanent vs
 * transient failure so the caller can decide whether to stop asking.
 */

import { istDateKey } from '../utils/marketHours.js';

const BASE = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) RadarAI/1.0';
const REQUEST_TIMEOUT_MS = 8000;

/** Upstream failure with a transient/permanent classification attached. */
export class ProviderError extends Error {
  constructor(message, { permanent = false, status = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.permanent = permanent;
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });

    if (res.status === 404) {
      throw new ProviderError('Symbol not found upstream', { permanent: true, status: 404 });
    }
    if (res.status === 429) {
      throw new ProviderError('Rate limited by upstream', { status: 429 });
    }
    if (!res.ok) {
      throw new ProviderError(`Upstream HTTP ${res.status}`, {
        // 4xx other than 429 means we asked wrongly; retrying will not help.
        permanent: res.status >= 400 && res.status < 500,
        status: res.status,
      });
    }
    return await res.json();
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (err.name === 'AbortError') {
      throw new ProviderError(`Upstream timed out after ${timeoutMs}ms`);
    }
    throw new ProviderError(`Upstream request failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * fetchJson + bounded retry. Permanent errors short-circuit immediately;
 * there is no point burning three attempts on a delisted ticker.
 */
async function fetchWithRetry(url, { attempts = 3, baseDelayMs = 600 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchJson(url);
    } catch (err) {
      lastErr = err;
      if (err.permanent || i === attempts - 1) break;
      // Exponential backoff with full jitter, so N symbols failing at once do
      // not retry in a synchronised thundering herd.
      const delay = baseDelayMs * 2 ** i;
      await sleep(Math.random() * delay);
    }
  }
  throw lastErr;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Collapse the chart payload's parallel arrays into clean daily bars,
 * dropping the nulls Yahoo emits for halted/holiday sessions.
 */
function toBars(result) {
  const ts = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0] ?? {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const close = q.close?.[i];
    const high = q.high?.[i];
    const low = q.low?.[i];
    const volume = q.volume?.[i];
    if (!isNum(close) || !isNum(high) || !isNum(low)) continue;
    bars.push({
      t: ts[i] * 1000,
      high,
      low,
      close,
      volume: isNum(volume) ? volume : null,
    });
  }
  return bars;
}

/**
 * Derive the aggregates the significance engine needs.
 *
 * The subtlety here is that today's bar must be EXCLUDED from both the channel
 * and the volume average:
 *   - Today's high/low always contains today's price, so including it makes a
 *     breakout mathematically impossible to detect.
 *   - Today's volume is a partial-session number; averaging it into a 20-day
 *     full-session mean drags the baseline down and manufactures anomalies.
 */
function deriveAggregates(bars, nowMs = Date.now()) {
  const todayKey = istDateKey(new Date(nowMs));
  const historical = bars.filter((b) => istDateKey(new Date(b.t)) !== todayKey);

  const recent = historical.slice(-10); // ~2 trading weeks
  const vol20 = historical.slice(-20).map((b) => b.volume).filter(isNum);

  // A "20-day average" built from 4 bars is not an average, it is noise that
  // happens to be a number. Newly listed stocks and short ranges hit this.
  // Returning null lets the significance engine skip the signal honestly
  // instead of scoring against a fabricated baseline.
  const MIN_VOLUME_BARS = 10;
  const MIN_CHANNEL_BARS = 5;

  return {
    high2w: recent.length >= MIN_CHANNEL_BARS ? Math.max(...recent.map((b) => b.high)) : null,
    low2w: recent.length >= MIN_CHANNEL_BARS ? Math.min(...recent.map((b) => b.low)) : null,
    avgVolume20d: vol20.length >= MIN_VOLUME_BARS
      ? Math.round(vol20.reduce((a, b) => a + b, 0) / vol20.length)
      : null,
    // Enough points to draw a trend, few enough to keep the row small.
    sparkline: historical.slice(-30).map((b) => Number(b.close.toFixed(2))),
    barCount: historical.length,
    // The close of the most recent completed session. See the note in
    // fetchSnapshot for why we do not use meta.chartPreviousClose.
    previousClose: historical.length ? historical.at(-1).close : null,
  };
}

/**
 * Fetch a full snapshot: live quote fields plus derived daily aggregates.
 * `range=1y` is what makes the 52-week and 20-day numbers real rather than
 * inherited from a vendor field we cannot verify.
 */
export async function fetchSnapshot(symbol, { range = '1y' } = {}) {
  const url = `${BASE}${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
  const json = await fetchWithRetry(url);

  const err = json?.chart?.error;
  if (err) {
    const code = String(err.code ?? '').toLowerCase();
    throw new ProviderError(err.description ?? 'Upstream returned an error', {
      permanent: code.includes('not found') || code.includes('notfound'),
    });
  }

  const result = json?.chart?.result?.[0];
  if (!result?.meta) throw new ProviderError('Malformed upstream payload');

  const meta = result.meta;
  const price = meta.regularMarketPrice;
  if (!isNum(price)) {
    throw new ProviderError('Upstream payload has no price', { permanent: false });
  }

  const bars = toBars(result);
  const agg = deriveAggregates(bars);

  // ---------------------------------------------------------------------
  // Reconciling three fields in one payload that disagree about "previous
  // close". This is the messiest part of the integration and worth the words.
  //
  // meta.chartPreviousClose is the obvious trap: it is the close of the bar
  // BEFORE the requested window, so it moves with `range`. The same symbol
  // reported 1277 / 1290.9 / 1359.3 for range=5d / 1mo / 1y within one minute.
  //
  // The last completed daily bar is usually the honest answer and reproduces
  // Yahoo's own change% to three decimals. But it is not always: several NSE
  // sector indices (^CNXMETAL, ^CNXFMCG) return a full timestamp array whose
  // recent closes are all null, so the last VALID bar can be a week stale and
  // silently yields a fictional +6.05% day against a true +0.11%.
  //
  // So we derive, then cross-check against the vendor's own change%. Agreement
  // means the bar series is intact and we keep our derivation. Disagreement
  // beyond a tolerance means our history has holes, and the vendor's figure --
  // computed against data we cannot see -- is the better of two imperfect
  // sources. We record which basis won so the API can surface it.
  // ---------------------------------------------------------------------
  const RECONCILE_TOLERANCE_PP = 0.5;
  const vendorPct = isNum(meta.regularMarketChangePercent)
    ? meta.regularMarketChangePercent
    : null;

  let prevClose = null;
  let prevCloseBasis = 'none';

  const derivedPrev = isNum(agg.previousClose) ? agg.previousClose : null;
  const derivedPct =
    derivedPrev && derivedPrev !== 0 ? ((price - derivedPrev) / derivedPrev) * 100 : null;

  if (derivedPct !== null && vendorPct !== null) {
    if (Math.abs(derivedPct - vendorPct) <= RECONCILE_TOLERANCE_PP) {
      prevClose = derivedPrev;
      prevCloseBasis = 'prior_bar';
    } else {
      prevClose = price / (1 + vendorPct / 100);
      prevCloseBasis = 'vendor_reconciled';
    }
  } else if (derivedPct !== null) {
    prevClose = derivedPrev;
    prevCloseBasis = 'prior_bar';
  } else if (vendorPct !== null && vendorPct !== -100) {
    prevClose = price / (1 + vendorPct / 100);
    prevCloseBasis = 'vendor_change_pct';
  } else if (isNum(meta.chartPreviousClose)) {
    prevClose = meta.chartPreviousClose;
    prevCloseBasis = 'chart_previous_close';
  }

  return {
    symbol: meta.symbol ?? symbol,
    displayName: meta.longName ?? meta.shortName ?? null,
    currency: meta.currency ?? 'INR',
    price,
    previousClose: prevClose,
    prevCloseBasis,
    dayChangePct:
      prevClose && prevClose !== 0 ? ((price - prevClose) / prevClose) * 100 : null,
    dayHigh: isNum(meta.regularMarketDayHigh) ? meta.regularMarketDayHigh : null,
    dayLow: isNum(meta.regularMarketDayLow) ? meta.regularMarketDayLow : null,
    volume: isNum(meta.regularMarketVolume) ? meta.regularMarketVolume : null,
    high52w: isNum(meta.fiftyTwoWeekHigh) ? meta.fiftyTwoWeekHigh : null,
    low52w: isNum(meta.fiftyTwoWeekLow) ? meta.fiftyTwoWeekLow : null,
    high2w: agg.high2w,
    low2w: agg.low2w,
    avgVolume20d: agg.avgVolume20d,
    sparkline: agg.sparkline,
    barCount: agg.barCount,
    // Upstream's own notion of when this quote was true. Used to reject
    // out-of-order writes; falls back to now if upstream omits it.
    sourceTs: isNum(meta.regularMarketTime)
      ? new Date(meta.regularMarketTime * 1000).toISOString()
      : new Date().toISOString(),
  };
}

/**
 * Cheap existence probe for symbols outside the curated universe.
 * Returns null when the symbol genuinely does not exist upstream; rethrows
 * transient failures so the caller does not mistake an outage for a bad ticker.
 */
export async function probeSymbol(symbol) {
  try {
    const snap = await fetchSnapshot(symbol, { range: '5d' });
    return { symbol: snap.symbol, name: snap.displayName, price: snap.price };
  } catch (err) {
    if (err instanceof ProviderError && err.permanent) return null;
    throw err;
  }
}
