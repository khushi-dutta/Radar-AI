import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import authRoutes from './routes/auth.js';
import watchlistRoutes from './routes/watchlist.js';
import marketRoutes from './routes/market.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { worker } from './services/backgroundWorker.js';
import { db } from './config/database.js';

const app = express();
const PORT = Number(process.env.PORT ?? 4000);

app.set('trust proxy', 1);
app.use(cors({ origin: process.env.CORS_ORIGIN ?? true, credentials: true }));
app.use(express.json({ limit: '64kb' }));

/**
 * Minimal in-process rate limit.
 *
 * Not a substitute for an edge limiter, and does not survive a restart or span
 * instances -- but it bounds the damage from a runaway client or a stuck retry
 * loop, which is the failure this actually needs to stop. A real deployment
 * would move this to the gateway; saying so is more honest than pretending a
 * Map is a rate-limiting tier.
 */
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 300;
const hits = new Map();

app.use((req, res, next) => {
  // SSE holds one long-lived connection; counting it would be meaningless.
  if (req.path.startsWith('/api/stream')) return next();

  const key = req.ip ?? 'unknown';
  const now = Date.now();
  const entry = hits.get(key);

  if (!entry || now > entry.resetAt) {
    hits.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return next();
  }
  if (++entry.count > MAX_REQUESTS) {
    res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
    return res.status(429).json({ error: { message: 'Too many requests, slow down', code: 'RateLimited' } });
  }
  next();
});

// Bound the map so it cannot grow without limit across many client IPs.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of hits) if (now > entry.resetAt) hits.delete(key);
}, WINDOW_MS).unref();

app.get('/api/health', (req, res) => {
  res.json({ ok: true, worker: worker.health(), uptimeSeconds: Math.round(process.uptime()) });
});

app.use('/api/auth', authRoutes);
app.use('/api/watchlist', watchlistRoutes);
app.use('/api', marketRoutes);

app.use(notFound);
app.use(errorHandler);

const server = app.listen(PORT, () => {
  console.log(`[api] listening on http://localhost:${PORT}`);
  worker.start();
});

/**
 * Graceful shutdown: stop the refresh loop, drain connections, then close the
 * database so SQLite checkpoints its WAL instead of leaving one behind.
 */
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[api] ${signal} received, shutting down`);
    worker.stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    // Do not hang forever on a client that will not disconnect (e.g. SSE).
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

process.on('unhandledRejection', (reason) => {
  console.error('[api] unhandled rejection', reason);
});

export default app;
