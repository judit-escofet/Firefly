// Alert clips. Two backends, same links:
//   - S3 (when CLIPS_BUCKET is set, i.e. on AWS): private bucket.
//   - Tiger Data (otherwise, e.g. on Render or locally): a `clips` table. Clips are at most 2 MB.
//
// Either way the clip link is GET /api/clips/{walk_id}/{file}. The file name is random and
// unguessable, and that endpoint enforces the 24-hour limit itself. (A 24-hour S3 presigned URL
// isn't reliable on Lambda: it dies when the function's temporary credentials expire.)
const crypto = require('crypto');
const db = require('../db');

const LINK_HOURS = 24;
const LINK_MS = LINK_HOURS * 3600 * 1000;
let s3;

const useS3 = () => !!process.env.CLIPS_BUCKET;

function s3Client() {
  if (!s3) {
    const { S3Client } = require('@aws-sdk/client-s3');
    s3 = new S3Client({});
  }
  return s3;
}

async function uploadClip(walkId, ext, buffer, contentType, base) {
  const file = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  if (useS3()) {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await s3Client().send(new PutObjectCommand({
      Bucket: process.env.CLIPS_BUCKET, Key: `${walkId}/${file}`, Body: buffer, ContentType: contentType,
    }));
  } else {
    await db.query(
      'INSERT INTO clips (walk_id, file, content_type, data) VALUES ($1, $2, $3, $4)',
      [walkId, file, contentType, buffer],
    );
    await db.query("DELETE FROM clips WHERE created_at < now() - INTERVAL '2 days'");
  }
  return { url: `${base}/api/clips/${walkId}/${file}`, expiresOn: new Date(Date.now() + LINK_MS) };
}

// Returns { redirect } (S3), { body, contentType } (database), or null if missing or over 24 hours old.
async function getClip(walkId, file) {
  if (!useS3()) {
    const { rows } = await db.query(
      'SELECT content_type, data, created_at FROM clips WHERE walk_id = $1 AND file = $2',
      [walkId, file],
    );
    if (!rows[0] || Date.now() - new Date(rows[0].created_at).getTime() > LINK_MS) return null;
    return { body: rows[0].data, contentType: rows[0].content_type };
  }

  const { HeadObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  const Key = `${walkId}/${file}`;
  let head;
  try {
    head = await s3Client().send(new HeadObjectCommand({ Bucket: process.env.CLIPS_BUCKET, Key }));
  } catch (err) {
    if (err.name === 'NotFound' || (err.$metadata && err.$metadata.httpStatusCode === 404)) return null;
    throw err;
  }
  if (Date.now() - head.LastModified.getTime() > LINK_MS) return null;
  const redirect = await getSignedUrl(s3Client(), new GetObjectCommand({ Bucket: process.env.CLIPS_BUCKET, Key }), { expiresIn: 300 });
  return { redirect };
}

module.exports = { uploadClip, getClip, LINK_HOURS };
