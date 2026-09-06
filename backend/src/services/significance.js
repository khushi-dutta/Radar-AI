/**
 * The significance engine.
 *
 * This is the product. Everything else in the codebase exists to feed it clean
 * inputs and render its output.
 *
 * Design rules it follows:
 *
 *  1. PURE. No I/O, no clock reads except the injected `now`. The entire engine
 *     is a function of (quote, benchmark, what-the-user-last-saw). That is what
 *     makes it testable, and it is why scoring 100 symbols is a tight loop over
 *     already-fetched rows rather than 100 awaits.
 *
 *  2. EXPLAINABLE. Every signal returns a score AND the sentence a human would
 *     say. A score you cannot justify to a user is a number you should not sort
 *     their attention by. The UI shows the reason, not the score.
 *
 *  3. HONEST ABOUT MISSING INPUTS. A signal whose inputs are absent returns
 *     `available: false` and is excluded from the combination, rather than
 *     scoring 0. Those are different claims: "this stock is not unusual" versus
 *     "we do not know". Scoring absent data as 0 silently penalises every newly
 *     listed stock and every symbol we failed to fetch history for.
 *
 *  4. COMBINED WITH A NOISY-OR, NOT AN AVERAGE. See the SALIENCE block below;
 *     this is the decision that makes the ranking behave like attention rather
 *     than like a report card.
 */

import { sessionElapsedFraction } from '../utils/marketHours.js';

const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Map a raw magnitude onto 0..1 with an explicit dead zone.
 * `floor` is where a signal starts counting at all, `ceil` is where it saturates.
 * The dead zone matters: without it, every stock scores slightly non-zero on
 * everything and the ranking degenerates into noise.
 */
function ramp(value, floor, ceil) {
  if (!isNum(value)) return 0;
  return clamp01((value - floor) / (ceil - floor));
}

/**
 * Per-signal SALIENCE: the most significance this signal alone can justify.
 *
 * Note these do not sum to 1, because the aggregator is not a weighted mean.
 * That distinction is the single most important decision in this file.
 *
 * A weighted mean was the obvious first implementation and it is wrong for this
 * problem. Averaging answers "how unusual is this stock on average across five
 * dimensions", but the question a watchlist actually asks is "is ANY of this
 * worth my attention". Under a mean, a signal can never contribute more than
 * its weight, so with five signals a single decisive breakout tops out around
 * 0.24 and can never cross a sane threshold -- it gets averaged to nothing by
 * four signals that are calm, which is exactly the situation where the one
 * firing signal is the whole story. Measured on live data, Reliance breaking a
 * two-week high while diverging 2.1% from Nifty Energy scored 0.29 and was
 * suppressed.
 *
 * So signals are combined with a noisy-OR instead:
 *
 *     significance = 1 - PRODUCT(1 - salience_i * score_i)
 *
 * This reads as "the chance that at least one of these means something". It has
 * the properties the product needs: one strong signal is enough on its own,
 * several weak signals compound rather than cancel, the result is bounded by 1,
 * and a quiet or unavailable signal multiplies by exactly 1 -- contributing
 * nothing instead of dragging the score down. The "absent is not zero" rule
 * stops being special-case handling and becomes a property of the arithmetic.
 *
 * The numbers themselves are judgement calls, not fitted parameters; there is
 * no labelled "was this worth your attention" dataset to fit against.
 */
export const SALIENCE = {
  breakout: 0.75,
  volume: 0.70,
  personal: 0.85, // a price the user wrote down outranks anything we infer
  divergence: 0.65,
  proximity52w: 0.50,
};
const DRIFT_SALIENCE = 0.80;
// A never-seen stock has no baseline, so drift falls back to the day move. That
// is a weaker claim than "this moved since you looked", and is capped lower.
const DRIFT_BASELINE_SALIENCE = 0.60;

/** Score at or above which an item earns a slot in the "What Changed" view. */
export const SIGNIFICANCE_THRESHOLD = 0.35;

