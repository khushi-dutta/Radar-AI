/**
 * Seeds a demo account with a watchlist and a BACKDATED view baseline.
 *
 * Why this exists: the central feature is "what changed since you last checked",
 * and a freshly created account has no last-check to compare against. Running
 * the app cold therefore shows the least interesting version of itself. This
 * script fabricates a plausible history -- a user who last looked three days
 * ago, at prices slightly different from today's -- so the drift signal, the
 * time amplifier and the personal-threshold signal all have something real to
 * work with.
 *
 *   node scripts/seed-demo.js
 *
 * It is idempotent: re-running resets the demo user's list and baseline.
 */

import { db, nowIso } from '../src/config/database.js';
import { createUser, findByEmail } from '../src/models/userModel.js';
import { addItem, markSeen, listItems } from '../src/models/watchlistModel.js';
import { refreshSymbols, refreshBenchmarks, getCachedRows, toQuote } from '../src/services/marketData.js';

const EMAIL = 'demo@groww.test';
const PASSWORD = 'hunter2hunter2';

const SYMBOLS = [
  'RELIANCE.NS', 'TCS.NS', 'HDFCBANK.NS', 'INFY.NS', 'SBIN.NS',
  'ITC.NS', 'TATASTEEL.NS', 'MARUTI.NS', 'ONGC.NS', 'DLF.NS',
  'BHARTIARTL.NS', 'SUNPHARMA.NS',
];

// Personal levels on a couple of names so the strongest signal is exercised.
const LEVELS = {
  'RELIANCE.NS': { buyPrice: 1250 },
  'INFY.NS': { alertPrice: 1150 },
};

// Deterministic pseudo-offsets, so a demo looks the same on every machine and
// the reviewer sees the behaviour we describe rather than a random draw.
const OFFSETS = [-0.031, 0.024, -0.018, 0.041, -0.009, 0.012, -0.052, 0.028, -0.014, 0.036, -0.022, 0.017];

const DAYS_AGO = 3;

async function main() {
  console.log('Seeding demo account...\n');

  let user = findByEmail(EMAIL);
  if (user) {
    console.log(`Resetting existing ${EMAIL}`);
    db.prepare('DELETE FROM watchlist_items WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM user_stock_views WHERE user_id = ?').run(user.id);
  } else {
    user = createUser(EMAIL, PASSWORD);
    console.log(`Created ${EMAIL}`);
  }

  console.log('Fetching benchmarks and quotes (this hits upstream once per symbol)...');
  await refreshBenchmarks();
  const results = await refreshSymbols(SYMBOLS);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.warn(`  ${failed.length} symbol(s) could not be priced: ${failed.map((f) => f.symbol).join(', ')}`);
    console.warn('  They will appear greyed out, which is the intended degraded state.');
  }

  for (const symbol of SYMBOLS) {
    try {
      addItem(user.id, { symbol, ...(LEVELS[symbol] ?? {}) });
    } catch (err) {
      if (err.name !== 'DuplicateSymbolError') throw err;
    }
  }
  console.log(`Added ${listItems(user.id).length} symbols`);

  // Build the backdated baseline from real current prices, nudged by a fixed
  // offset so "since you last checked" has genuine movement to report.
  const rows = getCachedRows(SYMBOLS);
  const seenAt = new Date(Date.now() - DAYS_AGO * 24 * 3600 * 1000).toISOString();

  const observations = SYMBOLS.map((symbol, i) => {
    const q = toQuote(rows.get(symbol));
    if (!q?.price) return null;
    const offset = OFFSETS[i % OFFSETS.length];
    return {
      symbol,
      price: Number((q.price * (1 + offset)).toFixed(2)),
      volume: q.volume,
    };
  }).filter(Boolean);

  markSeen(user.id, observations, seenAt);

  // Two different clocks track "last checked" and both must be backdated, or
  // the UI contradicts itself: the per-symbol baseline drives each card's
  // "since you last checked" number, while users.last_seen_at drives the header
  // that frames the whole visit. Seeding only the former left the page saying
  // "your first look" above cards reporting three-day moves.
  db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(seenAt, user.id);

  console.log(`Set a baseline as of ${DAYS_AGO} days ago for ${observations.length} symbols\n`);
  console.log('Demo ready:');
  console.log(`  email:    ${EMAIL}`);
  console.log(`  password: ${PASSWORD}`);
  console.log(`\nBecause the baseline is ${DAYS_AGO} days old, the time amplifier is near its cap,`);
  console.log('so genuine moves since that baseline will rank above ordinary intraday noise.');

  db.close();
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exitCode = 1;
});
