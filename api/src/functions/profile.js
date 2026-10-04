// POST /api/profile — create or replace a user's profile.
const crypto = require('crypto');
const { app } = require('../../lib/router');
const db = require('../../db');
const { handle, readJson, json, badRequest, requireString, requireLatLng } = require('../../lib/http');

const PHONE_RE = /^\+1\d{10}$/;

function validate(body) {
  const name = requireString(body.name, 'name', { max: 80 });

  const contacts = body.contacts;
  if (!Array.isArray(contacts) || contacts.length < 1 || contacts.length > 3) {
    throw badRequest('contacts must be a list of 1 to 3 people');
  }
  const cleanContacts = contacts.map((c, i) => {
    if (!c || typeof c !== 'object') throw badRequest(`contacts[${i}] must be an object`);
    const phone = typeof c.phone === 'string' ? c.phone.replace(/[\s()-]/g, '') : '';
    if (!PHONE_RE.test(phone)) throw badRequest(`contacts[${i}].phone must look like +15551234567`);
    return { name: typeof c.name === 'string' ? c.name.trim().slice(0, 80) : '', phone };
  });
  if (new Set(cleanContacts.map((c) => c.phone)).size !== cleanContacts.length) {
    throw badRequest('contacts must have different phone numbers');
  }

  const codePhrase = requireString(body.code_phrase, 'code_phrase', { max: 200 });
  if (codePhrase.split(/\s+/).filter(Boolean).length < 3) throw badRequest('code_phrase must be at least 3 words');

  const pinHash = requireString(body.pin_hash, 'pin_hash', { max: 500 });
  // No separate duress PIN any more: any wrong code during the countdown counts as duress (the
  // app decides). An older client may still send one; then it must differ from the PIN.
  const duressPinHash = body.duress_pin_hash == null || body.duress_pin_hash === '' ? null
    : requireString(body.duress_pin_hash, 'duress_pin_hash', { max: 500 });
  if (duressPinHash && pinHash === duressPinHash) throw badRequest('pin_hash and duress_pin_hash must be different');

  // Optional (team plan): news interests and the home location.
  let interests = [];
  if (body.interests != null) {
    if (!Array.isArray(body.interests) || body.interests.length > 20 ||
        !body.interests.every((x) => typeof x === 'string' && x.trim() && x.length <= 40)) {
      throw badRequest('interests must be a list of up to 20 short strings');
    }
    interests = [...new Set(body.interests.map((x) => x.trim().toLowerCase()))];
  }
  let home = null;
  if (body.home != null) {
    const [lat, lng] = requireLatLng(body.home, 'home');
    home = { lat, lng, label: typeof body.home.label === 'string' ? body.home.label.slice(0, 120) : 'Home' };
  }

  let userId = body.user_id;
  if (userId !== undefined && (typeof userId !== 'string' || !/^u_[A-Za-z0-9_-]{1,64}$/.test(userId))) {
    throw badRequest('user_id must look like u_abc123');
  }
  return { userId, name, contacts: cleanContacts, codePhrase, pinHash, duressPinHash, interests, home };
}

app.http('profile', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'profile',
  handler: handle(async (request) => {
    const p = validate(await readJson(request));
    const userId = p.userId || `u_${crypto.randomBytes(8).toString('hex')}`;
    await db.query(
      `INSERT INTO users (user_id, name, contacts, code_phrase, pin_hash, duress_pin_hash, interests, home)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (user_id) DO UPDATE SET
         name = EXCLUDED.name, contacts = EXCLUDED.contacts, code_phrase = EXCLUDED.code_phrase,
         pin_hash = EXCLUDED.pin_hash, duress_pin_hash = EXCLUDED.duress_pin_hash,
         interests = EXCLUDED.interests, home = EXCLUDED.home, updated_at = now()`,
      [userId, p.name, JSON.stringify(p.contacts), p.codePhrase, p.pinHash, p.duressPinHash,
       p.interests, p.home && JSON.stringify(p.home)],
    );
    return json(200, { user_id: userId });
  }),
});
