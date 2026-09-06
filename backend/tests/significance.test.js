import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeSignificance,
  timeAmplifier,
  SIGNIFICANCE_THRESHOLD,
} from '../src/services/significance.js';
import {
  marketStatus,
  sessionElapsedFraction,
  isTradingDay,
} from '../src/utils/marketHours.js';

// Fixed clocks. 2026-09-04 is a Friday, 2026-09-05 a Saturday.
const MID_SESSION = new Date('2026-09-04T06:30:00Z'); // 12:00 IST, ~44% elapsed
const JUST_OPENED = new Date('2026-09-04T03:50:00Z'); // 09:20 IST
const WEEKEND = new Date('2026-09-05T06:30:00Z');     // Saturday

/** A deliberately unremarkable stock; tests perturb one field at a time. */
function baseQuote(over = {}) {
  return {
    price: 100,
    previousClose: 100,
    dayChangePct: 0,
    volume: 1_000_000,
    avgVolume20d: 2_000_000,
    high52w: 150,
    low52w: 50,
    high2w: 105,
    low2w: 95,
    ...over,
  };
}

const run = (args) =>
  computeSignificance({ marketStatus: 'open', now: MID_SESSION, ...args });

describe('market hours', () => {
  test('IST session boundaries', () => {
    assert.equal(marketStatus(new Date('2026-09-04T03:44:00Z')), 'pre_open'); // 09:14
    assert.equal(marketStatus(new Date('2026-09-04T03:45:00Z')), 'open');     // 09:15
    assert.equal(marketStatus(new Date('2026-09-04T09:59:00Z')), 'open');     // 15:29
    assert.equal(marketStatus(new Date('2026-09-04T10:00:00Z')), 'closed');   // 15:30
  });

  test('weekends and holidays are not trading days', () => {
    assert.equal(isTradingDay(WEEKEND), false);
    assert.equal(marketStatus(WEEKEND), 'closed');
    assert.equal(isTradingDay(new Date('2026-08-15T06:00:00Z')), false); // Independence Day
  });

  test('session fraction rises through the day and is floored early', () => {
    // Without the floor, opening-auction volume would read as a huge anomaly.
    assert.ok(sessionElapsedFraction(JUST_OPENED) >= 0.08);
    assert.ok(sessionElapsedFraction(MID_SESSION) > sessionElapsedFraction(JUST_OPENED));
    assert.equal(sessionElapsedFraction(WEEKEND), 1); // closed => full session
  });
});

describe('volume signal', () => {
  test('is time-adjusted: the same raw volume means different things', () => {
    // 1.2M shares by 09:20 is a lot; by 12:00 it is ordinary.
    const early = computeSignificance({
      quote: baseQuote({ volume: 1_200_000 }),
      now: JUST_OPENED,
      marketStatus: 'open',
    });
    const later = computeSignificance({
      quote: baseQuote({ volume: 1_200_000 }),
      now: MID_SESSION,
      marketStatus: 'open',
    });
    assert.ok(
      early.signals.volume.detail.ratio > later.signals.volume.detail.ratio,
      'earlier in the session should imply a higher pace ratio'
    );
    assert.ok(early.signals.volume.score > later.signals.volume.score);
  });

  test('a genuine spike scores near the top', () => {
    // ~44% of the session elapsed => expected ~880k. 3.5M is ~4x pace.
    const r = run({ quote: baseQuote({ volume: 3_500_000 }) });
    assert.ok(r.signals.volume.score > 0.9, `got ${r.signals.volume.score}`);
    assert.match(r.reason, /Volume/);
  });

  test('is unavailable, not zero, when there is no baseline', () => {
    const r = run({ quote: baseQuote({ avgVolume20d: null }) });
    assert.equal(r.signals.volume.available, false);
  });
});

