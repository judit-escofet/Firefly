// AWS Lambda entry for the HTTP API (API Gateway or a function URL, payload v2).
//   /api/*           -> endpoint files in src/functions
//   /track/{token}   -> the contacts' tracking page (same origin as the API, so no CORS needed there)
//   anything else    -> the built app (app/dist), when bundled as ./public by deploy/aws/deploy.sh,
//                       so the whole product runs on one HTTPS origin (the mic needs HTTPS)
const fs = require('fs');
const path = require('path');
const { dispatch } = require('../lib/router');

for (const f of fs.readdirSync(path.join(__dirname, 'functions'))) require(`./functions/${f}`);

let trackPage;
function trackHtml() {
  if (!trackPage) {
    // Copied in by `npm run build:page` before deploy; the second path works in local dev.
    const candidates = [
      path.join(__dirname, '..', 'static', 'track.html'),
      path.join(__dirname, '..', '..', 'app', 'public', 'track', 'index.html'),
    ];
    const found = candidates.find((p) => fs.existsSync(p));
    if (!found) throw new Error('Tracking page not bundled: run npm run build:page');
    trackPage = fs.readFileSync(found, 'utf8');
  }
  return trackPage;
}

// ---- the built app (optional: only when deploy/aws/deploy.sh bundled app/dist as ./public) ----
const PUBLIC = path.join(__dirname, '..', 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.wasm': 'application/wasm', '.bin': 'application/octet-stream', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.csv': 'text/csv', '.txt': 'text/plain',
};
const TEXT = /^(text\/|application\/json)/;

function appFile(rawPath) {
  if (!fs.existsSync(PUBLIC)) return null;
  let rel = decodeURIComponent(rawPath).replace(/^\/+/, '');
  if (rel.includes('..')) return null;
  let file = path.join(PUBLIC, rel || 'index.html');
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) {
    if (path.extname(rel)) return { statusCode: 404, headers: { 'Content-Type': 'text/plain' }, body: 'Not found' };
    file = path.join(PUBLIC, 'index.html'); // single-page app: client-side routes
  }
  const ext = path.extname(file);
  const type = TYPES[ext] || 'application/octet-stream';
  const data = fs.readFileSync(file);
  const text = TEXT.test(type);
  return {
    statusCode: 200,
    headers: {
      'Content-Type': type,
      'Cache-Control': rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Permissions-Policy': 'geolocation=(self), microphone=(self), screen-wake-lock=(self)',
    },
    body: data.toString(text ? 'utf8' : 'base64'),
    isBase64Encoded: !text,
  };
}

function toLambda(res) {
  const headers = { ...(res.headers || {}) };
  if (res.jsonBody !== undefined) {
    headers['Content-Type'] = 'application/json';
    return { statusCode: res.status, headers, body: JSON.stringify(res.jsonBody) };
  }
  if (Buffer.isBuffer(res.body)) {
    return { statusCode: res.status, headers, body: res.body.toString('base64'), isBase64Encoded: true };
  }
  return { statusCode: res.status, headers, body: res.body || '' };
}

exports.handler = async (event) => {
  const method = event.requestContext.http.method;
  const host = event.headers.host || event.requestContext.domainName;
  const url = `https://${host}${event.rawPath}${event.rawQueryString ? `?${event.rawQueryString}` : ''}`;

  if (method === 'GET' && /^\/track\/[^/]+\/?$/.test(event.rawPath)) {
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Robots-Tag': 'noindex',
      },
      body: trackHtml(),
    };
  }

  if (method === 'GET' && !event.rawPath.startsWith('/api/')) {
    const page = appFile(event.rawPath);
    if (page) return page;
  }

  const body = event.body == null ? undefined
    : event.isBase64Encoded ? Buffer.from(event.body, 'base64') : Buffer.from(event.body, 'utf8');
  try {
    const res = await dispatch({ method, url, headers: event.headers, body });
    return toLambda(res || { status: 404, jsonBody: { error: 'Not found' } });
  } catch (err) {
    console.error(err);
    return toLambda({ status: 500, jsonBody: { error: 'Internal error' } });
  }
};
