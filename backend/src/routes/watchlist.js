import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import {
  addItem,
  removeItem,
  updateItem,
  getItem,
  countItems,
  markSeen,
  clearView,
  DuplicateSymbolError,
} from '../models/watchlistModel.js';
import { touchLastSeen, updateUserPreferences } from '../models/userModel.js';
import { buildWatchlist, observationsFor } from '../services/watchlistService.js';
import { ensureFresh, refreshSymbols } from '../services/marketData.js';
import { lookup } from '../config/universe.js';
import { probeSymbol, ProviderError } from '../providers/yahoo.js';
import {
  normalizeSymbol,
  validateOptionalPrice,
  ValidationError,
} from '../utils/validation.js';
import { fetchLatestNews } from '../services/newsService.js';
import { listAlerts, addAlert, removeAlert } from '../models/alertModel.js';
import { listLogs, addLog } from '../models/activityModel.js';

const router = Router();
router.use(requireAuth);

// A ceiling that exists to bound worst-case work per user, not to be reached.
const MAX_WATCHLIST_SIZE = 150;

/* ------------------------------------------------- adaptive signal weights */

const WEIGHT_DECAY = 0.95;   // the dismissed signal loses 5%
const WEIGHT_RECOVER = 0.01; // every other signal creeps 1% back toward neutral
const WEIGHT_FLOOR = 0.4;    // never silence a signal outright

/**
 * Nudge this user's per-signal salience multipliers after a dismissal.
 *
 * Decay ALONE was the obvious version and it is a one-way ratchet: dismissing
 * is the ordinary way to clear a card, so every signal drifts monotonically
 * toward the floor and the engine gradually goes deaf. Pairing decay with a
 * slower recovery on the signals that were *not* dismissed gives the system a
 * fixed point instead: a signal settles where the rate you dismiss it balances
 * the rate you dismiss other things. It measures RELATIVE preference, which is
 * the only thing a dismissal is actually evidence of.
 *
 * The floor is 0.4, not 0.1: this is inferred from clicks, not stated, and
 * inference that weak should never be able to hide a 52-week breakout outright.
 */
function adjustSignalWeights(user, dismissedKey) {
  let prefs = {};
  if (user.preferences) {
    try {
      const parsed = JSON.parse(user.preferences);
      if (parsed && typeof parsed === 'object') prefs = parsed;
    } catch (err) {
      console.warn(`[weights] unreadable preferences for user ${user.id}; resetting`, err.message);
    }
  }

  for (const key of Object.keys(prefs)) {
    if (key === dismissedKey) continue;
    // Toward 1.0 from whichever side, so this cannot overshoot into inflation.
    prefs[key] = Number((prefs[key] + (1 - prefs[key]) * WEIGHT_RECOVER).toFixed(4));
  }

  const current = typeof prefs[dismissedKey] === 'number' ? prefs[dismissedKey] : 1.0;
  prefs[dismissedKey] = Number(Math.max(WEIGHT_FLOOR, current * WEIGHT_DECAY).toFixed(4));

  updateUserPreferences(user.id, prefs);
  // Keep the in-memory copy consistent for anything later in this request.
  user.preferences = JSON.stringify(prefs);
}

/**
 * GET /api/watchlist
 *
 * `?visit=true` (the app's landing fetch) also rolls the user's last-visit
 * marker forward, which drives the "since you last checked" header. Plain
 * polling refreshes must NOT do that, or the window would collapse to zero
 * every few seconds and nothing would ever look like it changed.
 */
router.get(
  '/',
  asyncRoute(async (req, res) => {
    const isVisit = req.query.visit === 'true';
    const priorVisit = isVisit ? touchLastSeen(req.user.id) : req.user.last_seen_at;

    const payload = await buildWatchlist(req.user.id, {
      refresh: req.query.refresh !== 'false',
    });

    res.json({ ...payload, lastVisitAt: priorVisit ?? null });
  })
);