describe('breakout signal', () => {
  test('does not fire inside the channel', () => {
    const r = run({ quote: baseQuote({ price: 100 }) });
    assert.equal(r.signals.breakout.score, 0);
  });

  test('fires above the 2-week high', () => {
    const r = run({ quote: baseQuote({ price: 106 }) });
    assert.ok(r.signals.breakout.score > 0.4);
    assert.equal(r.signals.breakout.detail.direction, 'above');
    assert.match(r.signals.breakout.reason, /Broke above/);
  });

  test('fires below the 2-week low', () => {
    const r = run({ quote: baseQuote({ price: 93 }) });
    assert.equal(r.signals.breakout.detail.direction, 'below');
    assert.match(r.signals.breakout.reason, /Broke below/);
  });

  test('a tight range scores higher than a wide one for the same break', () => {
    // Both break out by the same 1%, but one range was coiled and one was chop.
    const tight = run({ quote: baseQuote({ price: 101, high2w: 100, low2w: 98 }) });
    const wide = run({ quote: baseQuote({ price: 101, high2w: 100, low2w: 70 }) });
    assert.ok(
      tight.signals.breakout.score > wide.signals.breakout.score,
      'breaking a tight coil should outrank breaking a wide range'
    );
  });
});

describe('divergence signal', () => {
  test('moving with the sector is not interesting', () => {
    const r = run({
      quote: baseQuote({ dayChangePct: -3 }),
      benchmark: { dayChangePct: -2.9, label: 'Nifty Bank' },
    });
    assert.equal(r.signals.divergence.score, 0);
  });

  test('moving against the sector is', () => {
    const r = run({
      quote: baseQuote({ dayChangePct: -3 }),
      benchmark: { dayChangePct: 1.2, label: 'Nifty Bank' },
    });
    assert.ok(r.signals.divergence.score > 0.9);
    assert.match(r.signals.divergence.reason, /Nifty Bank/);
  });

  test('is unavailable without a benchmark', () => {
    const r = run({ quote: baseQuote({ dayChangePct: -3 }) });
    assert.equal(r.signals.divergence.available, false);
  });
});

describe('52-week proximity', () => {
  test('mid-range scores zero', () => {
    const r = run({ quote: baseQuote({ price: 100 }) });
    assert.equal(r.signals.proximity52w.score, 0);
  });

  test('near the high scores, and a new high saturates', () => {
    const near = run({ quote: baseQuote({ price: 147 }) });
    assert.ok(near.signals.proximity52w.score > 0);
    const beyond = run({ quote: baseQuote({ price: 155 }) });
    assert.equal(beyond.signals.proximity52w.score, 1);
    assert.match(beyond.signals.proximity52w.reason, /new 52-week high/);
  });

  test('near the low is equally noteworthy', () => {
    const r = run({ quote: baseQuote({ price: 51 }) });
    assert.ok(r.signals.proximity52w.score > 0);
    assert.equal(r.signals.proximity52w.detail.side, 'low');
  });
});

describe('drift since last seen', () => {
  const seenAt = new Date(MID_SESSION.getTime() - 3 * 3_600_000).toISOString();

  test('measures against the price the user actually saw, not the open', () => {
    const r = run({
      quote: baseQuote({ price: 104, dayChangePct: 0.1 }),
      view: { last_viewed_at: seenAt, last_viewed_price: 100 },
    });
    assert.equal(r.changeSinceSeen.changePct, 4);
    assert.equal(r.signals.drift.detail.basis, 'since_seen');
  });

  test('falls back to the day move for a never-seen stock, and says so', () => {
    const r = run({ quote: baseQuote({ price: 104, dayChangePct: 4 }) });
    assert.equal(r.isNew, true);
    assert.equal(r.signals.drift.detail.basis, 'day');
    assert.match(r.signals.drift.reason, /today/);
    assert.equal(r.changeSinceSeen, null);
  });
});

