/**
 * NSE market-hours logic, in IST (UTC+05:30, no DST).
 *
 * We deliberately avoid a timezone library: IST has a fixed offset, so shifting
 * the epoch and reading UTC fields is exact and dependency-free. Everything that
 * touches the DB stays in UTC ISO strings; IST exists only for this module and
 * for display formatting on the client.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const OPEN_MINUTES = 9 * 60 + 15;   // 09:15 IST
const CLOSE_MINUTES = 15 * 60 + 30; // 15:30 IST
const PRE_OPEN_MINUTES = 9 * 60;    // 09:00 IST

// NSE trading holidays. Kept as a literal list on purpose: there is no free,
// reliable holiday feed, and a wrong "market open" badge is worse than a list
// that needs a yearly edit. Dates are IST calendar days.
const HOLIDAYS_2025 = [
  '2025-02-26', '2025-03-14', '2025-03-31', '2025-04-10', '2025-04-14',
  '2025-04-18', '2025-05-01', '2025-08-15', '2025-08-27', '2025-10-02',
  '2025-10-21', '2025-10-22', '2025-11-05', '2025-12-25',
];
const HOLIDAYS_2026 = [
  '2026-01-26', '2026-03-04', '2026-03-19', '2026-04-01', '2026-04-03',
  '2026-04-14', '2026-05-01', '2026-08-15', '2026-10-02', '2026-11-10',
  '2026-12-25',
];
const HOLIDAYS = new Set([...HOLIDAYS_2025, ...HOLIDAYS_2026]);

/** Epoch ms -> a Date whose UTC fields read as IST wall-clock. */
function istParts(date = new Date()) {
  const shifted = new Date(date.getTime() + IST_OFFSET_MS);
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(), // 0 Sun .. 6 Sat
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

export function istDateKey(date = new Date()) {
  const { y, m, d } = istParts(date);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function isTradingDay(date = new Date()) {
  const { weekday } = istParts(date);
  if (weekday === 0 || weekday === 6) return false;
  return !HOLIDAYS.has(istDateKey(date));
}

/**
 * @returns {'open'|'pre_open'|'closed'} coarse session state.
 */
export function marketStatus(date = new Date()) {
  if (!isTradingDay(date)) return 'closed';
  const { minutes } = istParts(date);
  if (minutes >= OPEN_MINUTES && minutes < CLOSE_MINUTES) return 'open';
  if (minutes >= PRE_OPEN_MINUTES && minutes < OPEN_MINUTES) return 'pre_open';
  return 'closed';
}

export function isMarketOpen(date = new Date()) {
  return marketStatus(date) === 'open';
}

/**
 * Fraction of the trading session elapsed, in [0,1].
 *
 * This exists for the volume signal. Raw volume accumulates through the day, so
 * comparing 10:00 volume against a full-day 20-day average always looks "quiet"
 * and comparing 15:29 volume always looks "busy". Dividing the average by the
 * elapsed fraction makes the ratio comparable at any point in the session.
 */
export function sessionElapsedFraction(date = new Date()) {
  const status = marketStatus(date);
  if (status === 'closed') return 1;      // full session's worth of volume
  if (status === 'pre_open') return 0.05; // nominal; almost no volume yet
  const { minutes } = istParts(date);
  const total = CLOSE_MINUTES - OPEN_MINUTES;
  const elapsed = minutes - OPEN_MINUTES;
  // Floor at 8%: in the first ~30 minutes the denominator is small enough that
  // ordinary opening-auction volume would otherwise read as a 10x anomaly.
  return Math.min(1, Math.max(0.08, elapsed / total));
}

/** How often the background worker should refresh, in ms. */
export function refreshIntervalMs(date = new Date()) {
  return isMarketOpen(date) ? 60_000 : 15 * 60_000;
}

/** How old cached data may be before it is considered stale, in ms. */
export function cacheTtlMs(date = new Date()) {
  return isMarketOpen(date) ? 90_000 : 15 * 60_000;
}

/** Next IST calendar day that is a trading day, as YYYY-MM-DD. */
export function nextTradingDay(date = new Date()) {
  let cursor = new Date(date.getTime());
  for (let i = 0; i < 15; i++) {
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    if (isTradingDay(cursor)) return istDateKey(cursor);
  }
  return null;
}
