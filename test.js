// Offline test: serves fixture pages that mimic the site's structure and checks every endpoint.
const http = require('http');
const assert = require('assert');

const listing = (items) => `<html><body><div class="x">${'x'.repeat(600)}</div>
<b>Jungle Book</b> << Prev 1 <a href="/more.php?cat=984&i=2">2</a> <a href="/more.php?cat=984&i=3">3</a>
${items.map((i) => `<div class="v"><a href="https://ginisisilacartoon.net/watch.php?id=${i.id}" title="${i.t}"><img src="${i.img}"></a>
<a href="https://ginisisilacartoon.net/watch.php?id=${i.id}" title="${i.t}">${i.t}</a><br>From <a href="https://lakvisiontv.com/channels.php?id=1">Hiru TV</a><br>by LakvisionTV<br>${i.v} views<br>
<a href="https://lakvisiontv.com/more.php?cat=984">view all items</a></div>`).join('')}</body></html>`;

const items = [
  { id: 263302, t: 'JUNGLE BOOK - SEASON 4-47', img: 'https://yt3.ggpht.com/a', v: '1,011' },
  { id: 263234, t: 'JUNGLE BOOK - SEASON 4-46', img: 'https://yt3.ggpht.com/a', v: '12' },
];

const watch = `<html><head><title>Lakvision Original - JUNGLE BOOK - SEASON 4-47</title></head><body>${'x'.repeat(600)}
<iframe src="https://www.youtube.com/embed/AbCdEfGhIjK?rel=0"></iframe>
Uploaded by <b>LakvisionTV</b> on 24 October 2026 | <b>11</b> views
<b>Related Videos</b>
<a href="/watch.php?id=263234" title="JUNGLE BOOK - SEASON 4-46"><img src="https://i.ytimg.com/vi/ZZZZZZZZZZZ/mqdefault.jpg"></a>
<iframe src="https://www.youtube.com/embed/SIDEBARVID1"></iframe></body></html>`;

const playlists = `<html><body>${'x'.repeat(600)}<b>Hiru TV Sinhala Cartoon</b> <a href="/more.php?list=846">view all</a>
<b>Jungle Book</b> <a href="/more.php?cat=984">Jungle Book</a></body></html>`;

const server = http.createServer((req, res) => {
  const u = req.url;
  res.setHeader('content-type', 'text/html');
  if (u.startsWith('/watch.php')) return res.end(watch);
  if (u.startsWith('/playlists.php')) return res.end(playlists);
  if (u.startsWith('/search.php?q=')) return res.end(listing(items));
  if (u.startsWith('/more.php') || u.startsWith('/all_videos.php')) return res.end(listing(items));
  res.statusCode = 404;
  res.end('nope');
});

server.listen(0, async () => {
  process.env.SITES = `http://127.0.0.1:${server.address().port}`;
  const app = require('./index');
  const api = app.listen(0);
  const base = `http://127.0.0.1:${api.address().port}`;
  const get = async (p) => (await fetch(base + p)).json();
  try {
    let r = await get('/api/latest');
    assert.equal(r.results.length, 2);
    assert.equal(r.results[0].id, '263302');
    assert.equal(r.results[0].channel, 'Hiru TV');
    assert.equal(r.results[0].views, 1011);
    assert.equal(r.lastPage, 3);

    r = await get('/api/category?type=cat&id=984&page=2');
    assert.equal(r.page, 2);
    assert.equal(r.count, 2);

    r = await get('/api/categories');
    assert.ok(r.results.find((c) => c.id === '846' && c.name.includes('Hiru')));

    r = await get('/api/search?q=jungle');
    assert.equal(r.count, 2);

    r = await get('/api/info?url=https://ginisisilacartoon.net/watch.php?id=263302');
    assert.equal(r.result.title, 'JUNGLE BOOK - SEASON 4-47');
    assert.equal(r.result.views, 11);
    assert.equal(r.result.sources.length, 1, 'sidebar embed must be ignored');
    assert.equal(r.result.sources[0].id, 'AbCdEfGhIjK');
    assert.equal(r.result.related.length, 1);

    r = await get('/api/download?id=263302');
    assert.equal(r.found, 1);
    assert.equal(r.downloads[0].watchUrl, 'https://www.youtube.com/watch?v=AbCdEfGhIjK');

    r = await get('/api/info');
    assert.equal(r.status, false);

    console.log('ALL TESTS PASSED');
  } catch (e) {
    console.error('TEST FAILED:', e.message);
    process.exitCode = 1;
  } finally {
    api.close();
    server.close();
  }
});
