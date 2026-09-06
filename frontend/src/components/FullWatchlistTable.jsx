import { useMemo, useState } from 'react';
import {
  formatPrice,
  formatPct,
  formatVolume,
  changeColor,
  sectorLabel,
} from '../utils/formatters.js';

const COLUMNS = [
  { key: 'symbol', label: 'Symbol', align: 'left' },
  { key: 'price', label: 'Price', align: 'right' },
  { key: 'dayChangePct', label: 'Change', align: 'right' },
  { key: 'volume', label: 'Volume', align: 'right', hideOnMobile: true },
  { key: 'range52w', label: '52W range', align: 'right', hideOnMobile: true },
  { key: 'score', label: 'Signal', align: 'right' },
];

/** Nulls always sort last, regardless of direction — an unpriced row is not "lowest". */
function compare(a, b, key, dir) {
  const get = (item) => {
    switch (key) {
      case 'symbol': return item.symbol;
      case 'score': return item.significance.score;
      case 'range52w': return item.high52w != null && item.price != null
        ? (item.price - item.low52w) / ((item.high52w - item.low52w) || 1)
        : null;
      default: return item[key];
    }
  };
  const av = get(a);
  const bv = get(b);
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
  return dir === 'asc' ? cmp : -cmp;
}

/** Where the price sits within its 52-week band. */
function RangeBar({ item }) {
  if (item.price == null || item.high52w == null || item.low52w == null) return <span className="text-muted">--</span>;
  const span = item.high52w - item.low52w || 1;
  const pos = Math.min(100, Math.max(0, ((item.price - item.low52w) / span) * 100));
  return (
    <div className="flex items-center justify-end gap-2">
      <span className="tnum text-[11px] text-muted hidden lg:inline">{Math.round(pos)}%</span>
      <div className="relative h-1 w-16 rounded-full bg-border">
        <div className="absolute top-1/2 -translate-y-1/2 h-2 w-2 rounded-full bg-accent" style={{ left: `calc(${pos}% - 4px)` }} />
      </div>
    </div>
  );
}

/**
 * The "everything" view.
 *
 * Deliberately a plain sortable table on desktop and a card list on mobile:
 * a horizontally scrolling six-column table on a phone is how data products
 * become unusable, and Groww is a mobile-first company.
 */
export default function FullWatchlistTable({ items, onRemove, onOpen }) {
  const [sort, setSort] = useState({ key: 'score', dir: 'desc' });

  const sorted = useMemo(
    () => [...items].sort((a, b) => compare(a, b, sort.key, sort.dir)),
    [items, sort]
  );

  const toggle = (key) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'symbol' ? 'asc' : 'desc' }));

  return (
    <div className="card overflow-hidden">
      {/* Desktop table */}
      <table className="hidden md:table w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            {COLUMNS.map((c) => (
              <th
                key={c.key}
                className={`px-4 py-3 font-medium text-muted text-${c.align} ${c.hideOnMobile ? 'hidden lg:table-cell' : ''}`}
              >
                <button
                  onClick={() => toggle(c.key)}
                  className="inline-flex items-center gap-1 hover:text-txt transition-colors"
                  aria-sort={sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                >
                  {c.label}
                  <span className="text-[10px]">{sort.key === c.key ? (sort.dir === 'asc' ? '▲' : '▼') : ''}</span>
                </button>
              </th>
            ))}
            <th className="px-4 py-3 w-10" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((item) => (
            <tr
              key={item.symbol}
              className={`border-b border-border/60 last:border-0 hover:bg-surface2/60 transition-colors ${item.unavailable ? 'opacity-50' : ''}`}
            >
              <td className="px-4 py-3">
                <button onClick={() => onOpen(item)} className="text-left hover:text-accent transition-colors">
                  <span className="font-medium">{item.symbol.replace('.NS', '')}</span>
                  <span className="block text-xs text-muted truncate max-w-[14rem]">{item.displayName}</span>
                </button>
              </td>
              <td className="px-4 py-3 text-right tnum">{formatPrice(item.price, { currency: item.currency })}</td>
              <td className={`px-4 py-3 text-right tnum ${changeColor(item.dayChangePct)}`}>
                {formatPct(item.dayChangePct)}
              </td>
              <td className="px-4 py-3 text-right tnum text-muted hidden lg:table-cell">
                {formatVolume(item.volume)}
              </td>
              <td className="px-4 py-3 hidden lg:table-cell"><RangeBar item={item} /></td>
              <td className="px-4 py-3 text-right">
                <span className="tnum" title={item.significance.reason}>
                  {item.unavailable ? '--' : item.significance.scorePct}
                </span>
              </td>
              <td className="px-4 py-3 text-right">
                <button
                  onClick={() => onRemove(item.symbol)}
                  className="text-muted hover:text-loss transition-colors px-2"
                  aria-label={`Remove ${item.symbol}`}
                >
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Mobile list */}
      <ul className="md:hidden divide-y divide-border/60">
        {sorted.map((item) => (
          <li key={item.symbol} className={`p-4 ${item.unavailable ? 'opacity-50' : ''}`}>
            <div className="flex items-start justify-between gap-3">
              <button onClick={() => onOpen(item)} className="text-left min-w-0">
                <span className="font-medium">{item.symbol.replace('.NS', '')}</span>
                <span className="block text-xs text-muted truncate">{item.displayName}</span>
                {item.sector && (
                  <span className="chip bg-surface2 text-muted text-[10px] mt-1">{sectorLabel(item.sector)}</span>
                )}
              </button>
              <div className="text-right shrink-0">
                <div className="tnum font-medium">{formatPrice(item.price, { currency: item.currency })}</div>
                <div className={`tnum text-sm ${changeColor(item.dayChangePct)}`}>{formatPct(item.dayChangePct)}</div>
                <div className="text-[11px] text-muted mt-0.5">Signal {item.unavailable ? '--' : item.significance.scorePct}</div>
              </div>
            </div>
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="text-xs text-muted truncate">{item.significance.reason}</span>
              <button
                onClick={() => onRemove(item.symbol)}
                className="text-muted hover:text-loss px-2 min-h-[44px]"
                aria-label={`Remove ${item.symbol}`}
              >
                ✕
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
