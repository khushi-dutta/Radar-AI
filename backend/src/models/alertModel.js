import { randomUUID } from 'node:crypto';
import { db, nowIso } from '../config/database.js';

const listStmt = db.prepare('SELECT * FROM alert_rules WHERE user_id = ? ORDER BY created_at DESC');
const insertStmt = db.prepare(`
  INSERT INTO alert_rules (id, user_id, symbol, rule_type, threshold)
  VALUES (@id, @user_id, @symbol, @rule_type, @threshold)
`);
const deleteStmt = db.prepare('DELETE FROM alert_rules WHERE user_id = ? AND id = ?');
const updateTriggerStmt = db.prepare('UPDATE alert_rules SET last_triggered_at = ? WHERE id = ?');
const getActiveStmt = db.prepare('SELECT * FROM alert_rules WHERE is_active = 1');

export function listAlerts(userId) {
  return listStmt.all(userId);
}

export function addAlert(userId, { symbol, ruleType, threshold }) {
  const id = randomUUID();
  insertStmt.run({ id, user_id: userId, symbol, rule_type: ruleType, threshold });
  return { id, symbol, ruleType, threshold, isActive: true };
}

export function removeAlert(userId, id) {
  return deleteStmt.run(userId, id).changes > 0;
}

export function updateAlertTrigger(id, at = nowIso()) {
  updateTriggerStmt.run(at, id);
}

export function getActiveAlerts() {
  return getActiveStmt.all();
}
