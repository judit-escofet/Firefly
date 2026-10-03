// POST /api/walks/{walk_id}/clip — raw audio body (Content-Type audio/webm or audio/wav),
// max 2 MB and 15 s. Stored privately; returns a read-only link that expires in 24 hours.
//
// Duration: read from the WAV header. WebM has no cheap header duration, so the client sends
// X-Clip-Duration (seconds) or ?duration_s=; without it, the 2 MB cap still bounds the clip.
const { app } = require('@azure/functions');
const db = require('../../db');
const { uploadClip } = require('../../lib/blob');
const { pushToWalk } = require('../../lib/pubsub');
const { handle, json, badRequest, notFound, requireWalkId } = require('../../lib/http');

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_SECONDS = 15;
const TYPES = {
  'audio/webm': 'webm', 'video/webm': 'webm',
  'audio/wav': 'wav', 'audio/wave': 'wav', 'audio/x-wav': 'wav', 'audio/vnd.wave': 'wav',
};

function wavDurationSeconds(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw badRequest('Body is not a valid WAV file');
  }
  let offset = 12, byteRate = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ') byteRate = buf.readUInt32LE(offset + 16);
    if (id === 'data') {
      if (!byteRate) throw badRequest('WAV file has no format header');
      const dataSize = Math.min(size, buf.length - offset - 8);
      return dataSize / byteRate;
    }
    offset += 8 + size + (size % 2);
  }
  throw badRequest('WAV file has no audio data');
}

app.http('clip', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'walks/{walk_id}/clip',
  handler: handle(async (request, context) => {
    const walkId = requireWalkId(request);
    const contentType = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const ext = TYPES[contentType];
    if (!ext) throw badRequest('Content-Type must be audio/webm or audio/wav');

    const declared = Number(request.headers.get('content-length') || 0);
    if (declared > MAX_BYTES) throw badRequest('Clip is larger than 2 MB');
    const buf = Buffer.from(await request.arrayBuffer());
    if (buf.length === 0) throw badRequest('Clip is empty');
    if (buf.length > MAX_BYTES) throw badRequest('Clip is larger than 2 MB');

    let seconds;
    if (ext === 'wav') {
      seconds = wavDurationSeconds(buf);
    } else {
      if (buf.length < 4 || buf.readUInt32BE(0) !== 0x1a45dfa3) throw badRequest('Body is not a valid WebM file');
      const hint = request.headers.get('x-clip-duration') ?? request.query.get('duration_s');
      seconds = hint == null ? null : Number(hint);
      if (hint != null && !Number.isFinite(seconds)) throw badRequest('X-Clip-Duration must be a number of seconds');
    }
    if (seconds != null && seconds > MAX_SECONDS + 0.5) throw badRequest('Clip is longer than 15 seconds');

    const { rows } = await db.query('SELECT status FROM walks WHERE walk_id = $1', [walkId]);
    if (!rows[0]) throw notFound('Walk not found');

    const { url, expiresOn } = await uploadClip(`${walkId}/${Date.now()}.${ext}`, buf, contentType);

    // The newest clip becomes the one the tracking page plays.
    await db.query('UPDATE walks SET clip_url = $2 WHERE walk_id = $1', [walkId, url]);
    if (rows[0].status === 'alert') await pushToWalk(walkId, { type: 'clip', clip_url: url }, context);

    return json(201, { clip_url: url, expires_at: expiresOn.toISOString() });
  }),
});
