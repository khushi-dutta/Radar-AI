export async function fetchLatestNews(symbol) {
  try {
    const query = encodeURIComponent(`${symbol} stock India`);
    const url = `https://news.google.com/rss/search?q=${query}&hl=en-IN&gl=IN&ceid=IN:en`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const xml = await res.text();
    // Simple regex to extract the first <item><title>...</title>...<pubDate>...</pubDate>
    const itemMatch = xml.match(/<item>.*?<title>(.*?)<\/title>.*?<pubDate>(.*?)<\/pubDate>.*?<\/item>/s);
    if (itemMatch) {
      let title = itemMatch[1].replace(/<!\[CDATA\[(.*?)\]\]>/, '$1'); // Remove CDATA if present
      // Decode HTML entities (basic)
      title = title.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      const date = new Date(itemMatch[2]);
      return { headline: title, date: date.toISOString() };
    }
  } catch (err) {
    console.error(`Failed to fetch news for ${symbol}:`, err);
  }
  return null;
}
