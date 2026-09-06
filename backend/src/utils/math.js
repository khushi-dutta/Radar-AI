/**
 * Correlation, used to find pairs that normally move together and today do not.
 *
 * The point is the same one the divergence signal makes against a sector index,
 * but empirical rather than declared: two stocks the user actually holds may
 * track each other for reasons no sector mapping encodes, and the day that
 * relationship breaks is the day something specific happened to one of them.
 */

/** Pearson correlation. Returns null rather than 0 when it is undefined. */
export function pearsonCorrelation(x, y) {
  if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length || x.length === 0) {
    return null;
  }
  const n = x.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) return null;
    sumX += x[i];
    sumY += y[i];
    sumXY += x[i] * y[i];
    sumX2 += x[i] * x[i];
    sumY2 += y[i] * y[i];
  }
  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  // Zero variance in either series: correlation is undefined, not zero.
  if (denominator === 0) return null;
  return numerator / denominator;
}

/**
 * Price levels -> period-over-period returns.
 *
 * This conversion is not cosmetic, it is the difference between a real number
 * and a spurious one. Correlating raw price SERIES is the classic mistake: two
 * unrelated stocks that both drifted upward over three months correlate at 0.95
 * because both series share a trend, not because they move together. Every pair
 * in a rising market would light up. Returns are (near-)stationary, so the
 * coefficient measures co-movement, which is the thing we actually claim.
 */
function toReturns(series) {
  const out = [];
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1];
    const cur = series[i];
    if (!Number.isFinite(prev) || !Number.isFinite(cur) || prev === 0) return null;
    out.push((cur - prev) / prev);
  }
  return out;
}

const MIN_POINTS = 10;          // fewer than ~10 returns and the coefficient is noise
const CORRELATION_FLOOR = 0.7;  // "normally moves together"
const MIN_DIVERGENCE_PCT = 2.0; // and today it does not
// n^2 pair scan is fine for a normal list but unbounded in principle. 40 symbols
// is 780 pairs of ~60-point arrays, comfortably sub-millisecond; past that the
// marginal pair is not worth the request latency it adds for every reader.
const MAX_SYMBOLS_SCANNED = 40;

/**
 * Pairs that are historically correlated but split today.
 * @param {Array} items shaped watchlist items (need `sparkline` + `dayChangePct`)
 */
export function findDivergingCorrelations(items) {
  const usable = items
    .filter(
      (i) =>
        !i.unavailable &&
        Array.isArray(i.sparkline) &&
        i.sparkline.length > MIN_POINTS &&
        Number.isFinite(i.dayChangePct)
    )
    // Deterministic subset when the list is large: the highest-significance
    // symbols are the ones the user is being pointed at anyway.
    .sort((a, b) => (b.significance?.score ?? 0) - (a.significance?.score ?? 0))
    .slice(0, MAX_SYMBOLS_SCANNED);

  // Convert once per symbol rather than once per pair.
  const returns = new Map();
  for (const item of usable) {
    const r = toReturns(item.sparkline);
    if (r && r.length >= MIN_POINTS) returns.set(item.symbol, r);
  }

  const pairs = [];
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const a = usable[i];
      const b = usable[j];
      const ra = returns.get(a.symbol);
      const rb = returns.get(b.symbol);
      if (!ra || !rb) continue;

      // Sparklines can differ in length (different listing dates, gaps in the
      // upstream history). Compare the overlapping tail, not index-for-index,
      // which would silently correlate different calendar days against each other.
      const n = Math.min(ra.length, rb.length);
      if (n < MIN_POINTS) continue;

      const corr = pearsonCorrelation(ra.slice(-n), rb.slice(-n));
      if (corr === null || corr < CORRELATION_FLOOR) continue;

      const divergence = Math.abs(a.dayChangePct - b.dayChangePct);
      if (divergence < MIN_DIVERGENCE_PCT) continue;

      pairs.push({
        stock1: a.symbol,
        stock2: b.symbol,
        correlation: Number(corr.toFixed(2)),
        divergence: Number(divergence.toFixed(2)),
        stock1Change: a.dayChangePct,
        stock2Change: b.dayChangePct,
      });
    }
  }

  // Widest split first: that is the pair most worth a sentence of the user's time.
  return pairs.sort((x, y) => y.divergence - x.divergence);
}
