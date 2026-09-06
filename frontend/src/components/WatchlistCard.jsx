import { useEffect, useRef, useState } from 'react';
import { TrendingUp, BarChart2, Zap, Target, Bell, ArrowLeftRight, Newspaper } from 'lucide-react';
import Sparkline from './Sparkline.jsx';
import { formatPrice, formatPct, changeColor, timeAgo, sectorLabel } from '../utils/formatters.js';

const SIGNAL_ICON = {
  breakout: TrendingUp,
  volume: BarChart2,
  divergence: Zap,
  proximity52w: Target,
  personal: Bell,
  drift: ArrowLeftRight,
};

function SignificanceMeter({ scorePct }) {
  const tone = scorePct >= 70 ? 'bg-high' : scorePct >= 45 ? 'bg-accent' : 'bg-muted/50';
  return (
    <div className="flex items-center gap-1.5" title={`Significance ${scorePct}/100`}>
      <div className="h-1 w-10 rounded-full bg-border/60 overflow-hidden">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.max(4, scorePct)}%` }} />
      </div>
      <span className="tnum text-[10px] font-medium text-muted/80">{scorePct}</span>
    </div>
  );
}

/**
 * One stock, as an attention card.
 *
 * The hierarchy is deliberate and inverted from a normal ticker row: the REASON
 * is the headline, the price is supporting detail. A user who already decided
 * to look at this stock does not need to be told its price first; they need to
 * be told why it is on top.
 */
export default function WatchlistCard({ item, onMarkSeen, onOpen, isTop }) {
  const sig = item.significance;
  const [flash, setFlash] = useState(null);
  const [news, setNews] = useState(null);
  const prevPrice = useRef(item.price);

  useEffect(() => {
    if (sig.significant) {
      import('../services/api.js').then(({ api }) => {
        api.getNews(item.symbol).then(res => setNews(res.news)).catch(() => {});
      });
    }
  }, [item.symbol, sig.significant]);

  // Flash the price cell on a tick so live updates are perceptible without
  // being noisy. Fires only on a real change, not on every re-render.
  useEffect(() => {
    const prev = prevPrice.current;
    if (prev != null && item.price != null && prev !== item.price) {
      setFlash(item.price > prev ? 'up' : 'down');
      const t = setTimeout(() => setFlash(null), 900);
      prevPrice.current = item.price;
      return () => clearTimeout(t);
    }
    prevPrice.current = item.price;
    return undefined;
  }, [item.price]);

  if (item.unavailable) {
    return (
      <article className="card p-4 opacity-60">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-semibold truncate">{item.symbol.replace('.NS', '')}</h3>
            <p className="text-xs text-muted truncate">{item.displayName}</p>
          </div>
          <span className="chip bg-warn/15 text-warn shrink-0">Data unavailable</span>
        </div>
        <p className="mt-2 text-xs text-muted">
          We could not price this symbol. It may be delisted or renamed upstream — your last known
          data is preserved and we keep retrying.
        </p>
        <button onClick={() => onOpen(item)} className="btn-ghost mt-1 px-0 text-xs">
          Details
        </button>
      </article>
    );
  }

  const seenAgo = item.lastSeen?.at ? timeAgo(item.lastSeen.at) : null;
  const drift = sig.changeSinceSeen;
  const secondaryReasons = (sig.reasons ?? []).slice(1).filter((r) => !(r.key === 'drift' && drift));
  // Colour the sparkline by the move it actually plots (first close to last),
  // not by today's change -- otherwise a stock up over the month but down today
  // draws a red line that contradicts the trend the line shows.
  const sparkPositive =
    item.sparkline?.length >= 2
      ? item.sparkline.at(-1) >= item.sparkline[0]
      : (item.dayChangePct ?? 0) >= 0;

  return (
    <article
      className={`card p-4 animate-riseIn transition-colors ${
        isTop ? 'border-high/40 shadow-[0_0_0_1px_rgba(210,168,255,0.12)]' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <button onClick={() => onOpen(item)} className="min-w-0 text-left group">
          <div className="flex items-center gap-2">
            <span
              className={`h-2 w-2 rounded-full shrink-0 ${
                item.freshness?.state === 'live' ? 'bg-gain' :
                item.freshness?.state === 'delayed' ? 'bg-warn' :
                item.freshness?.state === 'stale' ? 'bg-[#FFA500]' :
                item.freshness?.state === 'closed' ? 'bg-muted' : 'bg-loss'
              }`}
              title={`Data confidence: ${item.freshness?.state}`}
            />
            <h3 className="font-semibold tracking-tight group-hover:text-accent transition-colors">
              {item.symbol.replace('.NS', '')}
            </h3>
            {item.sector && (
              <span className="chip bg-surface2 text-muted text-[10px]">{sectorLabel(item.sector)}</span>
            )}
          </div>
          <p className="text-xs text-muted truncate max-w-[16rem]">{item.displayName}</p>
        </button>

        <div className="text-right shrink-0">
          <div
            className={`tnum font-semibold rounded px-1 ${
              flash === 'up' ? 'animate-flashUp' : flash === 'down' ? 'animate-flashDown' : ''
            }`}
          >
            {formatPrice(item.price, { currency: item.currency })}
          </div>
          <div className={`tnum text-sm ${changeColor(item.dayChangePct)}`}>
            {formatPct(item.dayChangePct)}
          </div>
        </div>
      </div>

      {/* The reason is the point of the card. */}
      <div className="mt-5">
        {/* Primary reason */}
        <div className="flex items-start gap-4 relative z-10">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/15 border border-accent/20 text-accent shadow-sm">
            {(() => {
              const Icon = SIGNAL_ICON[sig.reasons?.[0]?.key];
              return Icon ? <Icon size={16} strokeWidth={2.5} /> : <span className="h-2 w-2 rounded-full bg-accent" />;
            })()}
          </div>
          <p className="text-[14px] font-medium text-txt/90 leading-6 pt-1">{sig.reason}</p>
        </div>
        
        {(news || secondaryReasons.length > 0) && (
          <div className="ml-[15px] border-l-2 border-border/20 pt-4 pb-1 pl-7 -mt-2">
            {news && (
              <div className="text-[12px] text-muted flex gap-3 items-start mb-3">
                <Newspaper size={14} strokeWidth={2} className="shrink-0 mt-[1px] text-muted/70" /> 
                <span className="leading-relaxed">{news.headline} <span className="opacity-60 ml-1">({timeAgo(news.date)})</span></span>
              </div>
            )}
            
            {secondaryReasons.length > 0 && (
              <ul className="space-y-3">
                {secondaryReasons.map((r) => {
                  const Icon = SIGNAL_ICON[r.key];
                  return (
                    <li key={r.key} className="text-[12px] text-muted flex gap-3 items-start">
                      {Icon ? <Icon size={13} strokeWidth={2.5} className="shrink-0 mt-[2px] opacity-50" /> : <span className="w-3" />} 
                      <span className="leading-relaxed">{r.reason}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>

      <div className="mt-4 pt-3 border-t border-border/30 flex items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <SignificanceMeter scorePct={sig.scorePct} />
          <Sparkline points={item.sparkline} positive={sparkPositive} />
        </div>

        <div className="flex items-center gap-3">
          {drift && sig.reasons?.[0]?.key !== 'drift' && (
            <span className={`tnum text-[11px] font-medium ${changeColor(drift.changePct)}`}>
              {formatPct(drift.changePct, { digits: 1 })} since seen
            </span>
          )}
          <button
            onClick={() => onMarkSeen(item.symbol, sig.reasons?.[0]?.key)}
            className="btn-ghost px-2.5 py-1 min-h-0 text-xs border border-border/50 rounded hover:bg-surface2"
            title={seenAgo ? `Last acknowledged ${seenAgo}` : 'Never acknowledged'}
          >
            {sig.isNew ? 'Got it' : 'Mark seen'}
          </button>
        </div>
      </div>
    </article>
  );
}
