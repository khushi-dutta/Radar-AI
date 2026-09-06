/**
 * Latest headline for a symbol, from Google News RSS.
 *
 * Scope is deliberately small. Headlines answer "why" once the engine has
 * already decided a stock is worth looking at -- they are not an input to
 * significance, because a headline count is a popularity measure, not an
 * evidence of change, and wiring it into the score would have made the ranking
 * follow the news cycle instead of the tape.
 *
 * Because it is a nice-to-have, it is held to the same rule as everything else
 * that leaves the process: it may never be the reason a request hangs. Bounded
 * by a timeout, cached, and single-flighted; on any failure it returns null and
 * the panel simply omits the section.
 */

const TIMEOUT_MS = 2500;
// Headlines do not move minute to minute, and this endpoint sits behind a user
// opening a detail panel -- easily repeated. 10 minutes keeps it honest without
// making us a burden on an endpoint nobody promised us.
const CACHE_TTL_MS = 10 * 60_000;

const cache = new Map();     // symbol -> { at, value }
const inFlight = new Map();  // symbol -> Promise, the same single-flight guard as market data

/** RSS is XML, so parse the first <item> with a real parser boundary, not a greedy regex. */
function firstItem(xml) {
  const start = xml.indexOf('<item>');
  if (start === -1) return null;
  const end = xml.indexOf('</item>', start);
  if (end === -1) return null;
  return xml.slice(start + '<item>'.length, end);
}

function tagText(itemXml, tag) {
  const m = itemXml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  if (!m) return null;
  return m[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').trim() || null;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
function decodeEntities(s) {
  return s.replace(/&(#39|amp|lt|gt|quot|apos);/g, (_, e) => ENTITIES[e] ?? _);
}

async function fetchOnce(symbol) {
  // Strip the exchange suffix: "RELIANCE.NS" is a ticker, "RELIANCE" is what
  // headlines are written about.
  const base = symbol.replace(/\.(NS|BO)$/i, '');
  const query = encodeURIComponent(`${base} stock India`);
  const url = `https://news.google.com/rss/search?q=${query}&hl=en-IN&gl=IN&ceid=IN:en`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;

    const item = firstItem(await res.text());
    if (!item) return null;

    const title = tagText(item, 'title');
    if (!title) return null;

    const pubDate = tagText(item, 'pubDate');
    const parsed = pubDate ? new Date(pubDate) : null;

    return {
      headline: decodeEntities(title),
      // An unparseable date is reported as absent rather than as the epoch or
      // as now -- both of which would be a claim about recency we cannot make.
      date: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null,
      link: tagText(item, 'link'),
      source: 'Google News',
    };
  } catch (err) {
    if (err?.name !== 'AbortError') {
      console.warn(`[news] fetch failed for ${symbol}:`, err.message);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchLatestNews(symbol, { now = Date.now() } = {}) {
  const hit = cache.get(symbol);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value;

  const existing = inFlight.get(symbol);
  if (existing) return existing;

  const p = fetchOnce(symbol)
    .then((value) => {
      // Negative results are cached too. A symbol with no coverage should cost
      // one upstream call every ten minutes, not one per panel open.
      cache.set(symbol, { at: Date.now(), value });
      return value;
    })
    .finally(() => inFlight.delete(symbol));

  inFlight.set(symbol, p);
  return p;
}