function fmtPrice(v) {
  if (!isNum(v)) return '--';
  // Reason strings are rendered verbatim in the UI, so they carry their own
  // currency symbol rather than relying on the caller to prefix one.
  return `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtPct(v, digits = 1) {
  if (!isNum(v)) return '--';
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

/* ------------------------------------------------------------------ signals */

/**
 * Unusual volume, corrected for how much of the session has actually elapsed.
 *
 * Raw `volume / avgVolume20d` is wrong intraday and confidently so: at 09:45 a
 * perfectly normal stock has traded ~8% of its daily volume and looks dead, and
 * at 15:29 it looks like a 1x. Scaling the baseline by the elapsed session
 * fraction makes the ratio mean the same thing at every point in the day.
 */
function volumeSignal({ quote, now, marketStatus }) {
  if (!isNum(quote.volume) || !isNum(quote.avgVolume20d) || quote.avgVolume20d <= 0) {
    return { available: false };
  }
  const fraction = sessionElapsedFraction(now);
  const expected = quote.avgVolume20d * fraction;
  if (expected <= 0) return { available: false };

  const ratio = quote.volume / expected;
  const score = ramp(ratio, 1.5, 3.5);
  const paceNote = marketStatus === 'open' ? ' so far today' : '';

  return {
    available: true,
    score,
    detail: { ratio: Number(ratio.toFixed(2)), sessionFraction: Number(fraction.toFixed(3)) },
    reason:
      ratio >= 1.5
        ? `Volume ${ratio.toFixed(1)}x its 20-day average${paceNote}`
        : `Volume ${ratio.toFixed(1)}x average${paceNote}`,
  };
}

/**
 * Break of the 10-session (~2 week) high/low channel.
 *
 * Two things are combined: how decisively price cleared the channel, and how
 * tight the channel was. A 0.4% break out of a 3%-wide two-week coil is a more
 * interesting event than a 0.4% break out of a 15%-wide chop, and a pure
 * percentage rule cannot tell them apart.
 */
function breakoutSignal({ quote }) {
  const { price, high2w, low2w } = quote;
  if (!isNum(price) || !isNum(high2w) || !isNum(low2w) || low2w <= 0) {
    return { available: false };
  }

  const channelWidthPct = ((high2w - low2w) / low2w) * 100;
  // 1.0 for a coiled channel, decaying to 0 for a wide, already-volatile one.
  const tightness = clamp01((12 - channelWidthPct) / 12);

  let penetrationPct = 0;
  let direction = null;
  if (price > high2w) {
    penetrationPct = ((price - high2w) / high2w) * 100;
    direction = 'above';
  } else if (price < low2w) {
    penetrationPct = ((low2w - price) / low2w) * 100;
    direction = 'below';
  }

  if (!direction) {
    return {
      available: true,
      score: 0,
      detail: { direction: null, channelWidthPct: Number(channelWidthPct.toFixed(2)) },
      reason: null,
    };
  }

  // Clearing the channel at all is the event; 1.5% beyond it is emphatic.
  // Tightness scales the result within [0.7, 1.0] rather than gating it, so a
  // decisive break of a wide range still registers.
  const decisiveness = clamp01(penetrationPct / 1.5);
  const score = clamp01((0.45 + 0.55 * decisiveness) * (0.7 + 0.3 * tightness));

  return {
    available: true,
    score,
    detail: {
      direction,
      penetrationPct: Number(penetrationPct.toFixed(2)),
      channelWidthPct: Number(channelWidthPct.toFixed(2)),
      level: direction === 'above' ? high2w : low2w,
    },
    reason:
      direction === 'above'
        ? `Broke above its 2-week high of ${fmtPrice(high2w)}`
        : `Broke below its 2-week low of ${fmtPrice(low2w)}`,
  };
}

/**
 * Divergence from the stock's own sector index.
 *
 * The point is to separate "this stock moved" from "everything moved". A bank
 * down 3% on a day Nifty Bank is down 2.8% is not news; down 3% while the index
 * is up 1% is the single most interesting line on the screen.
 */
function divergenceSignal({ quote, benchmark }) {
  if (!isNum(quote.dayChangePct) || !benchmark || !isNum(benchmark.dayChangePct)) {
    return { available: false };
  }
  const gap = quote.dayChangePct - benchmark.dayChangePct;
  const score = ramp(Math.abs(gap), 1.0, 3.0);
  const label = benchmark.label ?? 'its index';

  return {
    available: true,
    score,
    detail: {
      gapPct: Number(gap.toFixed(2)),
      benchmarkChangePct: Number(benchmark.dayChangePct.toFixed(2)),
      benchmark: label,
    },
    reason:
      Math.abs(gap) >= 1.0
        ? `${fmtPct(quote.dayChangePct)} while ${label} is ${fmtPct(benchmark.dayChangePct)}`
        : `Moving with ${label}`,
  };
}

/** Proximity to the 52-week extremes. Trading beyond one scores full. */
function proximity52wSignal({ quote }) {
  const { price, high52w, low52w } = quote;
  if (!isNum(price) || !isNum(high52w) || !isNum(low52w) || high52w <= 0 || low52w <= 0) {
    return { available: false };
  }
  const distToHighPct = ((high52w - price) / high52w) * 100;
  const distToLowPct = ((price - low52w) / low52w) * 100;
  const nearHigh = distToHighPct <= distToLowPct;
  const distance = nearHigh ? distToHighPct : distToLowPct;

  const score = clamp01((5 - distance) / 5); // <=0% away saturates at 1
  let reason = null;
  if (score > 0) {
    if (distance <= 0) {
      reason = nearHigh ? 'At a new 52-week high' : 'At a new 52-week low';
    } else {
      reason = `Within ${distance.toFixed(1)}% of its 52-week ${nearHigh ? 'high' : 'low'}`;
    }
  }

  return {
    available: true,
    score,
    detail: {
      side: nearHigh ? 'high' : 'low',
      distancePct: Number(distance.toFixed(2)),
      high52w,
      low52w,
    },
    reason,
  };
}

/**
 * The user's own thresholds. This is the only signal that knows anything about
 * this particular person, which is exactly why it is weighted as highly as the
 * market-wide ones: a price the user personally wrote down is a stronger
 * statement of interest than any statistic we can compute.
 */
function personalSignal({ item, view, quote }) {
  const price = quote.price;
  if (!isNum(price)) return { available: false };

  // No thresholds set means we have NO information about this user's intent --
  // which is not the same as "their thresholds were not hit". Returning a zero
  // here would drag 0.20 of dead weight through the weighted average and
  // silently suppress every stock belonging to a user who never sets prices,
  // i.e. almost all of them.
  const hasBuy = isNum(item?.buy_price) && item.buy_price > 0;
  const hasAlert = isNum(item?.alert_price) && item.alert_price > 0;
  if (!hasBuy && !hasAlert) return { available: false };

  const seenPrice = isNum(view?.last_viewed_price) ? view.last_viewed_price : null;
  const results = [];

  if (hasAlert) {
    const alert = item.alert_price;
    // A crossing is a discrete event; being parked near the level is a warning.
    const crossed =
      seenPrice !== null &&
      ((seenPrice < alert && price >= alert) || (seenPrice > alert && price <= alert));
    const distPct = Math.abs((price - alert) / alert) * 100;

    if (crossed) {
      results.push({
        score: 1,
        reason: `Crossed your alert price of ${fmtPrice(alert)}`,
        detail: { kind: 'alert_crossed', alert },
      });
    } else if (seenPrice === null && ((price >= alert && alert > 0) || distPct <= 1)) {
      results.push({
        score: 0.65,
        reason: `Trading at your alert price of ${fmtPrice(alert)}`,
        detail: { kind: 'alert_at', alert },
      });
    } else if (distPct <= 1.5) {
      results.push({
        score: 0.5,
        reason: `Within ${distPct.toFixed(1)}% of your alert price`,
        detail: { kind: 'alert_near', alert, distPct: Number(distPct.toFixed(2)) },
      });
    }
  }

  if (hasBuy) {
    const buy = item.buy_price;
    const pnlPct = ((price - buy) / buy) * 100;
    // Crossing your own cost basis is a genuine state change, in either
    // direction, and it is the moment people actually want to be told.
    const flipped =
      seenPrice !== null &&
      ((seenPrice < buy && price >= buy) || (seenPrice > buy && price <= buy));
    if (flipped) {
      results.push({
        score: 0.75,
        reason:
          price >= buy
            ? `Moved above your buy price of ${fmtPrice(buy)}`
            : `Fell below your buy price of ${fmtPrice(buy)}`,
        detail: { kind: 'buy_crossed', buy, pnlPct: Number(pnlPct.toFixed(2)) },
      });
    }
  }

  if (!results.length) return { available: true, score: 0, reason: null, detail: {} };
  results.sort((a, b) => b.score - a.score);
  return { available: true, ...results[0] };
}

/**
 * Movement measured against the price the user actually last looked at.
 *
 * This is the signal that makes the watchlist stateful rather than a live
 * ticker. Day-change resets at every open; this does not. If you last checked
 * on Friday, "since you checked" spans the weekend gap and the day-change
 * number simply cannot express that.
 */
function driftSignal({ quote, view }) {
  const price = quote.price;
  if (!isNum(price)) return { available: false };

  const seenPrice = isNum(view?.last_viewed_price) ? view.last_viewed_price : null;

  if (seenPrice === null || seenPrice <= 0) {
    // Never seen: fall back to the day move, and say so honestly rather than
    // implying we tracked something we did not.
    if (!isNum(quote.dayChangePct)) return { available: false };
    return {
      available: true,
      isBaseline: true,
      score: ramp(Math.abs(quote.dayChangePct), 1.0, 5.0),
      detail: { basis: 'day', changePct: Number(quote.dayChangePct.toFixed(2)) },
      reason: `${fmtPct(quote.dayChangePct)} today`,
    };
  }

  const changePct = ((price - seenPrice) / seenPrice) * 100;
  return {
    available: true,
    isBaseline: false,
    score: ramp(Math.abs(changePct), 0.75, 5.0),
    detail: {
      basis: 'since_seen',
      changePct: Number(changePct.toFixed(2)),
      fromPrice: seenPrice,
      toPrice: price,
    },
    reason: `${fmtPct(changePct)} since you last checked`,
  };
}

/* ------------------------------------------------------- time amplification */

/**
 * How much to amplify everything based on time away.
 *
 * A 2% move is noise if you refreshed 30 seconds ago and a headline if you have
 * been away since Friday. Applied as a MULTIPLIER rather than an additive term
 * on purpose: elapsed time is not itself evidence that something happened, it
 * changes how much the evidence we do have should weigh. Adding it would let a
 * stock with nothing going on climb the list purely by being ignored.
 *
 * 0 h -> 0.60   6 h -> 1.00   1 day -> ~1.53   3 days+ -> 1.60 (capped)
 */
export function timeAmplifier(hoursSinceSeen) {
  if (!isNum(hoursSinceSeen) || hoursSinceSeen < 0) return 1;
  const raw = 0.6 + 0.4 * Math.log2(1 + hoursSinceSeen / 6);
  return Math.min(1.6, Math.max(0.6, raw));
}

/* --------------------------------------------------------------- the engine */

/**
 * Score one watchlist item.
 *
 * @param {object}  quote      normalised market data (see marketData.toQuote)
 * @param {object=} benchmark  { dayChangePct, label } for the stock's sector index
 * @param {object=} view       row from user_stock_views: what this user last saw
 * @param {object=} item       row from watchlist_items: buy_price / alert_price
 * @param {Date=}   now        injected clock, so tests are deterministic
 */
export function computeSignificance({ quote, benchmark, view, item, userWeights = {}, now = new Date(), marketStatus = 'closed' }) {
  if (!quote || !isNum(quote.price)) {
    return {
      score: 0,
      scorePct: 0,
      significant: false,
      unavailable: true,
      reason: 'Market data unavailable',
      reasons: [],
      signals: {},
      hoursSinceSeen: null,
      isNew: !view,
      timeAmplifier: 1,
      changeSinceSeen: null,
    };
  }

  const signals = {
    breakout: breakoutSignal({ quote }),
    volume: volumeSignal({ quote, now, marketStatus }),
    personal: personalSignal({ item, view, quote }),
    divergence: divergenceSignal({ quote, benchmark }),
    proximity52w: proximity52wSignal({ quote }),
  };
  const drift = driftSignal({ quote, view });

  let driftSalience = drift.isBaseline ? DRIFT_BASELINE_SALIENCE : DRIFT_SALIENCE;
  if (userWeights.drift) {
    driftSalience = Math.max(0, Math.min(1, driftSalience * userWeights.drift));
  }

  const effectiveSalience = { ...SALIENCE };
  for (const [key, val] of Object.entries(userWeights)) {
    if (effectiveSalience[key] !== undefined) {
      effectiveSalience[key] = Math.max(0, Math.min(1, effectiveSalience[key] * val));
    }
  }

  // Noisy-OR. See the SALIENCE comment above for why this is not a mean.
  // Each term is the "this one signal alone is enough" probability; the product
  // of their complements is the chance that nothing is going on.
  let nothingHappening = 1;
  for (const [key, salience] of Object.entries(effectiveSalience)) {
    const sig = signals[key];
    if (!sig?.available) continue;
    nothingHappening *= 1 - salience * sig.score;
  }
  if (drift.available) {
    nothingHappening *= 1 - driftSalience * drift.score;
  }
  const base = 1 - nothingHappening;

  const hoursSinceSeen = view?.last_viewed_at
    ? Math.max(0, (now.getTime() - new Date(view.last_viewed_at).getTime()) / 3_600_000)
    : null;
  const amp = timeAmplifier(hoursSinceSeen);

  // Left deliberately unclamped at the top end. Clamping to 1.0 would flatten
  // the distinction between "notable" and "drop everything", and ordering the
  // top of the list correctly is the entire point of the product.
  const score = base * amp;

  // Rank the firing signals to pick the headline. The user reads one sentence,
  // so it had better be the right one: we rank by contribution to the score,
  // not by raw signal score, so a strong signal with a small weight cannot
  // hijack the headline.
  const ranked = [
    ...Object.entries(signals)
      .filter(([, s]) => s?.available && s.score > 0 && s.reason)
      .map(([key, s]) => ({ key, score: s.score, contribution: s.score * effectiveSalience[key], reason: s.reason })),
    ...(drift.available && drift.score > 0 && drift.reason
      ? [{ key: 'drift', score: drift.score, contribution: drift.score * driftSalience, reason: drift.reason }]
      : []),
  ].sort((a, b) => b.contribution - a.contribution);

  const changeSinceSeen =
    drift.available && drift.detail?.basis === 'since_seen'
      ? {
          changePct: drift.detail.changePct,
          fromPrice: drift.detail.fromPrice,
          toPrice: drift.detail.toPrice,
        }
      : null;

  return {
    score: Number(score.toFixed(4)),
    scorePct: Math.min(100, Math.round(score * 100)),
    significant: score >= SIGNIFICANCE_THRESHOLD,
    unavailable: false,
    reason: ranked[0]?.reason ?? 'No unusual activity',
    // The day-change fallback is allowed to be the headline when it is all we
    // have, but it is dropped from the supporting list: the card already shows
    // today's change in the price block, and repeating it there is noise.
    reasons: ranked
      .filter((r, i) => i === 0 || !(r.key === 'drift' && drift.isBaseline))
      .slice(0, 3)
      .map((r) => ({ key: r.key, reason: r.reason })),
    // Full breakdown, surfaced in the detail panel. A score the user cannot
    // audit is a score they cannot trust.
    signals: {
      ...Object.fromEntries(
        Object.entries(signals).map(([k, s]) => [
          k,
          s.available
            ? { available: true, score: Number(s.score.toFixed(3)), salience: effectiveSalience[k], detail: s.detail ?? {}, reason: s.reason }
            : { available: false },
        ])
      ),
      drift: drift.available
        ? { available: true, score: Number(drift.score.toFixed(3)), salience: driftSalience, detail: drift.detail, reason: drift.reason }
        : { available: false },
    },
    hoursSinceSeen: hoursSinceSeen === null ? null : Number(hoursSinceSeen.toFixed(2)),
    isNew: !view,
    timeAmplifier: Number(amp.toFixed(3)),
    baseScore: Number(base.toFixed(4)),
    changeSinceSeen,
  };
}
