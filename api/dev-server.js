// Local API server without Azure Functions Core Tools: `node dev-server.js` (or `npm run dev`).
// Loads every function in src/functions/ the same way the Functions host would, reads settings
// from local.settings.json, and serves them under /api on http://localhost:7071 — the address
// the Vite dev server proxies /api to.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadRoutes, invoke } = require('./lib/host');

const settingsFile = path.join(__dirname, 'local.settings.json');
if (fs.existsSync(settingsFile)) {
  const { Values = {} } = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  for (const [k, v] of Object.entries(Values)) if (v !== '' && process.env[k] === undefined) process.env[k] = v;
} else {
  console.warn('local.settings.json not found: copy local.settings.example.json and fill in the keys');
}

const app = loadRoutes();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const t0 = Date.now();
  try {
    const out = await invoke(app, {
      method: req.method,
      url: url.toString(),
      headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])),
      body: Buffer.concat(chunks),
    });
    if (!out) return res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"Not found"}');
    res.writeHead(out.status, out.headers).end(out.body);
    console.log(`${req.method} ${url.pathname} → ${out.status} (${Date.now() - t0} ms)`);
  } catch (err) {
    console.error(`${req.method} ${url.pathname} crashed`, err);
    res.writeHead(500, { 'Content-Type': 'application/json' }).end('{"error":"Internal error"}');
  }
});

const port = Number(process.env.PORT || 7071);
server.listen(port, () => {
  console.log(`Firefly API (dev) on http://localhost:${port}/api — ${app.routes.length} routes`);
  for (const r of app.routes) console.log(`  ${r.methods.join(',').padEnd(9)} /api/${r.route}`);
});
