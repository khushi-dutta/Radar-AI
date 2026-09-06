import { randomUUID } from 'node:crypto';
import { db, nowIso } from '../config/database.js';

/** Raised when a symbol is already on the user's list (unique constraint). */
export class DuplicateSymbolError extends Error {
  constructor(symbol) {
    super(`${symbol} is already in your watchlist`);
    this.name = 'DuplicateSymbolError';
    this.status = 409;
  }
}

const listStmt = db.prepare(
  'SELECT * FROM watchlist_items WHERE user_id = ? ORDER BY added_at ASC'
);
const insertStmt = db.prepare(`
  INSERT INTO watchlist_items (id, user_id, symbol, display_name, added_at, buy_price, alert_price)
  VALUES (@id, @user_id, @symbol, @display_name, @added_at, @buy_price, @alert_price)
`);
const deleteStmt = db.prepare('DELETE FROM watchlist_items WHERE user_id = ? AND symbol = ?');
const getOneStmt = db.prepare('SELECT * FROM watchlist_items WHERE user_id = ? AND symbol = ?');
const countStmt = db.prepare('SELECT COUNT(*) AS n FROM watchlist_items WHERE user_id = ?');

export function listItems(userId) {
  return listStmt.all(userId);
}

export function getItem(userId, symbol) {
  return getOneStmt.get(userId, symbol) ?? null;
}

export function countItems(userId) {
  return countStmt.get(userId).n;
}

export function addItem(userId, { symbol, displayName = null, buyPrice = null, alertPrice = null }) {
  try {
    insertStmt.run({
      id: randomUUID(),
      user_id: userId,
      symbol,
      display_name: displayName,
      added_at: nowIso(),
      buy_price: buyPrice,
      alert_price: alertPrice,
    });
  } catch (err) {
    // The unique index is the authority on duplicates, not a prior SELECT.
    // Checking first would still race with the user's other device.
    if (String(err.code).includes('SQLITE_CONSTRAINT')) {
      throw new DuplicateSymbolError(symbol);
    }
    throw err;
  }
  return getItem(userId, symbol);
}

export function removeItem(userId, symbol) {
  return deleteStmt.run(userId, symbol).changes > 0;
}

/** Patch buy/alert price. `undefined` leaves a field alone; `null` clears it. */
export function updateItem(userId, symbol, patch) {
  const current = getItem(userId, symbol);
  if (!current) return null;
  const buy = patch.buyPrice === undefined ? current.buy_price : patch.buyPrice;
  const alert = patch.alertPrice === undefined ? current.alert_price : patch.alertPrice;
  db.prepare(
    'UPDATE watchlist_items SET buy_price = ?, alert_price = ? WHERE user_id = ? AND symbol = ?'
  ).run(buy, alert, userId, symbol);
  return getItem(userId, symbol);
}

/* --------------------------------------------------------------- view state */

const viewsStmt = db.prepare('SELECT * FROM user_stock_views WHERE user_id = ?');

/** symbol -> the snapshot this user last acknowledged. */
export function getViews(userId) {
  return new Map(viewsStmt.all(userId).map((v) => [v.symbol, v]));
}

/**
 * Record that the user has seen a symbol at a given price.
 *
 * The guard on last_viewed_at makes this idempotent and safe across devices: if
 * the phone and the laptop both mark the same symbol seen, the later
 * acknowledgement wins and the earlier one is discarded rather than rewinding
 * the baseline. Without it, a slow request from a backgrounded tab could
 * resurrect an old baseline and re-surface changes the user already dismissed.
 */
const markSeenStmt = db.prepare(`
INSERT INTO user_stock_views (user_id, symbol, last_viewed_at, last_viewed_price, last_viewed_volume)
VALUES (@user_id, @symbol, @at, @price, @volume)
ON CONFLICT(user_id, symbol) DO UPDATE SET
  last_viewed_at     = excluded.last_viewed_at,
  last_viewed_price  = excluded.last_viewed_price,
  last_viewed_volume = excluded.last_viewed_volume
WHERE excluded.last_viewed_at >= user_stock_views.last_viewed_at
`);

/**
 * @param {Array<{symbol, price, volume}>} observations
 * Wrapped in a transaction so "mark all seen" is all-or-nothing: a partial
 * apply would leave the list in a state where some cards silently reset.
 */
export const markSeen = db.transaction((userId, observations, at = nowIso()) => {
  for (const o of observations) {
    markSeenStmt.run({
      user_id: userId,
      symbol: o.symbol,
      at,
      price: o.price ?? null,
      volume: o.volume ?? null,
    });
  }
  return observations.length;
});

const clearViewStmt = db.prepare('DELETE FROM user_stock_views WHERE user_id = ? AND symbol = ?');

/** Drop view state when an item leaves the list, so re-adding starts clean. */
export function clearView(userId, symbol) {
  clearViewStmt.run(userId, symbol);
}
