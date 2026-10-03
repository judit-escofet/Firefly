// Small HTTP helpers: consistent JSON responses and 400s instead of crashes.

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const badRequest = (msg) => new HttpError(400, msg);
const notFound = (msg = 'Not found') => new HttpError(404, msg);

function json(status, body, headers = {}) {
  return { status, jsonBody: body, headers: { 'Cache-Control': 'no-store', ...headers } };
}

// Wraps a handler so thrown HttpErrors become clean JSON and anything else is a logged 500.
function handle(fn) {
  return async (request, context) => {
    try {
      return await fn(request, context);
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.message });
      context.error(err);
      return json(500, { error: 'Internal error' });
    }
  };
}

async function readJson(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    throw badRequest('Body must be valid JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Body must be a JSON object');
  return body;
}

// ---- validators ----

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function requireLatLng(obj, name) {
  if (!obj || typeof obj !== 'object') throw badRequest(`${name} is required`);
  const { lat, lng } = obj;
  if (!isNum(lat) || lat < -90 || lat > 90) throw badRequest(`${name}.lat must be a number between -90 and 90`);
  if (!isNum(lng) || lng < -180 || lng > 180) throw badRequest(`${name}.lng must be a number between -180 and 180`);
  return [lat, lng];
}

function requireString(v, name, { min = 1, max = 500 } = {}) {
  if (typeof v !== 'string' || v.trim().length < min) throw badRequest(`${name} is required`);
  if (v.length > max) throw badRequest(`${name} is too long (max ${max} characters)`);
  return v.trim();
}

function optionalTs(v, name = 'ts') {
  if (v === undefined || v === null) return new Date();
  const d = new Date(v);
  if (typeof v !== 'string' || Number.isNaN(d.getTime())) throw badRequest(`${name} must be an ISO 8601 timestamp`);
  return d;
}

function requireWalkId(request) {
  const id = request.params.walk_id;
  if (!id || !/^w_[A-Za-z0-9_-]{1,64}$/.test(id)) throw badRequest('walk_id is invalid');
  return id;
}

function baseUrl(request) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host');
  const proto = request.headers.get('x-forwarded-proto') || 'https';
  return host ? `${proto}://${host}` : new URL(request.url).origin;
}

module.exports = {
  HttpError, badRequest, notFound, json, handle, readJson,
  isNum, requireLatLng, requireString, optionalTs, requireWalkId, baseUrl,
};
