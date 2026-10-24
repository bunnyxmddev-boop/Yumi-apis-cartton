const express = require('express');
const cors = require('cors');
const { execFile } = require('child_process');
const scraper = require('./scraper');

const app = express();
app.use(cors());
app.set('json spaces', 2);

const PORT = process.env.PORT || 3000;

const wrap = (fn) => async (req, res) => {
  try {
    const data = await fn(req);
    res.json({ status: true, ...data });
  } catch (e) {
    res.status(e.status || 500).json({ status: false, error: e.message });
  }
};

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const pageOf = (req) => Math.max(1, parseInt(req.query.page, 10) || 1);
const idOf = (req) => {
  const raw = String(req.query.id || req.query.url || '');
  const m = /(?:id=)?(\d{3,})/.exec(raw);
  if (!m) throw bad('Provide ?id=<number> or ?url=<watch.php?id=... link>');
  return m[1];
};

// ---- yt-dlp resolver (optional) ------------------------------------------
const RESOLVABLE = /^https:\/\/(www\.)?(youtube\.com|youtu\.be|dailymotion\.com|rumble\.com|vimeo\.com|facebook\.com)\//i;
function resolveDirect(url) {
  return new Promise((resolve) => {
    if (!RESOLVABLE.test(url)) return resolve({ ok: false, reason: 'unsupported host' });
    execFile(
      process.env.YTDLP_BIN || 'yt-dlp',
      ['-g', '-f', 'best[ext=mp4]/best', '--no-playlist', '--no-warnings', url],
      { timeout: 40000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve({ ok: false, reason: err.code === 'ENOENT' ? 'yt-dlp not installed' : 'yt-dlp failed' });
        const urls = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
        resolve({ ok: urls.length > 0, urls });
      }
    );
  });
}

// ---- routes ---------------------------------------------------------------
app.get('/api/latest', wrap(async (req) => scraper.latest(pageOf(req))));

app.get('/api/categories', wrap(async () => {
  const results = await scraper.categories();
  return { count: results.length, results };
}));

app.get('/api/category', wrap(async (req) => {
  const { id, type } = req.query;
  if (!id) throw bad('Provide ?id=<category or playlist id> (&type=cat|list)');
  return scraper.category(type, id, pageOf(req));
}));

app.get('/api/search', wrap(async (req) => {
  const q = String(req.query.q || '').trim();
  if (!q) throw bad('Provide ?q=<search text>');
  return scraper.search(q, pageOf(req));
}));

app.get('/api/info', wrap(async (req) => ({ result: await scraper.info(idOf(req)) })));

// Resolves the real video source(s). Add &resolve=1 to also get direct media URLs via yt-dlp.
app.get('/api/download', wrap(async (req) => {
  const data = await scraper.info(idOf(req));
  const wantResolve = req.query.resolve === '1' || req.query.resolve === 'true';
  const downloads = [];

  for (const s of data.sources) {
    const entry = { ...s };
    if (s.type === 'direct' || s.type === 'hls') {
      entry.downloadUrl = s.url;
    } else if (wantResolve && s.watchUrl) {
      const r = await resolveDirect(s.watchUrl);
      if (r.ok) entry.downloadUrl = r.urls.length === 1 ? r.urls[0] : r.urls;
      else entry.resolveError = r.reason;
    }
    downloads.push(entry);
  }

  return {
    id: data.id,
    title: data.title,
    thumbnail: data.thumbnail,
    found: downloads.length,
    note: downloads.length
      ? 'Most videos on these sites are embeds of YouTube/Dailymotion etc. Use watchUrl with your downloader, or add &resolve=1 if yt-dlp is installed.'
      : 'No playable source found on this page.',
    downloads,
  };
}));

app.get('/api/sites', (req, res) => res.json({ status: true, sites: scraper.SITES }));

app.get('/', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({
    status: true,
    name: 'Sri Lankan Cartoon DL API',
    sources: scraper.SITES,
    endpoints: {
      latest: `${base}/api/latest?page=1`,
      categories: `${base}/api/categories`,
      category: `${base}/api/category?type=cat&id=984&page=1`,
      search: `${base}/api/search?q=jungle+book`,
      info: `${base}/api/info?id=263302`,
      download: `${base}/api/download?id=263302`,
      downloadResolved: `${base}/api/download?id=263302&resolve=1`,
    },
  });
});

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => console.log(`API running on :${PORT}`));
}
module.exports = app;
