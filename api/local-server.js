// Local dev server: npm start  ->  http://localhost:4280
// Serves the API, the tracking page at /track/{token}, and anything else in app/public.
// Settings come from api/local.settings.json (git-ignored). No WebSocket locally: the tracking page
// falls back to polling every 10 seconds.
const fs = require('fs');
const path = require('path');
const http = require('http');

try {
  const { Values = {} } = JSON.parse(fs.readFileSync(path.join(__dirname, 'local.settings.json'), 'utf8'));
  for (const [k, v] of Object.entries(Values)) if (v !== '' && process.env[k] === undefined) process.env[k] = v;
} catch {
  console.warn('No api/local.settings.json found: everything runs in mock mode.');
}

const { dispatch } = require('./lib/router');
for (const f of fs.readdirSync(path.join(__dirname, 'src', 'functions'))) require(`./src/functions/${f}`);

const PORT = Number(process.env.PORT || 4280);
const PUBLIC = path.join(__dirname, '..', 'app', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

function serveFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const url = `http://localhost:${PORT}${req.url}`;
    const { pathname } = new URL(url);
    if (pathname.startsWith('/api/')) {
      try {
        const out = (await dispatch({ method: req.method, url, headers: req.headers, body: Buffer.concat(chunks) }))
          || { status: 404, jsonBody: { error: 'Not found' } };
        const headers = { ...(out.headers || {}) };
        if (out.jsonBody !== undefined) headers['Content-Type'] = 'application/json';
        res.writeHead(out.status, headers);
        res.end(out.jsonBody !== undefined ? JSON.stringify(out.jsonBody) : out.body || '');
      } catch (err) {
        console.error(err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('{"error":"Internal error"}');
      }
      return;
    }
    if (/^\/track\/[^/]+\/?$/.test(pathname)) return serveFile(res, path.join(PUBLIC, 'track', 'index.html'));
    const file = path.normalize(path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
    serveFile(res, file);
  });
}).listen(PORT, () => console.log(`Firefly API on http://localhost:${PORT}`));
