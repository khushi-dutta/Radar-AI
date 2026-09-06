import { randomUUID } from 'node:crypto';
import { db, nowIso } from '../config/database.js';

const listStmt = db.prepare('SELECT * FROM activity_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 50');
const insertStmt = db.prepare(`
  INSERT INTO activity_log (id, user_id, symbol, event_type, message, created_at)
  VALUES (@id, @user_id, @symbol, @event_type, @message, @created_at)
`);

export function listLogs(userId) {
  return listStmt.all(userId);
}

export function addLog(userId, { symbol, eventType, message, createdAt = nowIso() }) {
  const id = randomUUID();
  insertStmt.run({ id, user_id: userId, symbol, event_type: eventType, message, created_at: createdAt });
  return { id, symbol, eventType, message, createdAt };
}
