// POST /api/walks/{walk_id}/scores — up to 200 Guardian scream scores per call, one INSERT.
// Body (team plan): {"scores": [{"ts": "...", "scream_score": 0.12, "triggered": false}]}
// Also accepted: {"score": 0.12, "label": "..."} (this endpoint's original field names).
const { app } = require('../../lib/router');
const db = require('../../db');
const { handle, readJson, json, badRequest, requireWalkId, isNum } = require('../../lib/http');

const MAX_SCORES = 200;

app.http('scores', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'walks/{walk_id}/scores',
  handler: handle(async (request) => {
    const walkId = requireWalkId(request);
    const { scores } = await readJson(request);
    if (!Array.isArray(scores) || scores.length === 0) throw badRequest('scores must be a non-empty list');
    if (scores.length > MAX_SCORES) throw badRequest(`At most ${MAX_SCORES} scores per call`);

    const ts = [], values = [], triggered = [], labels = [];
    scores.forEach((s, i) => {
      if (!s || typeof s !== 'object') throw badRequest(`scores[${i}] must be an object`);
      const value = s.scream_score ?? s.score;
      if (!isNum(value)) throw badRequest(`scores[${i}].scream_score must be a number`);
      const t = new Date(s.ts);
      if (typeof s.ts !== 'string' || Number.isNaN(t.getTime())) throw badRequest(`scores[${i}].ts must be an ISO timestamp`);
      if (s.triggered != null && typeof s.triggered !== 'boolean') throw badRequest(`scores[${i}].triggered must be true or false`);
      if (s.label != null && typeof s.label !== 'string') throw badRequest(`scores[${i}].label must be a string`);
      ts.push(t.toISOString());
      values.push(value);
      triggered.push(s.triggered ?? s.label === 'triggered');
      labels.push(s.label ?? null);
    });

    const { rowCount } = await db.query(
      `INSERT INTO detector_scores (ts, walk_id, score, triggered, label)
       SELECT t, $2, s, g, l FROM unnest($1::timestamptz[], $3::real[], $4::boolean[], $5::text[]) AS u(t, s, g, l)`,
      [ts, walkId, values, triggered, labels],
    );
    return json(200, { saved: rowCount });
  }),
});