describe('personal thresholds', () => {
  const seenAt = new Date(MID_SESSION.getTime() - 3_600_000).toISOString();

  test('crossing an alert price is a discrete event', () => {
    const r = run({
      quote: baseQuote({ price: 121 }),
      item: { alert_price: 120 },
      view: { last_viewed_at: seenAt, last_viewed_price: 118 },
    });
    assert.equal(r.signals.personal.score, 1);
    assert.match(r.reason, /alert price/);
  });

  test('sitting still on the far side of an alert is not a fresh event', () => {
    const r = run({
      quote: baseQuote({ price: 121 }),
      item: { alert_price: 120 },
      view: { last_viewed_at: seenAt, last_viewed_price: 121 },
    });
    assert.ok(r.signals.personal.score < 1);
  });

  test('crossing your cost basis registers in both directions', () => {
    const up = run({
      quote: baseQuote({ price: 101 }),
      item: { buy_price: 100 },
      view: { last_viewed_at: seenAt, last_viewed_price: 98 },
    });
    assert.match(up.signals.personal.reason, /above your buy price/);

    const down = run({
      quote: baseQuote({ price: 99 }),
      item: { buy_price: 100 },
      view: { last_viewed_at: seenAt, last_viewed_price: 102 },
    });
    assert.match(down.signals.personal.reason, /below your buy price/);
  });
});

describe('time amplification', () => {
  test('is monotonic in time away and bounded', () => {
    assert.ok(timeAmplifier(0) < timeAmplifier(6));
    assert.ok(timeAmplifier(6) < timeAmplifier(24));
    assert.ok(timeAmplifier(24) <= timeAmplifier(72));
    assert.equal(timeAmplifier(0), 0.6);
    assert.equal(timeAmplifier(10_000), 1.6); // capped
    assert.equal(timeAmplifier(null), 1);     // never seen => neutral
  });

  test('the same move ranks higher after days away than after seconds', () => {
    const quote = baseQuote({ price: 103, dayChangePct: 3 });
    const justLooked = run({
      quote,
      view: { last_viewed_at: new Date(MID_SESSION.getTime() - 60_000).toISOString(), last_viewed_price: 100 },
    });
    const awayForDays = run({
      quote,
      view: { last_viewed_at: new Date(MID_SESSION.getTime() - 72 * 3_600_000).toISOString(), last_viewed_price: 100 },
    });
    assert.ok(
      awayForDays.score > justLooked.score,
      `${awayForDays.score} should exceed ${justLooked.score}`
    );
  });
});

describe('scoring integrity', () => {
  test('a quiet stock stays below the surfacing threshold', () => {
    const r = run({
      quote: baseQuote({ price: 100.2, dayChangePct: 0.2, volume: 850_000 }),
      benchmark: { dayChangePct: 0.3, label: 'Nifty 50' },
      view: { last_viewed_at: new Date(MID_SESSION.getTime() - 3_600_000).toISOString(), last_viewed_price: 100 },
    });
    assert.equal(r.significant, false);
    assert.ok(r.score < SIGNIFICANCE_THRESHOLD);
  });

  test('a stock firing several signals clears it comfortably', () => {
    const r = run({
      quote: baseQuote({ price: 148, dayChangePct: -4, volume: 3_500_000 }),
      benchmark: { dayChangePct: 1.5, label: 'Nifty IT' },
      view: { last_viewed_at: new Date(MID_SESSION.getTime() - 30 * 3_600_000).toISOString(), last_viewed_price: 130 },
    });
    assert.equal(r.significant, true);
    assert.ok(r.score > 0.6, `got ${r.score}`);
  });

  test('unavailable signals do not dilute the ones that fired', () => {
    // Identical breakout; the second quote simply lacks volume history.
    const withVol = run({ quote: baseQuote({ price: 108, volume: 900_000 }) });
    const withoutVol = run({ quote: baseQuote({ price: 108, avgVolume20d: null, volume: null }) });
    assert.equal(withoutVol.signals.volume.available, false);
    assert.ok(
      withoutVol.score >= withVol.score,
      'dropping an unavailable signal must renormalise, not penalise'
    );
  });

  test('a missing quote degrades instead of throwing', () => {
    const r = computeSignificance({ quote: null, now: MID_SESSION });
    assert.equal(r.unavailable, true);
    assert.equal(r.score, 0);
    assert.equal(r.significant, false);
    assert.match(r.reason, /unavailable/i);
  });

  test('the headline reason is the top contributor, not the top raw score', () => {
    // Proximity saturates at 1.0 but carries the smallest weight; drift at a
    // lower raw score carries more weight and should own the headline.
    const r = run({
      quote: baseQuote({ price: 155, dayChangePct: 0.1 }),
      view: { last_viewed_at: new Date(MID_SESSION.getTime() - 3_600_000).toISOString(), last_viewed_price: 100 },
    });
    assert.equal(r.signals.proximity52w.score, 1);
    assert.match(r.reason, /since you last checked/);
  });
});

