import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, getToken, setToken } from './services/api.js';
import { useWatchlist } from './hooks/useWatchlist.js';

import Login from './components/Login.jsx';
import MarketStatusBadge from './components/MarketStatusBadge.jsx';
import DataFreshnessBanner from './components/DataFreshnessBanner.jsx';
import AddStockSearch from './components/AddStockSearch.jsx';
import WatchlistCard from './components/WatchlistCard.jsx';
import FullWatchlistTable from './components/FullWatchlistTable.jsx';
import StockDetailPanel from './components/StockDetailPanel.jsx';
import SkeletonLoader from './components/SkeletonLoader.jsx';
import { EmptyWatchlist, NothingSignificant } from './components/EmptyState.jsx';
import { elapsedPhrase } from './utils/formatters.js';
import WatchlistDigest from './components/WatchlistDigest.jsx';
import HeatmapView from './components/HeatmapView.jsx';
import AlertRules from './components/AlertRules.jsx';
import ActivityLog from './components/ActivityLog.jsx';
import { Sun, Moon } from 'lucide-react';

/** Transient bottom-of-screen message. */
function Toast({ toast, onDismiss }) {
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(onDismiss, 3800);
    return () => clearTimeout(t);
  }, [toast, onDismiss]);

  if (!toast) return null;
  const tone = toast.kind === 'error' ? 'border-loss/50 text-loss' : 'border-border text-txt';
  return (
    <div
      role="status"
      className={`fixed bottom-4 left-1/2 -translate-x-1/2 z-50 card ${tone} px-4 py-2.5 text-sm shadow-lg max-w-[92vw]`}
    >
      {toast.message}
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [view, setView] = useState('changes');
  const [detail, setDetail] = useState(null);
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState(false);
  const [market, setMarket] = useState(null);
  const [isDark, setIsDark] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('pulse.theme');
      if (saved) return saved === 'dark';
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    return true; // Default to dark like before
  });

  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('pulse.theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('pulse.theme', 'light');
    }
  }, [isDark]);

  const notify = useCallback((message, kind = 'info') => setToast({ message, kind }), []);

  // Authentication is disabled per user request
  useEffect(() => {
    setUser({ id: 'demo', email: 'demo@groww.test' });
    setAuthChecked(true);
  }, []);

  // Market status is public, so the sign-in screen can show it too.
  useEffect(() => {
    api.marketStatus().then((s) => setMarket(s.market)).catch(() => {});
  }, []);

  const wl = useWatchlist({ enabled: Boolean(user) });

  const items = wl.data?.items ?? [];
  const significant = useMemo(
    () => items.filter((i) => i.significance.significant && !i.unavailable),
    [items]
  );
  const nearMisses = useMemo(
    () => items.filter((i) => !i.significance.significant && !i.unavailable).slice(0, 3),
    [items]
  );

  const handleAdd = useCallback(
    async (symbol) => {
      setBusy(true);
      const res = await wl.addStock(symbol);
      setBusy(false);
      if (!res.ok) {
        notify(res.error?.message ?? 'Could not add that stock', 'error');
      } else {
        notify(`${symbol.replace('.NS', '')} added`);
      }
    },
    [wl, notify]
  );

  const handleRemove = useCallback(
    async (symbol) => {
      const res = await wl.removeStock(symbol);
      if (!res.ok) notify(res.error?.message ?? 'Could not remove that stock', 'error');
      else notify(`${symbol.replace('.NS', '')} removed`);
    },
    [wl, notify]
  );

  const handleMarkSeen = useCallback(
    async (symbol) => {
      const res = await wl.markSeen(symbol);
      if (!res.ok) notify('Could not mark as seen', 'error');
    },
    [wl, notify]
  );

  const handleMarkAllSeen = useCallback(async () => {
    const res = await wl.markAllSeen();
    if (res.ok) notify('Watchlist marked as seen — future changes compare against now');
    else notify('Could not mark as seen', 'error');
  }, [wl, notify]);

  const logout = () => {
    setToken(null);
    setUser(null);
  };

  // Keep the open detail sheet in sync with streamed updates rather than
  // freezing it at the moment it was opened.
  const liveDetail = detail ? items.find((i) => i.symbol === detail.symbol) ?? detail : null;

  if (!authChecked) {
    return <div className="min-h-screen grid place-items-center text-muted text-sm">Loading…</div>;
  }

  if (!user) {
    return <Login onAuthed={setUser} market={market} />;
  }

  // Derived from the acknowledgement baseline, not from this page load, so the
  // header and the per-card "since you last checked" numbers always describe
  // the same moment. Stable across reloads and stream frames by construction.
  const lastVisit = wl.data?.baselineAt ?? null;
  const sincePhrase = lastVisit ? elapsedPhrase(lastVisit) : null;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 bg-bg/85 backdrop-blur border-b border-border">
        <div className="mx-auto max-w-3xl px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <span className="h-2.5 w-2.5 rounded-full bg-gain animate-pulseDot shrink-0" />
              <h1 className="font-semibold tracking-tight">Radar</h1>
            </div>
            <div className="flex items-center gap-2">
              <MarketStatusBadge
                market={wl.data?.market ?? market}
                data={wl.data?.data}
                connection={wl.connection}
              />
              <button 
                onClick={() => setIsDark(prev => !prev)} 
                className="btn-ghost p-2 rounded-full"
                title="Toggle theme"
              >
                {isDark ? <Sun size={18} /> : <Moon size={18} />}
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-5 space-y-4">
        <AddStockSearch
          onAdd={handleAdd}
          existingSymbols={items.map((i) => i.symbol)}
          busy={busy}
        />

        <DataFreshnessBanner
          data={wl.data?.data}
          market={wl.data?.market}
          error={wl.error}
          onRetry={() => wl.reload({ quiet: true })}
        />

        {/* View switch */}
        <div className="flex items-center justify-between gap-3">
          <div
            role="tablist"
            aria-label="Watchlist views"
            className="inline-flex rounded-lg bg-surface p-1 border border-border"
          >
            {[
              ['changes', 'What changed', significant.length],
              ['all', 'All stocks', items.length],
              ['heatmap', 'Heatmap', 0],
              ['alerts', 'Alerts', 0],
              ['activity', 'Activity', 0],
            ].map(([key, label, count]) => (
              <button
                key={key}
                role="tab"
                aria-selected={view === key}
                onClick={() => setView(key)}
                className={`px-3 py-1.5 rounded-md text-sm transition-colors min-h-[38px] ${
                  view === key ? 'bg-surface2 text-txt' : 'text-muted hover:text-txt'
                }`}
              >
                {label}
                {count > 0 && <span className="ml-1.5 text-xs text-muted tnum">{count}</span>}
              </button>
            ))}
          </div>

          {view === 'changes' && significant.length > 0 && (
            <button onClick={handleMarkAllSeen} className="btn-ghost text-xs px-2">
              Mark all seen
            </button>
          )}
        </div>

        {wl.loading && !wl.data ? (
          <SkeletonLoader />
        ) : items.length === 0 ? (
          <EmptyWatchlist onAdd={handleAdd} busy={busy} />
        ) : view === 'changes' ? (
          <section className="space-y-3">
            <WatchlistDigest data={wl.data} sincePhrase={sincePhrase} />
            <p className="text-sm text-muted">
              {sincePhrase ? (
                <>Since you last checked <span className="text-txt">{sincePhrase}</span></>
              ) : (
                'Your first look'
              )}
              {significant.length > 0 && (
                <> · {significant.length} of {items.length} need{significant.length === 1 ? 's' : ''} attention</>
              )}
            </p>

            {significant.length === 0 ? (
              <NothingSignificant
                topItems={nearMisses}
                onShowAll={() => setView('all')}
                isFirstVisit={!lastVisit}
              />
            ) : (
              significant.map((item, i) => (
                <WatchlistCard
                  key={item.symbol}
                  item={item}
                  isTop={i === 0}
                  onMarkSeen={handleMarkSeen}
                  onOpen={setDetail}
                />
              ))
            )}

            {items.some((i) => i.unavailable) && (
              <div className="space-y-3 pt-1">
                {items.filter((i) => i.unavailable).map((item) => (
                  <WatchlistCard
                    key={item.symbol}
                    item={item}
                    onMarkSeen={handleMarkSeen}
                    onOpen={setDetail}
                  />
                ))}
              </div>
            )}
          </section>
        ) : view === 'heatmap' ? (
          <HeatmapView items={items} onOpen={setDetail} />
        ) : view === 'alerts' ? (
          <AlertRules />
        ) : view === 'activity' ? (
          <ActivityLog />
        ) : (
          <FullWatchlistTable items={items} onRemove={handleRemove} onOpen={setDetail} />
        )}

        <footer className="pt-2 pb-6 text-center text-[11px] text-muted">
          Prices via Yahoo Finance · delayed, for information only · not investment advice
        </footer>
      </main>

      {liveDetail && (
        <StockDetailPanel
          item={liveDetail}
          onClose={() => setDetail(null)}
          onUpdate={wl.updateStock}
          onRemove={handleRemove}
        />
      )}

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
