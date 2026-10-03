// AWS Lambda entry (function URL, payload v2) for the hackathon AWS deployment: one HTTPS origin
// that serves the built app (./public, copied from app/dist by deploy/aws/deploy.sh) and the
// Azure-Functions-style API under /api/* — so the mic (needs HTTPS) and same-origin /api work.
// Routing mirrors app/public/staticwebapp.config.json: /track/* → track/index.html, other
// extension-less paths → index.html.
const fs = require('fs');
const path = require('path');
const { loadRoutes, invoke } = require('./lib/host');

process.env.COMPANION_DATA_DIR ??= '/tmp/firefly-data'; // the package directory is read-only
const app = loadRoutes();
const PUBLIC = path.join(__dirname, 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.bin': 'application/octet-stream', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.csv': 'text/csv',
  '.txt': 'text/plain', '.webmanifest': 'application/manifest+json',
};
const TEXT = /^(text\/|application\/(json|manifest|javascript))/;

function staticFile(urlPath) {
  let rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  if (rel.includes('..')) return null;
  if (!rel) rel = 'index.html';
  let file = path.join(PUBLIC, rel);
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) {
    if (path.extname(rel)) return null; // a missing asset is a real 404
    file = path.join(PUBLIC, rel.startsWith('track/') ? 'track/index.html' : 'index.html');
  }
  const ext = path.extname(file);
  const type = TYPES[ext] ?? 'application/octet-stream';
  const immutable = rel.startsWith('assets/');
  return {
    status: 200,
    headers: {
      'Content-Type': type,
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Permissions-Policy': 'geolocation=(self), microphone=(self), screen-wake-lock=(self)',
    },
    body: fs.readFileSync(file),
    text: TEXT.test(type),
  };
}

exports.handler = async (event) => {
  const method = event.requestContext?.http?.method ?? 'GET';
  const rawPath = event.rawPath || '/';
  const host = event.headers?.host ?? 'localhost';
  const url = `https://${host}${rawPath}${event.rawQueryString ? `?${event.rawQueryString}` : ''}`;
  try {
    if (rawPath.startsWith('/api/')) {
      const body = event.body ? Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8') : null;
      const headers = { ...(event.headers ?? {}) };
      if (event.cookies?.length) headers.cookie = event.cookies.join('; ');
      const out = await invoke(app, { method, url, headers, body });
      if (!out) return { statusCode: 404, headers: { 'Content-Type': 'application/json' }, body: '{"error":"Not found"}' };
      const type = String(out.headers['Content-Type'] ?? out.headers['content-type'] ?? '');
      const text = TEXT.test(type) || type === '';
      return { statusCode: out.status, headers: out.headers, body: out.body.toString(text ? 'utf8' : 'base64'), isBase64Encoded: !text };
    }
    if (method !== 'GET' && method !== 'HEAD') return { statusCode: 405, body: '' };
    const f = staticFile(rawPath);
    if (!f) return { statusCode: 404, headers: { 'Content-Type': 'text/plain' }, body: 'Not found' };
    return { statusCode: f.status, headers: f.headers, body: f.body.toString(f.text ? 'utf8' : 'base64'), isBase64Encoded: !f.text };
  } catch (err) {
    console.error(`${method} ${rawPath} crashed`, err);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: '{"error":"Internal error"}' };
  }
};
