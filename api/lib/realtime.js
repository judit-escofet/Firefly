// Live updates over an API Gateway WebSocket API.
// A tracking page connects to WS_URL?token=<share_token>; src/ws.js checks the token and stores
// (connection_id, walk_id) in Tiger Data, so a page only ever receives its own walk's messages.
const db = require('../db');

let client;

function getClient() {
  if (!process.env.WS_MANAGEMENT_URL) return null;
  if (!client) {
    const { ApiGatewayManagementApiClient } = require('@aws-sdk/client-apigatewaymanagementapi');
    client = new ApiGatewayManagementApiClient({ endpoint: process.env.WS_MANAGEMENT_URL });
  }
  return client;
}

// Never throws: a missed push must not fail the walker's request. The page also polls as a fallback.
async function pushToWalk(walkId, message, log = console) {
  const api = getClient();
  if (!api) {
    log.warn(`[realtime mock] walk ${walkId} <- ${JSON.stringify(message)}`);
    return false;
  }
  try {
    const { PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
    const { rows } = await db.query('SELECT connection_id FROM ws_connections WHERE walk_id = $1', [walkId]);
    const data = Buffer.from(JSON.stringify(message));
    await Promise.all(rows.map(async ({ connection_id: id }) => {
      try {
        await api.send(new PostToConnectionCommand({ ConnectionId: id, Data: data }));
      } catch (err) {
        if (err.name === 'GoneException' || (err.$metadata && err.$metadata.httpStatusCode === 410)) {
          await db.query('DELETE FROM ws_connections WHERE connection_id = $1', [id]);
        } else {
          log.error(`WebSocket push to ${id} failed: ${err.message}`);
        }
      }
    }));
    return true;
  } catch (err) {
    log.error(`WebSocket push failed: ${err.message}`);
    return false;
  }
}

// URL the tracking page opens. The token is checked again when it connects.
function clientUrlForWalk(shareToken) {
  if (!process.env.WS_URL) return null;
  return `${process.env.WS_URL}?token=${encodeURIComponent(shareToken)}`;
}

module.exports = { pushToWalk, clientUrlForWalk };
