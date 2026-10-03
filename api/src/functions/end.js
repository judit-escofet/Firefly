// POST /api/walks/{walk_id}/end  {"reason": "arrived" | "stopped", "ts"?: ISO}
// arrived = same as the arrived event (texts "home safe"); stopped = close quietly.
const { app } = require('../../lib/router');
const { handle, readJson, json, badRequest, requireWalkId, optionalTs } = require('../../lib/http');
const { loadWalk, markArrived, endQuietly, logEvent } = require('../../lib/walks');

app.http('end', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'walks/{walk_id}/end',
  handler: handle(async (request, context) => {
    const walkId = requireWalkId(request);
    const body = await readJson(request);
    if (body.reason !== 'arrived' && body.reason !== 'stopped') {
      throw badRequest('reason must be "arrived" or "stopped"');
    }
    const ts = optionalTs(body.ts);
    const walk = await loadWalk(walkId);

    const outcome = body.reason === 'arrived'
      ? await markArrived(walk, { log: context })
      : await endQuietly(walk, { log: context });

    await logEvent(walkId, { ts, type: body.reason === 'arrived' ? 'arrived' : 'walk_stopped', texted: outcome.texted });
    return json(200, {
      ok: true,
      notified: outcome.texted,
      walk_id: walkId,
      status: body.reason === 'arrived' ? 'home_safe' : 'ended',
      ...outcome,
    });
  }),
});
