import { getActiveAlerts, updateAlertTrigger } from '../models/alertModel.js';
import { addLog } from '../models/activityModel.js';
import { getCachedRows } from './marketData.js';
import { toQuote } from './marketData.js';
import { nowIso } from '../config/database.js';

export async function evaluateAlerts() {
  const alerts = getActiveAlerts();
  if (!alerts.length) return;

  const symbols = [...new Set(alerts.map(a => a.symbol))];
  const rows = getCachedRows(symbols);
  const now = new Date();

  for (const alert of alerts) {
    const row = rows.get(alert.symbol);
    const quote = toQuote(row);
    if (!quote || !quote.price) continue;

    // Throttle triggers: 1 hour between triggers for the same rule
    if (alert.last_triggered_at) {
      const msSince = now.getTime() - new Date(alert.last_triggered_at).getTime();
      if (msSince < 3600_000) continue;
    }

    let triggered = false;
    let message = '';

    if (alert.rule_type === 'volume_spike' && quote.volume && quote.avgVolume20d) {
      const mult = quote.volume / quote.avgVolume20d;
      if (mult >= alert.threshold) {
        triggered = true;
        message = `${alert.symbol} volume spiked ${mult.toFixed(1)}x above 20-day average.`;
      }
    } else if (alert.rule_type === 'price_proximity' && quote.high52w) {
      const dist = (quote.high52w - quote.price) / quote.high52w;
      if (dist <= alert.threshold) {
        triggered = true;
        message = `${alert.symbol} is within ${(alert.threshold * 100).toFixed(1)}% of 52-week high.`;
      }
    }

    if (triggered) {
      updateAlertTrigger(alert.id);
      addLog(alert.user_id, {
        symbol: alert.symbol,
        eventType: 'alert_triggered',
        message
      });
    }
  }
}
