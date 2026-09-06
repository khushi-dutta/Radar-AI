import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR ?? path.join(__dirname, '..', '..', 'data');
const DB_PATH = process.env.DB_PATH ?? path.join(DATA_DIR, 'radar.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);

// WAL lets the background refresh worker write prices while HTTP requests read,
// without readers blocking. NORMAL sync is the right durability trade for a
// cache whose worst-case loss is "re-fetch the prices".
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
// A write should wait for a busy lock rather than immediately throwing SQLITE_BUSY.
db.pragma('busy_timeout = 5000');

/**
 * Schema.
 *
 * Deviations from a Postgres original, all forced by SQLite's type system:
 *   UUID      -> TEXT holding crypto.randomUUID()
 *   TIMESTAMP -> TEXT holding an ISO-8601 UTC string (sorts lexicographically,
 *                which is exactly what the staleness comparisons need)
 *   DECIMAL   -> REAL. Acceptable because every number here is a market
 *                observation for display and scoring, never money moving
 *                between accounts. Nothing in this system settles a trade.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at  TEXT
);

CREATE TABLE IF NOT EXISTS watchlist_items (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol       TEXT NOT NULL,
  display_name TEXT,
  added_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  buy_price    REAL,
  alert_price  REAL,
  UNIQUE(user_id, symbol)
);
CREATE INDEX IF NOT EXISTS idx_watchlist_user ON watchlist_items(user_id);
-- Drives the background worker's "which symbols does anyone care about" query.
CREATE INDEX IF NOT EXISTS idx_watchlist_symbol ON watchlist_items(symbol);

-- The baseline the whole product rests on: what the user actually last SAW.
-- "What changed" is meaningless without a per-user, per-symbol snapshot.
CREATE TABLE IF NOT EXISTS user_stock_views (
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol             TEXT NOT NULL,
  last_viewed_at     TEXT NOT NULL,
  last_viewed_price  REAL,
  last_viewed_volume INTEGER,
  PRIMARY KEY (user_id, symbol)
);

CREATE TABLE IF NOT EXISTS market_data_cache (
  symbol          TEXT PRIMARY KEY,
  display_name    TEXT,
  currency        TEXT DEFAULT 'INR',
  current_price   REAL,
  previous_close  REAL,
  day_change_pct  REAL,
  day_high        REAL,
  day_low         REAL,
  volume          INTEGER,
  avg_volume_20d  INTEGER,
  high_52w        REAL,
  low_52w         REAL,
  high_2w         REAL,
  low_2w          REAL,
  sector          TEXT,
  sparkline       TEXT,             -- JSON array of recent daily closes
  -- Upstream's own timestamp for the quote. Distinct from fetched_at, and the
  -- key to rejecting out-of-order writes (see marketData.upsertQuote).
  source_ts       TEXT,
  fetched_at      TEXT,             -- when the quote last landed successfully
  history_fetched_at TEXT,          -- daily aggregates refresh far less often
  market_status   TEXT DEFAULT 'unknown',
  -- Failure bookkeeping, so we can degrade honestly instead of pretending.
  last_error      TEXT,
  last_error_at   TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  unavailable     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sector_benchmarks (
  sector         TEXT PRIMARY KEY,
  index_symbol   TEXT NOT NULL,
  label          TEXT,
  day_change_pct REAL,
  current_price  REAL,
  source_ts      TEXT,
  fetched_at     TEXT
);

CREATE TABLE IF NOT EXISTS alert_rules (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  rule_type TEXT NOT NULL, -- 'volume_spike', 'divergence', 'price_proximity', 'range_breakout'
  threshold REAL,
  is_active INTEGER DEFAULT 1,
  last_triggered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS activity_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol TEXT,
  event_type TEXT NOT NULL, -- 'alert_triggered', 'significant_move', 'added', etc.
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;

db.exec(SCHEMA);

try {
  db.exec('ALTER TABLE users ADD COLUMN preferences TEXT;');
} catch (e) {
  // column likely already exists
}

export function nowIso() {
  return new Date().toISOString();
}

export default db;
