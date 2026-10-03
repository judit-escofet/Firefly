// AWS Lambda entry for the HTTP API (API Gateway, payload v2).
//   /api/*           -> endpoint files in src/functions
//   /track/{token}   -> the contacts' tracking page (same origin as the API, so no CORS needed there)
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