describe('aggregation (noisy-OR)', () => {
  test('one decisive signal alone is enough to surface a stock', () => {
    // The failure a weighted mean produced: a clean breakout, everything else
    // quiet, averaged down to ~0.29 and suppressed. It must now clear the bar.
    const r = run({
      quote: baseQuote({ price: 106, dayChangePct: 2.0, volume: 900_000 }),
      benchmark: { dayChangePct: 2.1, label: 'Nifty 50' }, // no divergence
    });
    assert.ok(r.signals.breakout.score > 0.5);
    assert.equal(r.signals.divergence.score, 0);
    assert.equal(r.signals.proximity52w.score, 0);
    assert.ok(r.significant, `single strong signal scored only ${r.score}`);
  });

  test('quiet signals never drag the score down', () => {
    // Same breakout, but the second quote also has calm volume and a benchmark
    // it is tracking. Extra *quiet* evidence must not reduce significance.
    const alone = run({ quote: baseQuote({ price: 106, volume: null, avgVolume20d: null }) });
    const withQuietPeers = run({
      quote: baseQuote({ price: 106, volume: 800_000, dayChangePct: 1.0 }),
      benchmark: { dayChangePct: 1.0, label: 'Nifty 50' },
    });
    assert.ok(
      withQuietPeers.score >= alone.score - 1e-9,
      `${withQuietPeers.score} must not fall below ${alone.score}`
    );
  });

  test('multiple firing signals compound above any single one', () => {
    const onlyBreakout = run({ quote: baseQuote({ price: 106 }) });
    const breakoutPlusDivergence = run({
      quote: baseQuote({ price: 106, dayChangePct: 3.5 }),
      benchmark: { dayChangePct: -0.5, label: 'Nifty 50' },
    });
    assert.ok(breakoutPlusDivergence.score > onlyBreakout.score);
  });

  test('score stays bounded even when everything fires at once', () => {
    const r = run({
      quote: baseQuote({ price: 160, dayChangePct: -9, volume: 9_000_000 }),
      benchmark: { dayChangePct: 4, label: 'Nifty 50' },
      item: { alert_price: 150, buy_price: 140 },
      view: {
        last_viewed_at: new Date(MID_SESSION.getTime() - 96 * 3_600_000).toISOString(),
        last_viewed_price: 100,
      },
    });
    // base is a probability in [0,1); the amplifier may lift it to at most 1.6.
    assert.ok(r.baseScore < 1, `base ${r.baseScore} must stay below 1`);
    assert.ok(r.score <= 1.6 + 1e-9);
    assert.equal(r.scorePct, 100); // display saturates, ordering does not
  });

  test('a totally quiet stock scores zero, not epsilon', () => {
    const r = run({
      quote: baseQuote({ price: 100, dayChangePct: 0, volume: 800_000 }),
      benchmark: { dayChangePct: 0, label: 'Nifty 50' },
    });
    assert.equal(r.baseScore, 0);
    assert.equal(r.significant, false);
  });
});
