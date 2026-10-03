// Walk lifecycle shared by /walks, /events and /end: loading, texts, alert guard, closing.
const db = require('../db');
const { textAll } = require('./sms');
const { pushToWalk } = require('./realtime');
const { notFound } = require('./http');

const ALERT_DEDUP_SECONDS = 60;
const LINK_TTL_AFTER_END_MS = 2 * 3600 * 1000;

const messages = {
  started: (name, url) => `${name} started walking home with Firefly. Follow along: ${url}`,
  // Identical for alert_sent and duress, so a duress alert is indistinguishable.
  alert: (name, url) =>
    `Firefly alert: ${name} may need help. Live location: ${url}\n` +
    `She's been asked to stay on the line. If you think she's in danger, call 911.`,
  homeSafe: (name) => `${name} is home safe.`,
};

const shareUrl = (base, token) => `${base}/track/${token}`;
const phonesOf = (walk) => (walk.contacts || []).map((c) => c.phone);

async function loadWalk(walkId) {
  const { rows } = await db.query(
    `SELECT w.*, u.name, u.contacts
       FROM walks w JOIN users u USING (user_id)
      WHERE w.walk_id = $1`,
    [walkId],
  );
  if (!rows[0]) throw notFound('Walk not found');
  return rows[0];
}

async function loadWalkByToken(token) {
  if (typeof token !== 'string' || token.length < 16 || token.length > 128) return null;
  const { rows } = await db.query(
    `SELECT w.*, u.name FROM walks w JOIN users u USING (user_id) WHERE w.share_token = $1`,
    [token],
  );
  return rows[0] || null;
}

// The tracking link works while the walk is open and for 2 hours after it ends.
function linkIsLive(walk) {
  if (!walk) return false;
  if (!walk.ended_at) return true;
  return Date.now() - new Date(walk.ended_at).getTime() < LINK_TTL_AFTER_END_MS;
}

// Walk JSON returned by POST /api/walks. Keep in sync with the team plan's contract.
function walkJson(w, base) {
  return {
    walk_id: w.walk_id,
    user_id: w.user_id,
    status: w.status,
    share_token: w.share_token,
    share_url: shareUrl(base, w.share_token),
    start: { lat: w.start_lat, lng: w.start_lng },
    destination: { lat: w.dest_lat, lng: w.dest_lng, label: w.dest_label },
    route: {
      points: w.route, // [[lat, lng], ...] as in the team plan
      distance_m: w.distance_m,
      eta_s: w.eta_s,
    },
    started_at: w.started_at,
    ended_at: w.ended_at,
  };
}

// alert_sent / duress. The UPDATE is the 60-second guard: it only matches if no alert went out in
// the last 60 s, and it is atomic, so two simultaneous alerts on different instances can't both pass.
// An alert on a closed walk reopens it; we never drop an alert because the walk looked finished.
async function raiseAlert(walk, { clipUrl, base, log }) {
  const { rows } = await db.query(
    `UPDATE walks
        SET status = 'alert', ended_at = NULL, last_alert_at = now(),
            clip_url = COALESCE($2, clip_url)
      WHERE walk_id = $1
        AND (last_alert_at IS NULL OR last_alert_at < now() - make_interval(secs => $3))
      RETURNING clip_url`,
    [walk.walk_id, clipUrl || null, ALERT_DEDUP_SECONDS],
  );
  if (!rows[0]) return { texted: [], duplicate: true };

  const [texted] = await Promise.all([
    textAll(phonesOf(walk), messages.alert(walk.name, shareUrl(base, walk.share_token)), log),
    pushToWalk(walk.walk_id, { type: 'status', status: 'alert', clip_url: rows[0].clip_url }, log),
  ]);
  return { texted, duplicate: false };
}

// arrived: only the first call closes the walk and texts; repeats are no-ops.
async function markArrived(walk, { log }) {
  const { rowCount } = await db.query(
    `UPDATE walks SET status = 'home_safe', ended_at = now()
      WHERE walk_id = $1 AND ended_at IS NULL`,
    [walk.walk_id],
  );
  if (!rowCount) return { texted: [], already_closed: true };
  const [texted] = await Promise.all([
    textAll(phonesOf(walk), messages.homeSafe(walk.name), log),
    pushToWalk(walk.walk_id, { type: 'status', status: 'home_safe' }, log),
  ]);
  return { texted, already_closed: false };
}

// stopped: close quietly, no texts.
async function endQuietly(walk, { log }) {
  const { rowCount } = await db.query(
    `UPDATE walks SET status = 'ended', ended_at = now()
      WHERE walk_id = $1 AND ended_at IS NULL`,
    [walk.walk_id],
  );
  if (rowCount) await pushToWalk(walk.walk_id, { type: 'status', status: 'ended', message: 'walk ended' }, log);
  return { texted: [], already_closed: !rowCount };
}

async function logEvent(walkId, ev) {
  await db.query(
    `INSERT INTO walk_events (ts, walk_id, type, source, confidence, clip_url, texted, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [ev.ts, walkId, ev.type, ev.source ?? null, ev.confidence ?? null, ev.clip_url ?? null,
     ev.texted ?? [], ev.data ?? null],
  );
}

module.exports = {
  messages, shareUrl, phonesOf, loadWalk, loadWalkByToken, linkIsLive, walkJson,
  raiseAlert, markArrived, endQuietly, logEvent, ALERT_DEDUP_SECONDS,
};
