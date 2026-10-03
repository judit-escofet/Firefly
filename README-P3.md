# Firefly P3: Walk and Alerts

Backend for walks (Azure Functions, Node, v4 programming model) plus the contacts' tracking page.

```
api/
  db/schema.sql        Tiger Data schema: tables, hypertables, continuous aggregates, retention
  db/index.js          shared pg pool (P1 uses this too)
  db/migrate.js        applies schema.sql
  lib/geo.js           off-route / remaining / ETA / near-home math (pure, unit-tested)
  lib/walks.js         texts, 60 s alert guard, arrive / stop, events log
  lib/{maps,sms,pubsub,blob,http}.js
  src/functions/*.js   one file per endpoint group
  test/                geo + handler tests (no cloud services needed)
app/public/track/index.html      tracking page (single file, no keys)
app/public/staticwebapp.config.json   /track/* -> tracking page
contracts/mock-api/              sample responses for P4
```

## Endpoints

| Method | Route | Notes |
|---|---|---|
| POST | /api/profile | `{user_id?, name, contacts:[{name, phone:"+1..."}], code_phrase, pin_hash, duress_pin_hash}` → `{user_id}` |
| POST | /api/walks | `{user_id, start:{lat,lng}, destination:{lat,lng,label}}` → Walk JSON (201), texts contacts |
| POST | /api/walks/{id}/location | `{lat, lng, accuracy_m, ts}` → `{remaining_m, eta_s, on_route, off_route_m, near_destination}` |
| POST | /api/walks/{id}/events | `{type, source?, confidence?, clip_url?, ts}` → `{saved, texted:[phones], duplicate?}` |
| GET  | /api/walks/{id}/events?token= | events log for the demo (phones masked) |
| POST | /api/walks/{id}/scores | `{scores:[{ts, score, label?}]}` (≤200) → `{saved:n}` |
| POST | /api/walks/{id}/clip | raw body, `Content-Type: audio/webm` or `audio/wav`, ≤2 MB, ≤15 s; webm: send `X-Clip-Duration` → `{clip_url, expires_at}` |
| POST | /api/walks/{id}/end | `{reason:"arrived"\|"stopped"}` |
| GET  | /api/negotiate?token= | Web PubSub URL that can only join this walk's group |
| GET  | /api/track/{share_token} | snapshot for the tracking page; 410 `link expired` |
| GET  | /api/tiles/{z}/{x}/{y} | Azure Maps tile proxy, so the key never reaches the browser |

Web PubSub messages to group `walk_{walk_id}`: `position`, `status` (`alert` / `home_safe` / `ended`), `clip`. See `contracts/mock-api/pubsub-messages.json`.

## Setup (hour 0–1)

1. Create the Tiger Data service, then: `cd api && npm install && TIGER_DATABASE_URL=... node db/migrate.js`
2. Copy `api/local.settings.example.json` to `api/local.settings.json` (git-ignored) and fill it in. In Azure, put the same keys in the Static Web App's environment variables. Also set `PUBLIC_BASE_URL` to the app's https URL so share links are right.
3. Twilio trial: verify all four teammates' phones.
4. Run locally: `npx @azure/static-web-apps-cli start app/public --api-location api` (serves on :4280).

**Mock modes.** Leave a setting blank and that piece logs instead of calling out: no `TWILIO_*` means texts are logged; no `AZURE_MAPS_KEY` (or `MOCK_MAPS=1`) gives a straight-line route (the demo fallback); no `WEBPUBSUB_*` means pushes are logged and the page falls back to polling every 10 s.

## Tests

```
cd api && npm test
```

18 tests: route math on a hand-made L-shaped route (W4, W5), validation 400s (W1), exact alert text plus the 60 s guard (W6), link expiry (W10).

## Design decisions to confirm with the team

- **Walk JSON shape** and the users/memories/conversation_turns columns: I didn't have the team plan, so check `lib/walks.js#walkJson` and `db/schema.sql` against it.
- **Duplicate guard** is one atomic `UPDATE ... WHERE last_alert_at < now() - 60s`, so it holds across Function instances. Duplicates are still logged, just not texted.
- **An alert on a closed walk reopens it** (status `alert`, link live again). Dropping an alert because the walk looked finished seemed like the worse failure.
- **on_route** means within 50 m, widened up to 150 m when the phone reports poor GPS accuracy. Pings with accuracy worse than 50 m are stored but left out of the speed average. Speed is clamped to 0.3–3 m/s, falling back to 1.3.
- **Unknown token and expired walk both return 410**, so tokens can't be probed.
- The **Call 911** button is a real `tel:911` link. Don't tap it during the demo.
