/**
 * Central error translation.
 *
 * Two rules: every error leaves as JSON with a stable `error` shape, and
 * unexpected errors never leak internals to the client while still being fully
 * logged server-side.
 */
export function errorHandler(err, req, res, _next) {
  const status = err.status ?? 500;

  if (status >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  }

  res.status(status).json({
    error: {
      message: status >= 500 ? 'Something went wrong on our side' : err.message,
      code: err.name ?? 'Error',
      ...(err.field ? { field: err.field } : {}),
    },
  });
}

export function notFound(req, res) {
  res.status(404).json({ error: { message: `No route for ${req.method} ${req.originalUrl}`, code: 'NotFound' } });
}

/** Wrap async handlers so a rejected promise reaches errorHandler. */
export const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
