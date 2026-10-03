# Mock API (P3)

Fixed sample responses for every P3 endpoint, so the app can be built before the Functions exist.
They match the real responses field for field; update them whenever a real response changes.

| File | Endpoint |
|---|---|
| profile.post.json | POST /api/profile |
| walks.post.json | POST /api/walks (201) |
| location.post.json | POST /api/walks/{walk_id}/location |
| events.post.json | POST /api/walks/{walk_id}/events (alert_sent / duress) |
| events-duplicate.post.json | same, second alert inside 60 s |
| events-arrived.post.json | same, arrived |
| scores.post.json | POST /api/walks/{walk_id}/scores |
| clip.post.json | POST /api/walks/{walk_id}/clip (201) |
| end.post.json | POST /api/walks/{walk_id}/end |
| negotiate.get.json | GET /api/negotiate?token= |
| track.get.json | GET /api/track/{share_token} |
| error.400.json | any bad input |
| pubsub-messages.json | messages pushed to the tracking page's Web PubSub group |
