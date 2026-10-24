const axios = require('axios');
const cheerio = require('cheerio');

// Both sites (and lakvisioncartoons.in) run the same LankaHQ CMS, so one parser covers all.
const SITES = (process.env.SITES ||
  'https://ginisisilacartoon.net,https://lakvisiontv.com,https://lakvisioncartoons.in')
  .split(',')
  .map((s) => s.trim().replace(/\/$/, ''))
  .filter(Boolean);

const http = axios.create({
  timeout: 15000,
  maxRedirects: 5,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9,si;q=0.8',
  },
});

// ---- tiny TTL cache -------------------------------------------------------
const cache = new Map();
const TTL = (Number(process.env.CACHE_SECONDS) || 120) * 1000;
function cacheGet(k) {
  const v = cache.get(k);
  if (v && Date.now() - v.t < TTL) return v.d;
  cache.delete(k);
  return null;
}
function cacheSet(k, d) {
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  cache.set(k, { t: Date.now(), d });
}

// ---- fetching with domain fallback ---------------------------------------
async function fetchHtml(path) {
  const hit = cacheGet(path);
  if (hit) return hit;
  let lastErr;
  for (const base of SITES) {
    try {
      const res = await http.get(base + '/' + path.replace(/^\//, ''), { responseType: 'text' });
      if (typeof res.data === 'string' && res.data.length > 500) {
        const out = { html: res.data, base };
        cacheSet(path, out);
        return out;
      }
    } catch (e) {
      lastErr = e;
    }
  }
  const err = new Error('All source sites failed: ' + (lastErr ? lastErr.message : 'empty response'));
  err.status = 502;
  throw err;
}

// ---- helpers --------------------------------------------------------------
const abs = (base, u) => {
  if (!u) return null;
  try {
    return new URL(u, base).href;
  } catch {
    return u;
  }
};
const idFrom = (href) => {
  const m = /watch\.php\?id=(\d+)/.exec(href || '');
  return m ? m[1] : null;
};
const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

// ---- listing parser -------------------------------------------------------
function parseListing(html, base) {
  const $ = cheerio.load(html);
  const seen = new Map();

  $('a[href*="watch.php?id="]').each((_, el) => {
    const a = $(el);
    const id = idFrom(a.attr('href'));
    if (!id) return;
    const img = a.find('img').first();
    const title = clean(a.attr('title') || img.attr('alt') || a.text());
    if (!seen.has(id)) seen.set(id, { id, title: '', thumbnail: null });
    const item = seen.get(id);
    if (title && !item.title) item.title = title;
    if (img.length && !item.thumbnail) item.thumbnail = abs(base, img.attr('src') || img.attr('data-src'));

    // channel + views live in the surrounding block
    if (!item.channel) {
      let node = a.parent();
      for (let i = 0; i < 4 && node.length; i++, node = node.parent()) {
        const ch = node.find('a[href*="channels.php?id="]').first();
        if (ch.length) {
          item.channel = clean(ch.text());
          const cid = /channels\.php\?id=(\d+)/.exec(ch.attr('href'));
          item.channelId = cid ? cid[1] : null;
          const v = /([\d,]+)\s*views/i.exec(node.text());
          if (v) item.views = Number(v[1].replace(/,/g, ''));
          const cat = node.find('a[href*="more.php?cat="]').first();
          if (cat.length) item.categoryId = (/cat=(\d+)/.exec(cat.attr('href')) || [])[1] || null;
          break;
        }
      }
    }
  });

  const items = [...seen.values()].filter((i) => i.title);
  const heading = clean($('b, strong').filter((_, e) => /<</.test($(e).text()) || true).first().text());

  // pagination: more.php?cat=984&i=3
  let lastPage = 1;
  $('a[href*="i="]').each((_, e) => {
    const m = /[?&]i=(\d+)/.exec($(e).attr('href') || '');
    if (m) lastPage = Math.max(lastPage, Number(m[1]));
  });

  return { items, lastPage, heading };
}

// ---- category list (from playlists.php / home) ---------------------------
function parseCategories(html, base) {
  const $ = cheerio.load(html);
  const out = new Map();
  $('a[href*="more.php?list="], a[href*="more.php?cat="]').each((_, el) => {
    const href = $(el).attr('href');
    const m = /more\.php\?(list|cat)=(\d+)/.exec(href);
    if (!m) return;
    const key = m[1] + m[2];
    const text = clean($(el).text());
    if (!out.has(key)) out.set(key, { type: m[1], id: m[2], name: '' });
    if (text && !/^(view all|view all items|1|2|3)$/i.test(text) && !out.get(key).name) out.get(key).name = text;
  });
  // fall back to the heading that precedes a "view all" link
  $('a[href*="more.php?list="]').each((_, el) => {
    const m = /list=(\d+)/.exec($(el).attr('href'));
    const rec = m && out.get('list' + m[1]);
    if (rec && !rec.name) {
      const prev = $(el).prevAll('b, strong, h2, h3').first();
      const alt = $(el).parent().prevAll('b, strong, h2, h3').first();
      rec.name = clean(prev.text() || alt.text());
    }
  });
  return [...out.values()].filter((c) => c.name);
}

// ---- source extraction ----------------------------------------------------
const PATTERNS = [
  { type: 'youtube', re: /(?:youtube(?:-nocookie)?\.com\/embed\/|youtu\.be\/|youtube\.com\/watch\?v=)([\w-]{11})/g,
    watch: (id) => `https://www.youtube.com/watch?v=${id}`, embed: (id) => `https://www.youtube.com/embed/${id}` },
  { type: 'dailymotion', re: /dailymotion\.com\/(?:embed\/)?video\/([a-z0-9]+)/gi,
    watch: (id) => `https://www.dailymotion.com/video/${id}`, embed: (id) => `https://www.dailymotion.com/embed/video/${id}` },
  { type: 'rumble', re: /rumble\.com\/embed\/([a-z0-9]+)/gi,
    watch: (id) => `https://rumble.com/embed/${id}/`, embed: (id) => `https://rumble.com/embed/${id}/` },
  { type: 'vimeo', re: /player\.vimeo\.com\/video\/(\d+)/g,
    watch: (id) => `https://vimeo.com/${id}`, embed: (id) => `https://player.vimeo.com/video/${id}` },
  { type: 'facebook', re: /facebook\.com\/(?:plugins\/video\.php\?[^"'\s]*href=|[\w.]+\/videos\/)([^"'\s&]+)/g,
    watch: null, embed: null },
];

function extractSources(html, base) {
  // only look at the part above "Related Videos" so sidebar videos aren't picked up
  const cut = html.search(/Related\s+Videos/i);
  const scope = cut > 0 ? html.slice(0, cut) : html;
  const decoded = scope.replace(/\\\//g, '/').replace(/&amp;/g, '&');
  const sources = [];
  const seen = new Set();

  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(decoded))) {
      const key = p.type + ':' + m[1];
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push({
        type: p.type,
        id: m[1],
        watchUrl: p.watch ? p.watch(m[1]) : null,
        embedUrl: p.embed ? p.embed(m[1]) : null,
      });
    }
  }

  // direct files
  const direct = decoded.match(/https?:\/\/[^"'\s<>\\]+\.(?:mp4|m3u8|webm)(?:\?[^"'\s<>\\]*)?/gi) || [];
  for (const u of new Set(direct)) {
    sources.push({ type: /m3u8/i.test(u) ? 'hls' : 'direct', url: u });
  }

  // any other iframe src we did not recognise
  const $ = cheerio.load(scope);
  $('iframe[src]').each((_, el) => {
    const src = abs(base, $(el).attr('src'));
    if (!src) return;
    if (sources.some((s) => (s.embedUrl && src.startsWith(s.embedUrl.split('?')[0])) || s.url === src)) return;
    if (/ads|doubleclick|facebook\.com\/plugins\/like/i.test(src)) return;
    sources.push({ type: 'iframe', embedUrl: src });
  });

  return sources;
}

function parseWatch(html, base, id) {
  const $ = cheerio.load(html);
  let title =
    clean($('meta[property="og:title"]').attr('content')) ||
    clean($('h1').first().text());
  if (!title) {
    const t = clean($('title').text());
    const m = /Original\s+-\s+(.+)$/.exec(t);
    title = m ? clean(m[1]) : t;
  }
  const text = clean($('body').text());
  const up = /Uploaded by\s+(.+?)\s+on\s+(\d{1,2}\s+\w+\s+\d{4})\s*\|\s*([\d,]+)\s*views/i.exec(text);
  const thumbnail = abs(base, $('meta[property="og:image"]').attr('content') || $('link[rel="image_src"]').attr('href'));
  const sources = extractSources(html, base);

  const rel = parseListing(html.slice(Math.max(0, html.search(/Related\s+Videos/i))), base).items
    .filter((i) => i.id !== String(id))
    .slice(0, 15);

  return {
    id: String(id),
    title,
    uploader: up ? up[1] : null,
    uploadedOn: up ? up[2] : null,
    views: up ? Number(up[3].replace(/,/g, '')) : null,
    thumbnail,
    sources,
    related: rel,
  };
}

// ---- public API -----------------------------------------------------------
async function latest(page = 1) {
  const path = page > 1 ? `all_videos.php?i=${page}` : 'all_videos.php';
  const { html, base } = await fetchHtml(path);
  const r = parseListing(html, base);
  return { page: Number(page), lastPage: r.lastPage, count: r.items.length, results: r.items };
}

async function categories() {
  const { html, base } = await fetchHtml('playlists.php');
  return parseCategories(html, base);
}

async function category(type, id, page = 1) {
  const t = type === 'list' ? 'list' : 'cat';
  const path = `more.php?${t}=${encodeURIComponent(id)}${page > 1 ? `&i=${page}` : ''}`;
  const { html, base } = await fetchHtml(path);
  const r = parseListing(html, base);
  return { type: t, id: String(id), page: Number(page), lastPage: r.lastPage, count: r.items.length, results: r.items };
}

async function search(q, page = 1) {
  // The CMS search endpoint is not documented; try the common LankaHQ variants.
  const enc = encodeURIComponent(q);
  const candidates = [
    `search.php?q=${enc}`,
    `search.php?search=${enc}`,
    `search.php?keyword=${enc}`,
    `search.php?query=${enc}`,
    `search_result.php?search_query=${enc}`,
  ];
  for (const c of candidates) {
    try {
      const path = page > 1 ? `${c}&i=${page}` : c;
      const { html, base } = await fetchHtml(path);
      const r = parseListing(html, base);
      if (r.items.length) {
        return { query: q, page: Number(page), lastPage: r.lastPage, count: r.items.length, results: r.items };
      }
    } catch (_) {
      /* try next */
    }
  }
  return { query: q, page: Number(page), lastPage: 1, count: 0, results: [] };
}

async function info(id) {
  const { html, base } = await fetchHtml(`watch.php?id=${encodeURIComponent(id)}`);
  return parseWatch(html, base, id);
}

module.exports = { latest, categories, category, search, info, SITES, _internals: { parseListing, parseWatch, extractSources, parseCategories } };
