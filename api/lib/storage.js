// Alert clips in a private S3 bucket (CLIPS_BUCKET).
//
// Why not a 24-hour presigned URL: a URL signed with the Lambda role's temporary credentials dies
// when those credentials expire, often well before 24 hours. Instead the clip link points at
// GET /api/clips/{walk_id}/{file}. The file name is random and unguessable; that endpoint checks
// the 24-hour limit against the upload time and redirects to a fresh 5-minute S3 link.
const crypto = require('crypto');

const LINK_HOURS = 24;
let s3;

function client() {
  if (!process.env.CLIPS_BUCKET) throw new Error('CLIPS_BUCKET is not set');
  if (!s3) {
    const { S3Client } = require('@aws-sdk/client-s3');
    s3 = new S3Client({});
  }
  return s3;
}

async function uploadClip(walkId, ext, buffer, contentType, base) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const file = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  await client().send(new PutObjectCommand({
    Bucket: process.env.CLIPS_BUCKET,
    Key: `${walkId}/${file}`,
    Body: buffer,
    ContentType: contentType,
  }));
  return {
    url: `${base}/api/clips/${walkId}/${file}`,
    expiresOn: new Date(Date.now() + LINK_HOURS * 3600 * 1000),
  };
}

// Returns a short-lived S3 URL, or null when the clip is missing or older than 24 hours.
async function clipRedirectUrl(walkId, file) {
  const { HeadObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  const Key = `${walkId}/${file}`;
  let head;
  try {
    head = await client().send(new HeadObjectCommand({ Bucket: process.env.CLIPS_BUCKET, Key }));
  } catch (err) {
    if (err.name === 'NotFound' || (err.$metadata && err.$metadata.httpStatusCode === 404)) return null;
    throw err;
  }
  if (Date.now() - head.LastModified.getTime() > LINK_HOURS * 3600 * 1000) return null;
  return getSignedUrl(client(), new GetObjectCommand({ Bucket: process.env.CLIPS_BUCKET, Key }), { expiresIn: 300 });
}

module.exports = { uploadClip, clipRedirectUrl, LINK_HOURS };
