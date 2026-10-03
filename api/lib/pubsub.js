// Web PubSub: one group per walk. A tracking page can join only its own walk's group.
const { WebPubSubServiceClient } = require('@azure/web-pubsub');

let service;
const hub = () => process.env.WEBPUBSUB_HUB || 'firefly';
const groupName = (walkId) => `walk_${walkId}`;

function getService() {
  if (!process.env.WEBPUBSUB_CONNECTION_STRING) return null;
  if (!service) service = new WebPubSubServiceClient(process.env.WEBPUBSUB_CONNECTION_STRING, hub());
  return service;
}

// Never throws: a missed push must not fail the walker's request. The page also polls as a fallback.
async function pushToWalk(walkId, message, log = console) {
  const svc = getService();
  if (!svc) {
    log.warn(`[pubsub mock] ${groupName(walkId)} <- ${JSON.stringify(message)}`);
    return false;
  }
  try {
    await svc.group(groupName(walkId)).sendToAll(message);
    return true;
  } catch (err) {
    log.error(`Web PubSub push failed: ${err.message}`);
    return false;
  }
}

// Client URL that auto-joins, and may only join, this walk's group. No send roles: listen only.
async function clientUrlForWalk(walkId, minutes = 120) {
  const svc = getService();
  if (!svc) return null;
  const group = groupName(walkId);
  const token = await svc.getClientAccessToken({
    groups: [group],
    roles: [`webpubsub.joinLeaveGroup.${group}`],
    expirationTimeInMinutes: minutes,
  });
  return token.url;
}

module.exports = { pushToWalk, clientUrlForWalk, groupName };
