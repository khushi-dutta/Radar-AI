import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db, nowIso } from '../config/database.js';

const insertUser = db.prepare(
  'INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)'
);
const byEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const byId = db.prepare('SELECT id, email, created_at, last_seen_at, preferences FROM users WHERE id = ?');
const touchSeen = db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?');
const updatePrefs = db.prepare('UPDATE users SET preferences = ? WHERE id = ?');

export function findByEmail(email) {
  return byEmail.get(email) ?? null;
}

export function findById(id) {
  return byId.get(id) ?? null;
}

export function createUser(email, password) {
  const id = randomUUID();
  // 10 rounds: enough to be a real barrier, cheap enough that a demo login is
  // not visibly slow. bcrypt is deliberate about being slow either way.
  const hash = bcrypt.hashSync(password, 10);
  insertUser.run(id, email, hash, nowIso());
  return { id, email };
}

export function updateUserPreferences(id, preferencesObj) {
  updatePrefs.run(JSON.stringify(preferencesObj), id);
}

export function verifyPassword(user, password) {
  if (!user?.password_hash) return false;
  return bcrypt.compareSync(password, user.password_hash);
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
