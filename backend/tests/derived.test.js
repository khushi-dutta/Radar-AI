/**
 * Tests for the derived views layered on top of the significance engine:
 * correlation divergence, alert rules, and the list-level radar score.
 *
 * These exist because each one makes a CLAIM to the user in plain English
 * ("these two normally move together", "volume spiked", "your list is busy").
 * A claim that is only sometimes true is worse than no claim, so the tests here
 * are mostly about the conditions under which each one must stay silent.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { pearsonCorrelation, findDivergingCorrelations } from '../src/utils/math.js';
import { evaluateRule } from '../src/services/alertEngine.js';

const MID_SESSION = new Date('2026-09-04T06:30:00Z'); // 12:00 IST, ~44% of session elapsed
const WEEKEND = new Date('2026-09-05T06:30:00Z');     // Saturday: full session's volume

/** Prices from a fixed seed, so failures are reproducible. */
function walk(start, steps, seed = 1, drift = 0) {
  const out = [start];
  let s = seed;
  for (let i = 0; i < steps; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const shock = (s / 2147483648 - 0.5) * 2; // -1 .. 1
    out.push(out[out.length - 1] * (1 + drift + shock * 0.01));
  }
  return out;
}

function item(symbol, sparkline, dayChangePct, over = {}) {
  return { symbol, sparkline, dayChangePct, unavailable: false, significance: { score: 0.5 }, ...over };
}

describe('pearson correlation', () => {
  test('is null, not zero, when it is undefined', () => {
    // A flat series has no variance, so there is nothing to correlate against.
    // Returning 0 would assert "these are uncorrelated", which is a real claim
    // we have no basis for.
    assert.equal(pearsonCorrelation([1, 1, 1, 1], [1, 2, 3, 4]), null);
    assert.equal(pearsonCorrelation([1, 2, 3], [1, 2]), null);
    assert.equal(pearsonCorrelation([], []), null);
    assert.equal(pearsonCorrelation([1, 2, Number.NaN], [1, 2, 3]), null);
  });

  test('detects a perfect linear relationship', () => {
    assert.ok(pearsonCorrelation([1, 2, 3, 4], [2, 4, 6, 8]) > 0.999);
    assert.ok(pearsonCorrelation([1, 2, 3, 4], [8, 6, 4, 2]) < -0.999);
  });
});

describe('diverging correlations', () => {
  test('two independent uptrends are NOT reported as correlated', () => {
    // The regression this file exists for. Both series drift up ~0.4%/step from
    // different random shocks; correlating raw PRICE LEVELS gives ~0.99 because
    // they share a trend, and every pair in a rising market would be flagged.
    // On returns the shared trend is a constant and the coefficient collapses.
    const a = walk(100, 60, 7, 0.004);
    const b = walk(250, 60, 991, 0.004);

    assert.ok(pearsonCorrelation(a, b) > 0.9, 'price levels are spuriously correlated');

    const pairs = findDivergingCorrelations([item('A', a, 3.0), item('B', b, -1.0)]);
    assert.equal(pairs.length, 0, 'returns must not inherit the trend');
  });

  test('genuinely co-moving stocks that split today are reported', () => {
    const a = walk(100, 60, 42);
    // b tracks a's shape exactly (perfectly correlated returns) at a different level.
    const b = a.map((p) => p * 3.4);

    const pairs = findDivergingCorrelations([item('A', a, 2.5), item('B', b, -1.2)]);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].correlation, 1);
    assert.equal(pairs[0].divergence, 3.7);
  });

  test('co-moving stocks that move together today are not news', () => {
    const a = walk(100, 60, 42);
    const b = a.map((p) => p * 3.4);
    assert.equal(findDivergingCorrelations([item('A', a, 2.5), item('B', b, 2.4)]).length, 0);
  });

  test('mismatched history lengths compare the overlapping tail', () => {
    const a = walk(100, 60, 5);
    const b = a.slice(-25).map((p) => p * 2); // newly listed: shorter history
    const pairs = findDivergingCorrelations([item('A', a, 3.0), item('B', b, 0.0)]);
    assert.equal(pairs.length, 1, 'a shorter series must still be comparable');
    assert.equal(pairs[0].correlation, 1);
  });

  test('too little history is skipped rather than guessed at', () => {
    const a = walk(100, 8, 3);
    const b = a.map((p) => p * 2);
    assert.equal(findDivergingCorrelations([item('A', a, 3.0), item('B', b, 0.0)]).length, 0);
  });

  test('unavailable rows never appear in a pair', () => {
    const a = walk(100, 60, 42);
    const b = a.map((p) => p * 3.4);
    const pairs = findDivergingCorrelations([
      item('A', a, 2.5),
      item('B', b, -1.2, { unavailable: true }),
    ]);
    assert.equal(pairs.length, 0);
  });

  test('widest divergence is ranked first', () => {
    const a = walk(100, 60, 42);
    const b = a.map((p) => p * 2);
    const c = a.map((p) => p * 5);
    const pairs = findDivergingCorrelations([item('A', a, 4.0), item('B', b, 0.0), item('C', c, -3.0)]);
    assert.ok(pairs.length >= 2);
    assert.ok(pairs[0].divergence >= pairs[1].divergence);
  });
});

describe('alert rules', () => {
  const volumeRule = { symbol: 'X', rule_type: 'volume_spike', threshold: 3 };

  test('volume spike is measured against the session-adjusted expectation', () => {
    // The whole point of the fix: at 12:00 IST only ~44% of the session has
    // elapsed, so 1.5M against a 1M full-day average is already a ~3.4x pace.
    // The naive full-day ratio reads 1.5x and stays silent through the spike.
    const quote = { price: 100, volume: 1_500_000, avgVolume20d: 1_000_000 };
    const msg = evaluateRule(volumeRule, quote, MID_SESSION);
    assert.ok(msg, 'should fire on a mid-session pace of ~3.4x');
    assert.match(msg, /3\.4x/);
  });

  test('the same numbers do NOT fire once the session is complete', () => {
    // Identical inputs, different point in the day: after the close 1.5M
    // against a 1M average really is only 1.5x, and must not fire a 3x rule.
    const quote = { price: 100, volume: 1_500_000, avgVolume20d: 1_000_000 };
    assert.equal(evaluateRule(volumeRule, quote, WEEKEND), null);
  });

  test('missing inputs produce silence, not a false negative claim', () => {
    assert.equal(evaluateRule(volumeRule, { price: 100, volume: null, avgVolume20d: 1e6 }, MID_SESSION), null);
    assert.equal(evaluateRule(volumeRule, { price: 100, volume: 1e6, avgVolume20d: 0 }, MID_SESSION), null);
    assert.equal(evaluateRule(volumeRule, null, MID_SESSION), null);
  });

  test('proximity rule fires inside the band and reports a new high distinctly', () => {
    const rule = { symbol: 'X', rule_type: 'price_proximity', threshold: 0.02 };
    assert.equal(evaluateRule(rule, { price: 90, high52w: 100 }, MID_SESSION), null);
    assert.match(evaluateRule(rule, { price: 99, high52w: 100 }, MID_SESSION), /within 1\.0%/i);
    assert.match(evaluateRule(rule, { price: 101, high52w: 100 }, MID_SESSION), /new 52-week high/i);
  });

  test('an unknown rule type is ignored rather than throwing', () => {
    assert.equal(evaluateRule({ symbol: 'X', rule_type: 'nonsense', threshold: 1 }, { price: 100 }, MID_SESSION), null);
  });
});
