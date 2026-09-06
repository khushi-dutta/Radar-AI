import { useEffect, useState } from 'react';
import Sparkline from './Sparkline.jsx';
import {
  formatPrice,
  formatPct,
  formatVolume,
  changeColor,
  formatIST,
  timeAgo,
} from '../utils/formatters.js';

const SIGNAL_LABELS = {
  breakout: 'Range breakout',
  volume: 'Unusual volume',
  divergence: 'Sector divergence',
  proximity52w: '52-week proximity',
  personal: 'Your price levels',
  drift: 'Move since you last checked',
};

function Row({ label, value, tone = '' }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="text-xs text-muted">{label}</span>
      <span className={`tnum text-sm ${tone}`}>{value}</span>
    </div>
  );
}

/**
 * The audit trail for a score.
 *
 * Showing each signal's raw score, its salience cap and its inputs is what
 * makes the ranking trustworthy: a user who disagrees with the order can see
 * exactly which signal caused it rather than being asked to trust a number.
 */
function SignalBreakdown({ signals }) {
  const entries = Object.entries(signals ?? {});
  return (
    <div className="space-y-2">
      {entries.map(([key, sig]) => {
        if (!sig.available) {
          return (
            <div key={key} className="flex items-center justify-between gap-3 text-xs">
              <span className="text-muted">{SIGNAL_LABELS[key] ?? key}</span>
              <span className="text-muted/60 italic">not enough data</span>
            </div>
          );
        }
        const pct = Math.round(sig.score * 100);
        return (
          <div key={key}>
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className={sig.score > 0 ? 'text-txt' : 'text-muted'}>
                {SIGNAL_LABELS[key] ?? key}
              </span>
              <span className="tnum text-muted">
                {pct} <span className="opacity-50">× {sig.salience}</span>
              </span>
            </div>
            <div className="mt-1 h-1 rounded-full bg-border overflow-hidden">
              <div
                className={`h-full rounded-full ${sig.score >= 0.6 ? 'bg-high' : sig.score > 0 ? 'bg-accent' : 'bg-transparent'}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            {sig.reason && sig.score > 0 && (
              <p className="mt-1 text-[11px] text-muted">{sig.reason}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function StockDetailPanel({ item, onClose, onUpdate, onRemove }) {
  const [buyPrice, setBuyPrice] = useState(item.buyPrice ?? '');
  const [alertPrice, setAlertPrice] = useState(item.alertPrice ?? '');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  // Escape closes, and the panel traps nothing — it is a sheet, not a modal
  // that hijacks the page.
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    const res = await onUpdate(item.symbol, {
      buyPrice: buyPrice === '' ? null : Number(buyPrice),
      alertPrice: alertPrice === '' ? null : Number(alertPrice),
    });
    setSaving(false);
    if (!res?.ok) setSaveError(res?.error?.message ?? 'Could not save');
    else onClose();
  };

  const sig = item.significance;

  return (
    <div className="fixed inset-0 z-40 flex items-end sm:items-center sm:justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />

      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${item.symbol} details`}
        className="relative w-full sm:max-w-lg max-h-[88vh] overflow-y-auto card rounded-b-none sm:rounded-b-xl p-5 animate-riseIn"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">{item.symbol.replace('.NS', '')}</h2>
            <p className="text-xs text-muted truncate">{item.displayName}</p>
          </div>
          <button onClick={onClose} className="btn-ghost px-2 -mr-2" aria-label="Close">✕</button>
        </div>

        <div className="mt-4 flex items-end justify-between gap-4">
          <div>
            <div className="tnum text-2xl font-semibold">
              {formatPrice(item.price, { currency: item.currency })}
            </div>
            <div className={`tnum text-sm ${changeColor(item.dayChangePct)}`}>
              {formatPct(item.dayChangePct)} today
            </div>
          </div>
          <Sparkline
            points={item.sparkline}
            positive={
              item.sparkline?.length >= 2
                ? item.sparkline.at(-1) >= item.sparkline[0]
                : (item.dayChangePct ?? 0) >= 0
            }
            width={140}
            height={44}
          />
        </div>

        {/* Why this is where it is in the list. */}
        <section className="mt-5">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">Why it surfaced</h3>
            <span className="chip bg-accent/10 text-accent">Signal {sig.scorePct}</span>
          </div>
          <p className="mt-1.5 text-sm text-txt/90">{sig.reason}</p>
          <div className="mt-4">
            <SignalBreakdown signals={sig.signals} />
          </div>
          <p className="mt-3 text-[11px] text-muted leading-4">
            Signals combine with a noisy-OR, so one strong signal is enough on its own.
            {sig.hoursSinceSeen != null && (
              <> Amplified ×{sig.timeAmplifier} because you last checked {timeAgo(item.lastSeen?.at)}.</>
            )}
            {sig.isNew && <> No baseline yet — comparing against today&apos;s open.</>}
          </p>
        </section>

        <section className="mt-5 grid grid-cols-2 gap-x-6">
          <div>
            <Row label="Day range" value={item.dayLow != null ? `${formatPrice(item.dayLow)} – ${formatPrice(item.dayHigh)}` : '--'} />
            <Row label="52-week range" value={item.low52w != null ? `${formatPrice(item.low52w)} – ${formatPrice(item.high52w)}` : '--'} />
            <Row label="2-week channel" value={item.low2w != null ? `${formatPrice(item.low2w)} – ${formatPrice(item.high2w)}` : '--'} />
          </div>
          <div>
            <Row label="Volume" value={formatVolume(item.volume)} />
            <Row label="20-day avg volume" value={formatVolume(item.avgVolume20d)} />
            <Row
              label={item.benchmark?.label ?? 'Benchmark'}
              value={formatPct(item.benchmark?.dayChangePct)}
              tone={changeColor(item.benchmark?.dayChangePct)}
            />
          </div>
        </section>

        {item.pnlPct != null && (
          <div className="mt-3 rounded-lg bg-surface2 px-3 py-2 flex items-center justify-between">
            <span className="text-xs text-muted">Since your buy price of {formatPrice(item.buyPrice)}</span>
            <span className={`tnum text-sm ${changeColor(item.pnlPct)}`}>{formatPct(item.pnlPct)}</span>
          </div>
        )}

        {/* Personal context: the only signal that knows about this user. */}
        <section className="mt-5">
          <h3 className="text-sm font-medium">Your levels</h3>
          <p className="text-[11px] text-muted mt-0.5">
            Crossing either of these is treated as a strong signal.
          </p>
          <div className="mt-2.5 grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-muted">Buy price</span>
              <input
                className="input mt-1 tnum"
                inputMode="decimal"
                placeholder="--"
                value={buyPrice}
                onChange={(e) => setBuyPrice(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="text-xs text-muted">Alert price</span>
              <input
                className="input mt-1 tnum"
                inputMode="decimal"
                placeholder="--"
                value={alertPrice}
                onChange={(e) => setAlertPrice(e.target.value)}
              />
            </label>
          </div>
          {saveError && <p className="mt-2 text-xs text-loss">{saveError}</p>}
          <div className="mt-3 flex items-center gap-2">
            <button onClick={save} disabled={saving} className="btn-primary flex-1">
              {saving ? 'Saving…' : 'Save levels'}
            </button>
            <button
              onClick={() => { onRemove(item.symbol); onClose(); }}
              className="btn-ghost text-loss hover:bg-loss/10"
            >
              Remove
            </button>
          </div>
        </section>

        <p className="mt-4 text-[11px] text-muted">
          Data {item.freshness?.state} · fetched {formatIST(item.freshness?.fetchedAt, { withDate: true })}
          {item.lastSeen?.at && <> · you last saw this at {formatPrice(item.lastSeen.price)}</>}
        </p>
      </div>
    </div>
  );
}
