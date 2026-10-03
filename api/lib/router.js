// Tiny router: endpoint files register with app.http(name, { methods, route, handler }) and
// get a fetch-style request (params, query, headers.get, json(), arrayBuffer()).
// Used by the Lambda entry point (src/lambda.js) and the local dev server (local-server.js).

const routes = [];
const byName = {};

const app = {
  http(name, { methods, route, handler }) {
    const keys = [];
    const pattern = route.replace(/\{(\w+)\}/g, (_, k) => { keys.push(k); return '([^/]+)'; });
    const entry = { name, methods, regex: new RegExp(`^/api/${pattern}/?$`), keys, handler };
    routes.push(entry);
    byName[name] = handler;
  },
};

class Request {
  constructor({ method, url, headers = {}, body, params = {} }) {
    this.method = method.toUpperCase();
    this.url = url;
    this.headers = new Headers(headers);
    this.params = params;
    this.query = new URL(url).searchParams;
    this._body = body == null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  }
  async text() { return this._body.toString('utf8'); }
  async json() { return JSON.parse(this._body.toString('utf8')); }
  async arrayBuffer() { return this._body; }
}

const logger = {
  log: (...a) => console.log(...a),
  info: (...a) => console.info(...a),
  warn: (...a) => console.warn(...a),
  error: (...a) => console.error(...a),
};

// Returns a response object { status, jsonBody?, body?, headers? }, or null when no route matches.
async function dispatch({ method, url, headers, body }) {
  const { pathname } = new URL(url);
  let pathMatched = false;
  for (const r of routes) {
    const m = r.regex.exec(pathname);
    if (!m) continue;
    pathMatched = true;
    if (!r.methods.includes(method.toUpperCase())) continue;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    return r.handler(new Request({ method, url, headers, body, params }), logger);
  }
  if (pathMatched) return { status: 405, jsonBody: { error: 'Method not allowed' } };
  return null;
}

module.exports = { app, Request, dispatch, byName, logger };