router.post(
  '/',
  asyncRoute(async (req, res) => {
    const symbol = normalizeSymbol(req.body?.symbol);
    const buyPrice = validateOptionalPrice(req.body?.buyPrice, 'buyPrice') ?? null;
    const alertPrice = validateOptionalPrice(req.body?.alertPrice, 'alertPrice') ?? null;

    if (countItems(req.user.id) >= MAX_WATCHLIST_SIZE) {
      throw new ValidationError(`A watchlist can hold at most ${MAX_WATCHLIST_SIZE} symbols`);
    }

    // Verify the symbol actually exists before persisting it. Skipped for the
    // curated universe, which we already know is real -- that keeps the common
    // path free of an upstream round trip.
    const known = lookup(symbol);
    if (!known) {
      let probed;
      try {
        probed = await probeSymbol(symbol);
      } catch (err) {
        // Upstream being down is not evidence the symbol is invalid. Refusing
        // to guess is better than rejecting a real ticker during an outage.
        if (err instanceof ProviderError) {
          throw Object.assign(
            new Error('Cannot verify that symbol right now. Please try again shortly.'),
            { status: 503 }
          );
        }
        throw err;
      }
      if (!probed) throw new ValidationError(`We could not find "${symbol}"`, 'symbol');
    }

    const item = addItem(req.user.id, {
      symbol,
      displayName: known?.name ?? null,
      buyPrice,
      alertPrice,
    });
    addLog(req.user.id, { symbol, eventType: 'added', message: `Added ${symbol} to watchlist` });

    // Warm the cache so the very next render has real numbers, but do not make
    // the user wait on it or fail the add if upstream is slow.
    ensureFresh([symbol]).catch(() => {});

    res.status(201).json({ item });
  })
);

router.patch(
  '/:symbol',
  asyncRoute(async (req, res) => {
    const symbol = normalizeSymbol(req.params.symbol);
    const patch = {
      buyPrice: validateOptionalPrice(req.body?.buyPrice, 'buyPrice'),
      alertPrice: validateOptionalPrice(req.body?.alertPrice, 'alertPrice'),
    };
    const updated = updateItem(req.user.id, symbol, patch);
    if (!updated) throw Object.assign(new Error(`${symbol} is not in your watchlist`), { status: 404 });
    res.json({ item: updated });
  })
);

router.delete(
  '/:symbol',
  asyncRoute(async (req, res) => {
    const symbol = normalizeSymbol(req.params.symbol);
    const removed = removeItem(req.user.id, symbol);
    if (!removed) throw Object.assign(new Error(`${symbol} is not in your watchlist`), { status: 404 });
    // Drop the baseline too, so re-adding later starts fresh rather than
    // resurrecting a months-old "since you last checked" comparison.
    clearView(req.user.id, symbol);
    res.json({ removed: symbol });
  })
);

/** Acknowledge every symbol at once: the "I have read this" button. */
router.post(
  '/mark-seen',
  asyncRoute(async (req, res) => {
    const observations = observationsFor(req.user.id);
    const n = markSeen(req.user.id, observations);
    res.json({ marked: n, at: new Date().toISOString() });
  })
);

router.post(
  '/:symbol/seen',
  asyncRoute(async (req, res) => {
    const symbol = normalizeSymbol(req.params.symbol);
    const reasonKey = req.body?.reasonKey;

    if (!getItem(req.user.id, symbol)) {
      throw Object.assign(new Error(`${symbol} is not in your watchlist`), { status: 404 });
    }

    // Dismissing a card is weak evidence that the signal which headlined it is
    // not what this user cares about. `personal` is excluded: a threshold they
    // typed in themselves is an explicit instruction, not an inference we get
    // to second-guess.
    if (reasonKey && reasonKey !== 'personal') {
      adjustSignalWeights(req.user, reasonKey);
    }

    const observations = observationsFor(req.user.id, [symbol]);
    markSeen(req.user.id, observations);
    res.json({ marked: symbol, at: new Date().toISOString() });
  })
);

/** Manual refresh, for the pull-to-refresh affordance. */
router.post(
  '/refresh',
  asyncRoute(async (req, res) => {
    const payload = await buildWatchlist(req.user.id, { refresh: false });
    const symbols = payload.items.map((i) => i.symbol);
    if (symbols.length) await refreshSymbols(symbols);
    const fresh = await buildWatchlist(req.user.id, { refresh: false });
    res.json({ ...fresh, lastVisitAt: req.user.last_seen_at ?? null });
  })
);

router.get(
  '/:symbol/news',
  asyncRoute(async (req, res) => {
    const symbol = normalizeSymbol(req.params.symbol);
    const news = await fetchLatestNews(symbol);
    res.json({ news });
  })
);

router.get('/alerts', asyncRoute(async (req, res) => {
  res.json({ alerts: listAlerts(req.user.id) });
}));
router.post('/alerts', asyncRoute(async (req, res) => {
  const { symbol, ruleType, threshold } = req.body;
  const alert = addAlert(req.user.id, { symbol: normalizeSymbol(symbol), ruleType, threshold });
  res.status(201).json({ alert });
}));
router.delete('/alerts/:id', asyncRoute(async (req, res) => {
  removeAlert(req.user.id, req.params.id);
  res.json({ removed: req.params.id });
}));

router.get('/activity', asyncRoute(async (req, res) => {
  res.json({ logs: listLogs(req.user.id) });
}));

export default router;
