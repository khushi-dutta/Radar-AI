import { EventEmitter } from 'node:events';
import {
  allWatchedSymbols,
  refreshSymbols,
  refreshBenchmarks,
} from './marketData.js';
import { refreshIntervalMs, isMarketOpen, marketStatus } from '../utils/marketHours.js';

/**
 * The single writer of market data.
 *
 * The central scaling decision in this project: prices are fetched once per
 * symbol per tick for the WHOLE system, not once per user request. Upstream
 * load is therefore a function of how many distinct symbols anyone watches --
 * not of user count, request rate, or watchlist size. Ten thousand users all
 * watching RELIANCE cost exactly one request per minute.
 *
 * It also degrades rather than dies: repeated upstream failure widens the
 * interval instead of retrying into a rate limit, and every consumer keeps
 * reading the last good cache with an honest staleness label.
 */
class RefreshWorker extends EventEmitter {
  constructor() {
    super();
    this.timer = null;
    this.running = false;
    this.ticking = false;
    this.backoffMultiplier = 1;
    this.stats = {
      lastTickAt: null,
      lastSuccessAt: null,
      lastDurationMs: null,
      symbolsTracked: 0,
      consecutiveFailedTicks: 0,
      totalTicks: 0,
      degraded: false,
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    // Fire immediately so a cold start is not blank for a full interval.
    this.scheduleNext(0);
    console.log('[worker] started');
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    console.log('[worker] stopped');
  }

  scheduleNext(delayMs) {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    const delay = delayMs ?? refreshIntervalMs() * this.backoffMultiplier;
    this.timer = setTimeout(() => this.tick(), delay);
    // Never let the refresh loop hold the process open on shutdown.
    this.timer.unref?.();
  }

  async tick() {
    // setTimeout can overlap a slow tick with the next one; a single guard is
    // simpler and safer than trying to cancel in-flight work.
    if (this.ticking) return this.scheduleNext();
    this.ticking = true;

    const startedAt = Date.now();
    this.stats.lastTickAt = new Date().toISOString();
    this.stats.totalTicks++;

    try {
      const symbols = allWatchedSymbols();
      this.stats.symbolsTracked = symbols.length;

      // Benchmarks first: the divergence signal is meaningless if a stock's
      // price is current but the index it is compared against is not.
      const [benchResults, quoteResults] = await Promise.all([
        refreshBenchmarks(),
        symbols.length ? refreshSymbols(symbols) : Promise.resolve([]),
      ]);

      const all = [...benchResults, ...quoteResults];
      const failed = all.filter((r) => !r.ok);
      const failureRate = all.length ? failed.length / all.length : 0;

      if (all.length && failureRate > 0.5) {
        // Widespread failure means upstream is unhappy with us. Backing off is
        // the cooperative response; retrying harder gets us rate-limited for
        // longer and helps nobody.
        this.stats.consecutiveFailedTicks++;
        this.backoffMultiplier = Math.min(8, this.backoffMultiplier * 2);
        this.stats.degraded = true;
        console.warn(
          `[worker] ${failed.length}/${all.length} refreshes failed; backing off to ${this.backoffMultiplier}x`
        );
      } else {
        this.stats.consecutiveFailedTicks = 0;
        this.backoffMultiplier = 1;
        this.stats.degraded = false;
        this.stats.lastSuccessAt = new Date().toISOString();
      }

      this.stats.lastDurationMs = Date.now() - startedAt;

      this.emit('refreshed', {
        at: new Date().toISOString(),
        symbols: quoteResults.filter((r) => r.ok).map((r) => r.symbol),
        failed: failed.map((r) => r.symbol),
        marketStatus: marketStatus(),
      });
      
      // Evaluate alerts asynchronously to avoid blocking the tick
      setImmediate(() => {
        import('./alertEngine.js').then(({ evaluateAlerts }) => {
          evaluateAlerts().catch(err => console.error('[worker] alert evaluation failed', err));
        });
      });
    } catch (err) {
      // A thrown tick must never kill the loop.
      this.stats.consecutiveFailedTicks++;
      this.backoffMultiplier = Math.min(8, this.backoffMultiplier * 2);
      this.stats.degraded = true;
      console.error('[worker] tick failed', err);
    } finally {
      this.ticking = false;
      this.scheduleNext();
    }
  }

  health() {
    return {
      ...this.stats,
      running: this.running,
      backoffMultiplier: this.backoffMultiplier,
      intervalMs: refreshIntervalMs() * this.backoffMultiplier,
      marketOpen: isMarketOpen(),
    };
  }
}

export const worker = new RefreshWorker();
