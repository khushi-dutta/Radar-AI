import { formatIST } from '../utils/formatters.js';

/**
 * Market state + data freshness in one glance.
 *
 * These are two different facts and the UI keeps them distinct: the market can
 * be open while our data is stale, and that combination is exactly the one a
 * user must never mistake for "live".
 */
export default function MarketStatusBadge({ market, data, connection }) {
  if (!market) return null;

  const isOpen = market.status === 'open';
  const isPre = market.status === 'pre_open';

  const dot = isOpen
    ? 'bg-gain animate-pulseDot'
    : isPre
      ? 'bg-warn'
      : 'bg-muted';

  // Freshness overrides the happy path: a stale cache during market hours is
  // reported as stale, not as "open".
  const state = data?.state;
  const degraded = state === 'stale' || state === 'delayed' || state === 'unavailable';

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="flex items-center gap-1.5 text-muted">
        <span className={`h-2 w-2 rounded-full ${degraded ? 'bg-warn' : dot}`} />
        <span className="font-medium text-txt">{market.label}</span>
      </span>

      {!isOpen && market.nextTradingDay && (
        <span className="hidden sm:inline text-muted">· opens {market.nextTradingDay}</span>
      )}

      {degraded ? (
        <span className="chip bg-warn/15 text-warn">
          {state === 'unavailable' ? 'Data unavailable' : `Delayed · ${Math.round((data.ageSeconds ?? 0) / 60)}m`}
        </span>
      ) : (
        data?.oldestFetchedAt && (
          <span className="text-muted hidden sm:inline">· as of {formatIST(data.oldestFetchedAt)}</span>
        )
      )}

      {connection === 'reconnecting' && (
        <span className="chip bg-warn/15 text-warn">Reconnecting…</span>
      )}
    </div>
  );
}
