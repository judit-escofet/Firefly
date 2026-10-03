// Vonage Voice + SMS, without the Vonage server SDK: JWTs are signed with Node's crypto.
//
// Settings (api/local.settings.json, never the repo):
//   VONAGE_APPLICATION_ID, VONAGE_PRIVATE_KEY   voice calls (the Application's private.key, PEM text)
//   VONAGE_FROM_NUMBER                          the Vonage number calls and texts come from
//   VONAGE_API_KEY, VONAGE_API_SECRET           SMS and account checks
//   VONAGE_SIGNATURE_SECRET                     checks that webhooks really come from Vonage
const crypto = require('crypto');

const API = 'https://api.nexmo.com';
const REST = 'https://rest.nexmo.com';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const digits = (phone) => String(phone ?? '').replace(/\D/g, '');

const voiceConfigured = () => Boolean(process.env.VONAGE_APPLICATION_ID && process.env.VONAGE_PRIVATE_KEY && process.env.VONAGE_FROM_NUMBER);
const smsConfigured = () => Boolean(process.env.VONAGE_API_KEY && process.env.VONAGE_API_SECRET && process.env.VONAGE_FROM_NUMBER);

// Private keys pasted into JSON sometimes arrive with literal "\n" instead of newlines.
const privateKey = () => String(process.env.VONAGE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

// RS256 JWT for the Vonage application. extra adds claims (sub and acl for a Client SDK user).
function appJwt(extra = {}, ttl = 900) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { application_id: process.env.VONAGE_APPLICATION_ID, iat: now, exp: now + ttl, jti: crypto.randomUUID(), ...extra };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), privateKey());
  return `${unsigned}.${b64url(signature)}`;
}

// Token for the browser (Vonage Client SDK) to log in as this walker and place a server call.
const CLIENT_ACL = { paths: { '/*/users/**': {}, '/*/conversations/**': {}, '/*/sessions/**': {}, '/*/devices/**': {},
  '/*/image/**': {}, '/*/media/**': {}, '/*/applications/**': {}, '/*/push/**': {}, '/*/knocking/**': {}, '/*/legs/**': {} } };
const clientJwt = (user, ttl = 600) => appJwt({ sub: user, acl: CLIENT_ACL }, ttl);

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${appJwt()}`, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Vonage ${method} ${path} → ${res.status}: ${data.title || data.detail || data.error_title || JSON.stringify(data).slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// The Client SDK needs the user to exist; creating it again is a harmless 409.
async function ensureUser(name) {
  try {
    await api('POST', '/v1/users', { name, display_name: 'Firefly walker' });
  } catch (err) {
    if (err.status !== 409) throw err;
  }
}

// Outbound call that just plays an NCCO (no webhooks needed).
function createCall({ to, ncco }) {
  return api('POST', '/v1/calls', {
    to: [{ type: 'phone', number: digits(to) }],
    from: { type: 'phone', number: digits(process.env.VONAGE_FROM_NUMBER) },
    ncco,
  });
}

async function sendSms(to, text) {
  const res = await fetch(`${REST}/sms/json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ api_key: process.env.VONAGE_API_KEY, api_secret: process.env.VONAGE_API_SECRET,
      from: digits(process.env.VONAGE_FROM_NUMBER), to: digits(to), text }),
    signal: AbortSignal.timeout(8000),
  });
  const data = await res.json().catch(() => ({}));
  const msg = data.messages && data.messages[0];
  if (!msg || msg.status !== '0') throw new Error(`Vonage SMS failed: ${msg ? msg['error-text'] : res.status}`);
  return msg;
}

// Vonage signs Voice webhooks with an HS256 JWT in the Authorization header. Accept when there is
// no signature secret (local mock mode) or VONAGE_VALIDATE=0 (debugging).
function isFromVonage(request, rawBody = '') {
  const secret = process.env.VONAGE_SIGNATURE_SECRET;
  if (!secret || process.env.VONAGE_VALIDATE === '0') return true;
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') || '');
  if (!m) return false;
  const [h, p, s] = m[1].split('.');
  if (!h || !p || !s) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest();
  const given = Buffer.from(s, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return false;
  let claims;
  try { claims = JSON.parse(Buffer.from(p, 'base64url').toString()); } catch { return false; }
  if (claims.exp && claims.exp < Date.now() / 1000 - 60) return false;
  if (rawBody && claims.payload_hash) {
    const hash = crypto.createHash('sha256').update(rawBody).digest('hex');
    if (hash !== claims.payload_hash) return false;
  }
  return true;
}

module.exports = { voiceConfigured, smsConfigured, appJwt, clientJwt, ensureUser, createCall, sendSms, isFromVonage, digits };
