/**
 * Identity, for a single-user local deployment.
 *
 * There are no accounts, no passwords and no tokens. Every request resolves to
 * one persistent local user row, created on first use.
 *
 * Why the `users` table still exists, and why every other table is still keyed
 * by `user_id`: the interesting state in this product is inherently per-person.
 * `user_stock_views` is "the price YOU last saw", the salience weights are
 * "what YOU ignore", the alert rules are yours. Collapsing that into global
 * state would not simplify the schema so much as delete the idea behind it, and
 * the significance engine would lose the baseline that makes it a watchlist
 * rather than a ticker.
 *
 * So the data model stays multi-tenant and only the *identity* layer is a
 * constant. Restoring real accounts means putting a login in front of this
 * function -- not a migration, and nothing downstream of here changes.
 */

import { getLocalUser } from '../models/userModel.js';

/** Attach the local user to the request. Runs before every data route. */
export function attachUser(req, res, next) {
  try {
    req.user = getLocalUser();
    next();
  } catch (err) {
    next(err);
  }
}
