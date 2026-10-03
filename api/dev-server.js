// Local API server without Azure Functions Core Tools: `node dev-server.js` (or `npm run dev`).
// Loads every function in src/functions/ the same way the Functions host would (by capturing
// app.http registrations), reads settings from local.settings.json, and serves them under /api
// on http://localhost:7071 — the address the Vite dev server proxies /api to.
const http = require('http');
const fs = require('fs');
const path = require('path');

const settingsFile = path.join(__dirname, 'local.settings.json');
if (fs.existsSync(settingsFile)) {
  const { Values = {} } = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  for (const [k, v] of Object.entries(Values)) if (v !== '' && process.env[k] === undefined) process.env[k] = v;
} else {
  console.warn('local.settings.json not found: copy local.settings.example.json and fill in the keys');
}

const functions = require('@azure/functions');
const routes = [];
functions.app.http = (name, opts) => {
  const keys = [];
  const re = new RegExp(`^/api/${opts.route.replace(/\{(\w+)\}/g, (_, k) => (keys.push(k), '([^/]+)'))}$`);
  routes.push({ name, route: opts.route, re, keys, methods: opts.methods ?? ["GET"], handler: opts.handler });
};
for (const f of fs.readdirSync(path.join(__dirname, 'src/functions'))) {
  if (f.endsWith('.js')) require(`./src/functions/${f}`);
}

const ctx = (name) => ({
  log: (...a) => console.log(`[${name}]`, ...a),
  info: (...a) => console.log(`[${name}]`, ...a),
  warn: (...a) => console.warn(`[${name}]`, ...a),
  error: (...a) => console.error(`[${name}]`, ...a),
  invocationId: Math.random().toString(36).slice(2),
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = routes.find((r) => r.re.test(url.pathname));
  if (!route) return res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"Not found"}');
  if (!route.methods.includes(req.method)) return res.writeHead(405).end();
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(url.pathname.match(route.re)[i + 1])]));
  const t0 = Date.now();
  try {
    const request = new functions.HttpRequest({
      method: req.method,
      url: url.toString(),
      params,
      headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])),
      body: body.length ? { bytes: body } : undefined,
    });
    const out = (await route.handler(request, ctx(route.name))) ?? {};
    const headers = { ...(out.headers ?? {}) };
    let payload = out.body ?? '';
    if (out.jsonBody !== undefined) {
      payload = JSON.stringify(out.jsonBody);
      headers['Content-Type'] ??= 'application/json';
    }
    res.writeHead(out.status ?? 200, headers).end(payload);
    console.log(`${req.method} ${url.pathname} → ${out.status ?? 200} (${Date.now() - t0} ms)`);
  } catch (err) {
    console.error(`${req.method} ${url.pathname} crashed`, err);
    res.writeHead(500, { 'Content-Type': 'application/json' }).end('{"error":"Internal error"}');
  }
});

const port = Number(process.env.PORT || 7071);
server.listen(port, () => {
  console.log(`Firefly API (dev) on http://localhost:${port}/api — ${routes.length} routes`);
  for (const r of routes) console.log(`  ${r.methods.join(',').padEnd(9)} /api/${r.route}`);
});
