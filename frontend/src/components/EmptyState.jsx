const SUGGESTIONS = ['RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'SBIN', 'ITC'];

/** Empty is a normal state, not an error. It should teach and offer a next step. */
export function EmptyWatchlist({ onAdd, busy }) {
  return (
    <div className="card p-8 text-center">
      <div className="text-3xl mb-3" aria-hidden="true">📋</div>
      <h2 className="font-semibold text-lg">Your watchlist is empty</h2>
      <p className="mt-1.5 text-sm text-muted max-w-sm mx-auto">
        Add a few stocks and Pulse will start tracking what meaningfully changes between your visits —
        not just the prices.
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            disabled={busy}
            onClick={() => onAdd(s)}
            className="chip bg-accent/10 text-accent hover:bg-accent/20 transition-colors min-h-[36px] px-3"
          >
            + {s}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Nothing cleared the significance bar.
 *
 * This is a success state: the product's job is to tell you when you can stop
 * looking. It shows the closest-to-notable names so the screen is never a
 * dead end.
 */
export function NothingSignificant({ topItems, onShowAll, isFirstVisit }) {
  return (
    <div className="card p-6 text-center">
      <div className="text-2xl mb-2" aria-hidden="true">🌤️</div>
      <h2 className="font-semibold">
        {isFirstVisit ? 'Nothing unusual right now' : 'Nothing unusual since your last check'}
      </h2>
      <p className="mt-1.5 text-sm text-muted max-w-md mx-auto">
        {isFirstVisit
          ? 'No stock on your list is showing an unusual volume, range break or sector divergence.'
          : 'Your watchlist is quiet. Nothing crossed the bar for your attention.'}
      </p>
      {topItems?.length > 0 && (
        <div className="mt-4 text-left max-w-md mx-auto">
          <p className="text-xs uppercase tracking-wide text-muted mb-2">Closest to notable</p>
          <ul className="space-y-1.5">
            {topItems.map((i) => (
              <li key={i.symbol} className="flex items-baseline justify-between gap-3 text-sm">
                <span className="font-medium">{i.symbol.replace('.NS', '')}</span>
                <span className="text-muted text-xs truncate text-right">{i.significance.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <button onClick={onShowAll} className="btn-ghost mt-4 text-sm">
        View full watchlist →
      </button>
    </div>
  );
}
