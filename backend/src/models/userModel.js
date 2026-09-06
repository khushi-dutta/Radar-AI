import { randomUUID } from 'node:crypto';
import { db, nowIso } from '../config/database.js';

/**
 * The local user row, and the per-user state hanging off it.
 *
 * No credentials are stored: this deployment has no accounts. `label` exists
 * only so a row is legible when you open the database by hand.
 */

const insertUser = db.prepare('INSERT INTO users (id, label, created_at) VALUES (?, ?, ?)');
const byId = db.prepare('SELECT id, label, created_at, last_seen_at, preferences FROM users WHERE id = ?');
const byLabel = db.prepare('SELECT id, label, created_at, last_seen_at, preferences FROM users WHERE label = ?');
const firstUser = db.prepare(
  'SELECT id, label, created_at, last_seen_at, preferences FROM users ORDER BY created_at LIMIT 1'
);
const touchSeen = db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?');
const updatePrefs = db.prepare('UPDATE users SET preferences = ? WHERE id = ?');

const LOCAL_LABEL = 'local';

export function findById(id) {
  return byId.get(id) ?? null;
}

export function findByLabel(label) {
  return byLabel.get(label) ?? null;
}

/** Create a user row. Used by the local-identity resolver and by tests. */
export function createUser(label = LOCAL_LABEL) {
  const id = randomUUID();
  insertUser.run(id, label, nowIso());
  return { id, label };
}

/**
 * The single identity every request runs as.
 *
 * Prefers an existing row over creating one, so a database seeded before this
 * function ever ran -- or seeded under a different label -- keeps its watchlist
 * and its baselines instead of silently starting over behind an empty new user.
 * Losing the baseline is losing the product's memory, so this falls back
 * generously rather than insisting on an exact label match.
 */
export function getLocalUser() {
  return byLabel.get(LOCAL_LABEL) ?? firstUser.get() ?? createLocalUser();
}

function createLocalUser() {
  const { id } = createUser(LOCAL_LABEL);
  return byId.get(id);
}

export function updateUserPreferences(id, preferencesObj) {
  updatePrefs.run(JSON.stringify(preferencesObj), id);
}

/**
 * The user's previous visit time, captured BEFORE we overwrite it.
 *
 * The ordering matters: the "since you last checked" header is computed from
 * the visit before this one, so reading and writing must not be collapsed.
 */
export function touchLastSeen(userId) {
  const prior = byId.get(userId)?.last_seen_at ?? null;
  touchSeen.run(nowIso(), userId);
  return prior;
}
