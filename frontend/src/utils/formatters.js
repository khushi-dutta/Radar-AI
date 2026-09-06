/** Display formatting. All money is INR, all times render in IST. */

export function formatPrice(v, { currency = 'INR' } = {}) {
  if (v == null || !Number.isFinite(v)) return '--';
  const symbol = currency === 'INR' ? '₹' : '';
  return symbol + v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatPct(v, { digits = 2, sign = true } = {}) {
  if (v == null || !Number.isFinite(v)) return '--';
  const s = sign && v > 0 ? '+' : '';
  return `${s}${v.toFixed(digits)}%`;
}

/** Indian digit grouping for volume: 1.2Cr / 4.5L / 12.3K. */
export function formatVolume(v) {
  if (v == null || !Number.isFinite(v)) return '--';
  if (v >= 1e7) return `${(v / 1e7).toFixed(2)}Cr`;
  if (v >= 1e5) return `${(v / 1e5).toFixed(2)}L`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}

export function changeColor(v) {
  if (v == null || !Number.isFinite(v) || v === 0) return 'text-muted';
  return v > 0 ? 'text-gain' : 'text-loss';
}

/** Compact elapsed time: "just now", "12m ago", "3h ago", "2d ago". */
export function timeAgo(iso, now = Date.now()) {
  if (!iso) return null;
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

/** Longer form for the "since you last checked" header. */
export function elapsedPhrase(iso, now = Date.now()) {
  if (!iso) return null;
  const ms = now - new Date(iso).getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'moments ago';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

/** DB timestamps are UTC; users are in India. Always show IST. */
export function formatIST(iso, { withDate = false } = {}) {
  if (!iso) return '--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--';
  const opts = {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    ...(withDate ? { day: 'numeric', month: 'short' } : {}),
  };
  return `${d.toLocaleString('en-IN', opts)} IST`;
}

// Explicit labels rather than title-casing: half of these are acronyms, and
// naive capitalisation renders them as "It" and "Fmcg".
const SECTOR_LABELS = {
  BANK: 'Bank',
  IT: 'IT',
  AUTO: 'Auto',
  PHARMA: 'Pharma',
  FMCG: 'FMCG',
  METAL: 'Metal',
  ENERGY: 'Energy',
  REALTY: 'Realty',
  INFRA: 'Infra',
  BROAD: 'Broad market',
};

export function sectorLabel(sector) {
  if (!sector) return null;
  return SECTOR_LABELS[sector] ?? sector;
}
