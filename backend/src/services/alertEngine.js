/**
 * User-defined alert rules, evaluated once per worker tick.
 *
 * These are the *explicit* half of the product: the significance engine decides
 * what deserves attention, this fires on conditions the user stated outright.
 * They must agree on what words mean -- a "volume spike" here is the same
 * session-adjusted ratio the volume signal uses, not the raw full-day ratio.
 * Two definitions of one term in one system is how a user stops trusting both.
 */

import { getActiveAlerts, updateAlertTrigger } from '../models/alertModel.js';
import { addLog } from '../models/activityModel.js';
import { getCachedRows, toQuote, freshnessOf } from './marketData.js';
import { sessionElapsedFraction } from '../utils/marketHours.js';

/** One trigger per rule per hour. A rule that fires every tick is a rule the user mutes. */
const TRIGGER_COOLDOWN_MS = 3_600_000;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Decide whether one rule fires. Pure, so it is testable without a DB or clock.
 * Returns null when it does not fire, or when the inputs cannot support a claim.
 */
export function evaluateRule(rule, quote, now = new Date()) {
  if (!quote || !isNum(quote.price)) return null;

  if (rule.rule_type === 'volume_spike') {
    if (!isNum(quote.volume) || !isNum(quote.avgVolume20d) || quote.avgVolume20d <= 0) return null;
    const expected = quote.avgVolume20d * sessionElapsedFraction(now);
    if (expected <= 0) return null;
    const mult = quote.volume / expected;
    if (mult < rule.threshold) return null;
    return `${rule.symbol} is trading at ${mult.toFixed(1)}x its expected volume for this point in the session.`;
  }

  if (rule.rule_type === 'price_proximity') {
    if (!isNum(quote.high52w) || quote.high52w <= 0) return null;
    const dist = (quote.high52w - quote.price) / quote.high52w;
    if (dist > rule.threshold) return null;
    return dist <= 0
      ? `${rule.symbol} is at a new 52-week high.`
      : `${rule.symbol} is within ${(dist * 100).toFixed(1)}% of its 52-week high.`;
  }

  return null;
}

export async function evaluateAlerts(now = new Date()) {
  const alerts = getActiveAlerts();
  if (!alerts.length) return;

  const symbols = [...new Set(alerts.map((a) => a.symbol))];
  const rows = getCachedRows(symbols);

  for (const alert of alerts) {
    if (alert.last_triggered_at) {
      const msSince = now.getTime() - new Date(alert.last_triggered_at).getTime();
      if (msSince < TRIGGER_COOLDOWN_MS) continue;
    }

    const row = rows.get(alert.symbol);
    // Never fire off data we would refuse to render as current. A stale-price
    // alert is worse than no alert: it is a claim about right now, made from
    // an observation we already know is out of date.
    const freshness = freshnessOf(row, now);
    if (freshness.state === 'stale' || freshness.state === 'unavailable') continue;

    const message = evaluateRule(alert, toQuote(row), now);
    if (!message) continue;

    updateAlertTrigger(alert.id);
    addLog(alert.user_id, {
      symbol: alert.symbol,
      eventType: 'alert_triggered',
      message,
    });
  }
}
