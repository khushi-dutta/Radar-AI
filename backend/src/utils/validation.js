/** Input validation. Everything crossing the HTTP boundary passes through here. */

export class ValidationError extends Error {
  constructor(message, field = null) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
    this.field = field;
  }
}

// NSE tickers are alphanumerics plus a small set of punctuation (M&M, BAJAJ-AUTO,
// and index symbols such as ^NSEI). Anything else is not a symbol we will ever
// send upstream, so it is rejected here rather than URL-encoded and hoped for.
const SYMBOL_BODY = /^[A-Z0-9][A-Z0-9&._-]{0,19}$/;

/**
 * Normalise user input into a canonical exchange symbol.
 * Bare tickers get the NSE suffix, since this product is India-first.
 */
export function normalizeSymbol(input) {
  if (typeof input !== 'string') throw new ValidationError('Symbol is required', 'symbol');
  let s = input.trim().toUpperCase();
  if (!s) throw new ValidationError('Symbol is required', 'symbol');
  if (s.length > 24) throw new ValidationError('Symbol is too long', 'symbol');

  // Reject before, not after, we build a URL out of it.
  const [body, suffix] = splitSuffix(s);
  if (!SYMBOL_BODY.test(body)) {
    throw new ValidationError(`"${input}" is not a valid symbol`, 'symbol');
  }
  if (suffix && !['NS', 'BO'].includes(suffix)) {
    throw new ValidationError(`Unsupported exchange suffix ".${suffix}"`, 'symbol');
  }
  if (!suffix) s = `${body}.NS`;
  return s;
}

function splitSuffix(s) {
  const m = s.match(/^(.+)\.(NS|BO|[A-Z]{1,4})$/);
  if (!m) return [s, null];
  return [m[1], m[2]];
}

export function validateEmail(input) {
  if (typeof input !== 'string') throw new ValidationError('Email is required', 'email');
  const email = input.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ValidationError('Enter a valid email address', 'email');
  }
  return email;
}

export function validatePassword(input) {
  if (typeof input !== 'string' || input.length < 8) {
    throw new ValidationError('Password must be at least 8 characters', 'password');
  }
  // bcrypt silently truncates past 72 bytes; refusing is honest, truncating is not.
  if (Buffer.byteLength(input, 'utf8') > 72) {
    throw new ValidationError('Password must be at most 72 bytes', 'password');
  }
  return input;
}

/** Optional positive price. Explicit null clears the value. */
export function validateOptionalPrice(value, field) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ValidationError(`${field} must be a positive number`, field);
  }
  if (n > 1e9) throw new ValidationError(`${field} is unrealistically large`, field);
  return Number(n.toFixed(4));
}

export function validateSearchQuery(input) {
  const q = typeof input === 'string' ? input.trim() : '';
  if (q.length > 40) throw new ValidationError('Search query is too long', 'q');
  return q;
}
