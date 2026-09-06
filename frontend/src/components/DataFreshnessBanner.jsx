/**
 * The honest-degradation banner.
 *
 * Shown only when there is something real to say. Silence about staleness is
 * the failure mode this whole layer exists to prevent, but a banner that is
 * always on gets ignored, so this stays quiet on the happy path.
 */
export default function DataFreshnessBanner({ data, market, error, onRetry }) {
  if (error) {
    return (
      <div className="rounded-lg border border-loss/40 bg-loss/10 px-3 py-2.5 text-sm flex items-center justify-between gap-3">
        <span className="text-loss">
          {error.status === 0
            ? 'You appear to be offline. Showing the last data we loaded.'
            : 'Unable to fetch latest prices. Showing last known data.'}
        </span>
        <button onClick={onRetry} className="btn-ghost px-2 py-1 min-h-0 text-xs text-loss">
          Retry
        </button>
      </div>
    );
  }

  if (!data) return null;

  if (data.state === 'stale') {
    const mins = Math.round((data.ageSeconds ?? 0) / 60);
    return (
      <div className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2.5 text-sm text-warn">
        Market data is stale — last updated {mins} minute{mins === 1 ? '' : 's'} ago. Prices shown are
        not current.
      </div>
    );
  }

  if (data.state === 'delayed' && market?.isOpen) {
    const mins = Math.round((data.ageSeconds ?? 0) / 60);
    return (
      <div className="rounded-lg border border-warn/30 bg-warn/[0.07] px-3 py-2 text-xs text-warn">
        Prices delayed by about {mins} minute{mins === 1 ? '' : 's'}.
      </div>
    );
  }

  if (data.unavailableCount > 0) {
    return (
      <div className="rounded-lg border border-warn/30 bg-warn/[0.07] px-3 py-2 text-xs text-warn">
        {data.unavailableCount} symbol{data.unavailableCount === 1 ? '' : 's'} could not be priced.
        They are shown greyed out below.
      </div>
    );
  }

  return null;
}
