// Runs the Azure Functions handlers (src/functions/*.js) outside the Functions host: captures
// their app.http registrations and invokes them with @azure/functions' own HttpRequest.
// Used by dev-server.js (plain Node) and lambda.js (AWS Lambda function URL).
const fs = require('fs');
const path = require('path');

function loadRoutes() {
  const functions = require('@azure/functions');
  const routes = [];
  functions.app.http = (name, opts) => {
    const keys = [];
    const re = new RegExp(`^/api/${opts.route.replace(/\{(\w+)\}/g, (_, k) => (keys.push(k), '([^/]+)'))}$`);
    routes.push({ name, route: opts.route, re, keys, methods: opts.methods ?? ['GET'], handler: opts.handler });
  };
  const dir = path.join(__dirname, '..', 'src', 'functions');
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.js')) require(path.join(dir, f));
  return { functions, routes };
}

const logContext = (name) => ({
  log: (...a) => console.log(`[${name}]`, ...a),
  info: (...a) => console.log(`[${name}]`, ...a),
  warn: (...a) => console.warn(`[${name}]`, ...a),
  error: (...a) => console.error(`[${name}]`, ...a),
  invocationId: Math.random().toString(36).slice(2),
});

// → {status, headers, body: Buffer} or null when no route matches.
async function invoke({ functions, routes }, { method, url, headers, body }) {
  const u = new URL(url);
  const route = routes.find((r) => r.re.test(u.pathname));
  if (!route) return null;
  if (!route.methods.includes(method)) return { status: 405, headers: {}, body: Buffer.alloc(0) };
  const m = u.pathname.match(route.re);
  const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
  const request = new functions.HttpRequest({
    method,
    url: u.toString(),
    params,
    headers,
    body: body && body.length ? { bytes: body } : undefined,
  });
  const out = (await route.handler(request, logContext(route.name))) ?? {};
  const outHeaders = { ...(out.headers ?? {}) };
  let payload = out.body ?? '';
  if (out.jsonBody !== undefined) {
    payload = JSON.stringify(out.jsonBody);
    outHeaders['Content-Type'] ??= 'application/json';
  }
  return { status: out.status ?? 200, headers: outHeaders, body: Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload)) };
}

module.exports = { loadRoutes, invoke };
