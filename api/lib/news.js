// News for the companion from public RSS (Google News search feeds) — no API key needed.
// At most 5 items, cached 30 minutes per interest set (P1 spec).

const CACHE_MS = 30 * 60e3;
const cache = new Map(); // key → {at, items}

function decode(s) {
  return String(s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1]) : '';
}

// Parse RSS <item>s → [{title, source, url, published, blurb}]
function parseRss(xml, interest) {
  const items = [];
  for (const m of String(xml).matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const it = m[1];
    let title = tag(it, 'title');
    const source = tag(it, 'source') || (title.includes(' - ') ? title.split(' - ').pop() : '');
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    const url = tag(it, 'link');
    const pub = tag(it, 'pubDate');
    if (!title || !url) continue;
    items.push({
      title,
      source: source || 'Google News',
      url,
      published: pub ? new Date(pub).toISOString() : null,
      blurb: `${interest[0].toUpperCase()}${interest.slice(1)} news from ${source || 'Google News'}.`,
      interest,
    });
  }
  return items;
}

// Short interest chips → search terms that return the intended topic ("tech" alone finds Texas Tech).
const QUERIES = {
  tech: 'technology', technology: 'technology', ai: 'artificial intelligence', music: 'music industry new album',
  basketball: 'NBA basketball', football: 'NFL football', soccer: 'soccer', sports: 'sports', movies: 'movies film',
  film: 'movies film', science: 'science discovery', space: 'NASA space', fashion: 'fashion', gaming: 'video games',
  games: 'video games', books: 'books authors', food: 'food restaurants', travel: 'travel', health: 'health wellness',
  business: 'business', politics: 'politics', climate: 'climate', art: 'art exhibition', tv: 'TV shows',
};

async function fetchInterest(interest, { timeoutMs = 4000 } = {}) {
  const q = encodeURIComponent(`${QUERIES[interest] ?? interest} when:2d`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'FireflyCompanion/1.0' },
    });
    if (!res.ok) throw new Error(`news ${res.status}`);
    return parseRss(await res.text(), interest);
  } finally {
    clearTimeout(timer);
  }
}

// Round-robin across interests so each gets a turn, newest first within an interest.
async function getNews(interests) {
  const list = [...new Set(interests.map((s) => s.trim().toLowerCase()).filter(Boolean))].slice(0, 5);
  if (!list.length) list.push('top stories');
  const key = list.join(',');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.items;
  const results = await Promise.all(list.map((i) => fetchInterest(i).catch(() => [])));
  const items = [];
  const seen = new Set();
  for (let round = 0; items.length < 5 && round < 10; round++) {
    for (const r of results) {
      const it = r[round];
      if (it && !seen.has(it.title) && items.length < 5) {
        seen.add(it.title);
        items.push(it);
      }
    }
  }
  cache.set(key, { at: Date.now(), items });
  return items;
}

module.exports = { getNews, parseRss };
