// POST /api/walks/{walk_id}/scores — up to 200 Guardian scream scores per call, one INSERT.
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

    const ts = [], values = [], labels = [];
    scores.forEach((s, i) => {
      if (!s || typeof s !== 'object') throw badRequest(`scores[${i}] must be an object`);
      if (!isNum(s.score)) throw badRequest(`scores[${i}].score must be a number`);
      const t = new Date(s.ts);
      if (typeof s.ts !== 'string' || Number.isNaN(t.getTime())) throw badRequest(`scores[${i}].ts must be an ISO timestamp`);
      if (s.label != null && typeof s.label !== 'string') throw badRequest(`scores[${i}].label must be a string`);
      ts.push(t.toISOString());
      values.push(s.score);
      labels.push(s.label ?? null);
    });

    const { rowCount } = await db.query(
      `INSERT INTO detector_scores (ts, walk_id, score, label)
       SELECT t, $2, s, l FROM unnest($1::timestamptz[], $3::real[], $4::text[]) AS u(t, s, l)`,
      [ts, walkId, values, labels],
    );
    return json(200, { saved: rowCount });
  }),
});
