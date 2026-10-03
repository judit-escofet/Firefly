// AWS Lambda for the WebSocket API ($connect, $disconnect, $default).
// $connect accepts only a live share token and records which walk the connection follows.
const db = require('../db');
const { loadWalkByToken, linkIsLive } = require('../lib/walks');

exports.handler = async (event) => {
  const { routeKey, connectionId } = event.requestContext;
  try {
    if (routeKey === '$connect') {
      const token = event.queryStringParameters && event.queryStringParameters.token;
      const walk = await loadWalkByToken(token);
      if (!linkIsLive(walk)) return { statusCode: 403, body: 'link expired' };
      await db.query(
        `INSERT INTO ws_connections (connection_id, walk_id) VALUES ($1, $2)
         ON CONFLICT (connection_id) DO UPDATE SET walk_id = EXCLUDED.walk_id`,
        [connectionId, walk.walk_id],
      );
      return { statusCode: 200, body: 'connected' };
    }
    if (routeKey === '$disconnect') {
      await db.query('DELETE FROM ws_connections WHERE connection_id = $1', [connectionId]);
      return { statusCode: 200, body: 'bye' };
    }
    // $default: the page sends {"action":"ping"} every few minutes to beat the 10-minute idle timeout.
    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: 'error' };
  }
};
