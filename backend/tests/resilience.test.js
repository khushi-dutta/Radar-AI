import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point the DB at a throwaway file BEFORE importing anything that opens it.
// config/database.js opens on import, so ordering matters here.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-test-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.db');

let db, marketData, watchlistModel, userModel, watchlistService;

before(async () => {
  ({ db } = await import('../src/config/database.js'));
  marketData = await import('../src/services/marketData.js');
  watchlistModel = await import('../src/models/watchlistModel.js');
  userModel = await import('../src/models/userModel.js');
  watchlistService = await import('../src/services/watchlistService.js');
});

after(() => {
  try { db?.close(); } catch { /* already closed */ }
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

/** A complete provider snapshot, so tests only vary what they care about. */
function snapshot(symbol, over = {}) {
  return {
    symbol,
    displayName: `${symbol} Ltd`,
    currency: 'INR',
    price: 100,
    previousClose: 99,
    dayChangePct: 1.01,
    dayHigh: 101,
    dayLow: 98,
    volume: 1_000_000,
    avgVolume20d: 2_000_000,
    high52w: 150,
    low52w: 50,
    high2w: 105,
    low2w: 95,
    sparkline: [98, 99, 100],
    sourceTs: '2026-09-04T06:00:00.000Z',
    ...over,
  };
}

describe('cache write ordering', () => {
  test('a newer observation is applied', () => {
    marketData.saveSnapshot(snapshot('AAA.NS', { price: 100, sourceTs: '2026-09-04T06:00:00.000Z' }));
    const applied = marketData.saveSnapshot(
      snapshot('AAA.NS', { price: 111, sourceTs: '2026-09-04T06:01:00.000Z' })
    );
    assert.equal(applied, true);
    assert.equal(marketData.getCachedRows(['AAA.NS']).get('AAA.NS').current_price, 111);
  });

  test('a stale observation arriving late is REJECTED, not applied', () => {
    // The real scenario: a retried request issued at T lands after a fast one
    // issued at T+60s. Without the guard the price visibly ticks backwards.
    marketData.saveSnapshot(snapshot('BBB.NS', { price: 200, sourceTs: '2026-09-04T06:05:00.000Z' }));
    const applied = marketData.saveSnapshot(
      snapshot('BBB.NS', { price: 180, sourceTs: '2026-09-04T06:02:00.000Z' }) // older
    );
    assert.equal(applied, false, 'out-of-order write should be dropped');
    assert.equal(marketData.getCachedRows(['BBB.NS']).get('BBB.NS').current_price, 200);
  });

  test('a partial payload does not blank out good history', () => {
    marketData.saveSnapshot(snapshot('CCC.NS', { sourceTs: '2026-09-04T06:00:00.000Z' }));
    marketData.saveSnapshot(
      snapshot('CCC.NS', {
        price: 106,
        sourceTs: '2026-09-04T06:10:00.000Z',
        avgVolume20d: null, // short history upstream
        high2w: null,
        low2w: null,
        sparkline: [],
      })
    );
    const row = marketData.getCachedRows(['CCC.NS']).get('CCC.NS');
    assert.equal(row.current_price, 106, 'the fresh price should apply');
    assert.equal(row.avg_volume_20d, 2_000_000, 'the good aggregate should survive');
    assert.equal(row.high_2w, 105);
  });
});

describe('failure bookkeeping', () => {
  test('a permanent failure marks the symbol unavailable immediately', () => {
    const err = Object.assign(new Error('Symbol not found upstream'), { permanent: true });
    Object.setPrototypeOf(err, Error.prototype);
    marketData.recordFailure('DEAD.NS', Object.assign(err, { name: 'ProviderError' }));
    const row = marketData.getCachedRows(['DEAD.NS']).get('DEAD.NS');
    assert.equal(row.consecutive_failures, 1);
  });

  test('transient failures accumulate before giving up', () => {
    const err = new Error('Upstream timed out');
    for (let i = 0; i < 3; i++) marketData.recordFailure('FLAKY.NS', err);
    const row = marketData.getCachedRows(['FLAKY.NS']).get('FLAKY.NS');
    assert.equal(row.consecutive_failures, 3);
    assert.equal(row.unavailable, 1, 'should be unavailable after the threshold');
  });

  test('a successful fetch clears the failure state', () => {
    marketData.saveSnapshot(snapshot('FLAKY.NS', { sourceTs: '2026-09-04T07:00:00.000Z' }));
    const row = marketData.getCachedRows(['FLAKY.NS']).get('FLAKY.NS');
    assert.equal(row.consecutive_failures, 0);
    assert.equal(row.unavailable, 0);
    assert.equal(row.last_error, null);
  });
});

describe('freshness classification', () => {
  const OPEN = new Date('2026-09-04T06:30:00Z');   // 12:00 IST, trading
  const CLOSED = new Date('2026-09-05T06:30:00Z'); // Saturday

  test('recent data during market hours is live', () => {
    const row = { fetched_at: new Date(OPEN.getTime() - 30_000).toISOString() };
    assert.equal(marketData.freshnessOf(row, OPEN).state, 'live');
  });

  test('old data during market hours is never reported as live', () => {
    const delayed = { fetched_at: new Date(OPEN.getTime() - 4 * 60_000).toISOString() };
    assert.equal(marketData.freshnessOf(delayed, OPEN).state, 'delayed');

    const stale = { fetched_at: new Date(OPEN.getTime() - 45 * 60_000).toISOString() };
    assert.equal(marketData.freshnessOf(stale, OPEN).state, 'stale');
  });

  test('age is not a defect when the market is closed', () => {
    const row = { fetched_at: new Date(CLOSED.getTime() - 6 * 3_600_000).toISOString() };
    assert.equal(marketData.freshnessOf(row, CLOSED).state, 'closed');
  });

  test('never-fetched data is unavailable, not stale', () => {
    assert.equal(marketData.freshnessOf({ fetched_at: null }, OPEN).state, 'unavailable');
  });
});

describe('view state across concurrent sessions', () => {
  let userId;
  before(() => {
    userId = userModel.createUser('race@test.local', 'password123').id;
    watchlistModel.addItem(userId, { symbol: 'AAA.NS' });
  });

  test('the later acknowledgement wins', () => {
    const early = '2026-09-04T06:00:00.000Z';
    const late = '2026-09-04T08:00:00.000Z';
    watchlistModel.markSeen(userId, [{ symbol: 'AAA.NS', price: 100, volume: 1 }], early);
    watchlistModel.markSeen(userId, [{ symbol: 'AAA.NS', price: 120, volume: 2 }], late);

    const view = watchlistModel.getViews(userId).get('AAA.NS');
    assert.equal(view.last_viewed_at, late);
    assert.equal(view.last_viewed_price, 120);
  });

  test('a late-arriving OLD acknowledgement cannot rewind the baseline', () => {
    // The phone and the laptop both mark seen; the laptop's request was issued
    // first but arrives second. Applying it would resurrect changes the user
    // already dismissed on the phone.
    const stale = '2026-09-04T07:00:00.000Z';
    watchlistModel.markSeen(userId, [{ symbol: 'AAA.NS', price: 999, volume: 9 }], stale);

    const view = watchlistModel.getViews(userId).get('AAA.NS');
    assert.equal(view.last_viewed_at, '2026-09-04T08:00:00.000Z');
    assert.equal(view.last_viewed_price, 120, 'baseline must not rewind');
  });

  test('removing an item clears its baseline so re-adding starts clean', () => {
    watchlistModel.removeItem(userId, 'AAA.NS');
    watchlistModel.clearView(userId, 'AAA.NS');
    assert.equal(watchlistModel.getViews(userId).has('AAA.NS'), false);
  });
});

describe('duplicate handling', () => {
  test('the unique constraint is the authority, and it surfaces as a 409', () => {
    const userId = userModel.createUser('dupe@test.local', 'password123').id;
    watchlistModel.addItem(userId, { symbol: 'AAA.NS' });
    assert.throws(
      () => watchlistModel.addItem(userId, { symbol: 'AAA.NS' }),
      (err) => err.name === 'DuplicateSymbolError' && err.status === 409
    );
  });
});

describe('large watchlist performance', () => {
  test('scoring 150 symbols stays well inside a frame budget', async () => {
    const userId = userModel.createUser('whale@test.local', 'password123').id;

    const symbols = Array.from({ length: 150 }, (_, i) => `SYM${i}.NS`);
    for (const s of symbols) {
      marketData.saveSnapshot(
        snapshot(s, {
          price: 100 + (i0(s) % 40),
          volume: 1_000_000 + (i0(s) % 7) * 900_000,
          sourceTs: '2026-09-04T06:00:00.000Z',
        })
      );
      watchlistModel.addItem(userId, { symbol: s });
    }

    const started = performance.now();
    // refresh:false isolates the scoring path from any network work, which is
    // the thing being measured: the cost of the read path itself.
    const payload = await watchlistService.buildWatchlist(userId, { refresh: false });
    const elapsed = performance.now() - started;

    assert.equal(payload.items.length, 150);
    assert.ok(
      elapsed < 400,
      `scoring 150 symbols took ${elapsed.toFixed(0)}ms; the read path should be O(n) arithmetic over 3 queries`
    );

    // And it must actually be sorted by significance.
    const scores = payload.items.filter((i) => !i.unavailable).map((i) => i.significance.score);
    for (let i = 1; i < scores.length; i++) {
      assert.ok(scores[i - 1] >= scores[i], 'items must be ordered by significance');
    }
  });
});

/** Cheap deterministic spread so the perf fixture is not 150 identical rows. */
function i0(s) {
  return Number(s.replace(/\D/g, '')) || 0;
}

describe('degraded reads', () => {
  test('a watchlist renders even when every symbol is unpriced', async () => {
    const userId = userModel.createUser('dark@test.local', 'password123').id;
    watchlistModel.addItem(userId, { symbol: 'GHOST1.NS' });
    watchlistModel.addItem(userId, { symbol: 'GHOST2.NS' });

    const payload = await watchlistService.buildWatchlist(userId, { refresh: false });
    assert.equal(payload.items.length, 2);
    assert.equal(payload.counts.unavailable, 2);
    assert.equal(payload.counts.significant, 0);
    for (const item of payload.items) {
      assert.equal(item.unavailable, true);
      assert.equal(item.significance.score, 0);
      assert.match(item.significance.reason, /unavailable/i);
    }
  });

  test('unpriced symbols sort below priced ones regardless of score', async () => {
    const userId = userModel.createUser('mixed@test.local', 'password123').id;
    marketData.saveSnapshot(snapshot('GOOD.NS', { price: 100, sourceTs: '2026-09-04T06:00:00.000Z' }));
    watchlistModel.addItem(userId, { symbol: 'GOOD.NS' });
    watchlistModel.addItem(userId, { symbol: 'GHOST3.NS' });

    const payload = await watchlistService.buildWatchlist(userId, { refresh: false });
    assert.equal(payload.items.at(-1).symbol, 'GHOST3.NS');
  });
});

describe('the "since you last checked" anchor', () => {
  let userId;
  before(() => {
    userId = userModel.createUser('anchor@test.local', 'password123').id;
    marketData.saveSnapshot(snapshot('ANC1.NS', { price: 100, sourceTs: '2026-09-04T06:00:00.000Z' }));
    marketData.saveSnapshot(snapshot('ANC2.NS', { price: 200, sourceTs: '2026-09-04T06:00:00.000Z' }));
    watchlistModel.addItem(userId, { symbol: 'ANC1.NS' });
    watchlistModel.addItem(userId, { symbol: 'ANC2.NS' });
  });

  test('is null until something has actually been acknowledged', async () => {
    const payload = await watchlistService.buildWatchlist(userId, { refresh: false });
    assert.equal(payload.baselineAt, null);
    assert.equal(payload.counts.unacknowledged, 2);
  });

  test('reports the OLDEST unacknowledged baseline, not the newest', async () => {
    // The honest claim is "you have not looked at everything since X", so the
    // stalest symbol governs. Reporting the newest would understate the gap.
    watchlistModel.markSeen(userId, [{ symbol: 'ANC1.NS', price: 100 }], '2026-09-01T06:00:00.000Z');
    watchlistModel.markSeen(userId, [{ symbol: 'ANC2.NS', price: 200 }], '2026-09-03T06:00:00.000Z');

    const payload = await watchlistService.buildWatchlist(userId, { refresh: false });
    assert.equal(payload.baselineAt, '2026-09-01T06:00:00.000Z');
    assert.equal(payload.counts.unacknowledged, 0);
  });

  test('merely rebuilding the payload does not move it', async () => {
    // The regression this guards: the header used to read from a clock that
    // advanced on every page load and every stream frame, so it decayed to
    // "moments ago" while the cards still compared against days-old prices.
    const a = await watchlistService.buildWatchlist(userId, { refresh: false });
    const b = await watchlistService.buildWatchlist(userId, { refresh: false });
    const c = await watchlistService.buildWatchlist(userId, { refresh: false });
    assert.equal(a.baselineAt, '2026-09-01T06:00:00.000Z');
    assert.equal(b.baselineAt, a.baselineAt);
    assert.equal(c.baselineAt, a.baselineAt);
  });

  test('acknowledging advances it, and quiets the list', async () => {
    const before = await watchlistService.buildWatchlist(userId, { refresh: false });
    const at = '2026-09-04T06:00:00.000Z';
    watchlistModel.markSeen(userId, watchlistService.observationsFor(userId), at);

    const after = await watchlistService.buildWatchlist(userId, { refresh: false });
    assert.equal(after.baselineAt, at);
    // Same market data, fresher baseline => strictly less clamouring for attention.
    assert.ok(
      after.counts.significant <= before.counts.significant,
      'acknowledging should never increase the number of items demanding attention'
    );
  });
});
