# Firefly P3: Walk and Alerts (AWS)

The backend for walks, plus the contacts' tracking page. It runs on AWS Lambda, deployed with one SAM template.

```
template.yaml                    all AWS infrastructure (SAM)
api/
  src/lambda.js                  HTTP API entry: /api/* and /track/{token}
  src/ws.js                      WebSocket entry: $connect / $disconnect / $default
  src/functions/*.js             one file per endpoint group
  lib/router.js                  tiny router (app.http(...) style)
  lib/geo.js                     off-route / remaining / ETA / near-home math (pure, unit-tested)
  lib/walks.js                   texts, 60 s alert guard, arrive / stop, events log
  lib/maps.js                    Amazon Location pedestrian routes
  lib/storage.js                 S3 clips + 24-hour links
  lib/realtime.js                WebSocket pushes
  lib/sms.js, lib/http.js
  db/schema.sql, db/index.js, db/migrate.js   Tiger Data
  local-server.js                local dev server
  test/                          20 tests, no cloud needed
app/public/track/index.html      tracking page (single file, no keys)
contracts/mock-api/              sample responses for P4
```

## What runs where

| Piece | AWS service |
|---|---|
| API + tracking page | One Lambda behind an API Gateway HTTP API (CORS open, so P4's app can call it from anywhere) |
| Live updates | API Gateway WebSocket API. Connections are stored in Tiger Data (`ws_connections`). |
| Walking routes | Amazon Location Service Routes (pedestrian). Uses the Lambda's IAM role, so no key. |
| Alert clips | Private S3 bucket; objects are deleted after 2 days |
| Map on the tracking page | OpenStreetMap tiles (no key) |
| Database, texts | Tiger Data, Twilio (unchanged) |

## Endpoints

| Method | Route | Notes |
|---|---|---|
| POST | /api/profile | `{user_id?, name, contacts:[{name, phone:"+1..."}], code_phrase, pin_hash, duress_pin_hash}` → `{user_id}` |
| POST | /api/walks | `{user_id, start:{lat,lng}, destination:{lat,lng,label}}` → Walk JSON (201), texts contacts |
| POST | /api/walks/{id}/location | `{lat, lng, accuracy_m, ts}` → `{remaining_m, eta_s, on_route, off_route_m, near_destination}` |
| POST | /api/walks/{id}/events | `{type, source?, confidence?, clip_url?, ts}` → `{saved, texted:[phones], duplicate?}` |
| GET  | /api/walks/{id}/events?token= | events log for the demo (phones masked) |
| POST | /api/walks/{id}/scores | `{scores:[{ts, score, label?}]}` (≤200) → `{saved:n}` |
| POST | /api/walks/{id}/clip | raw body, `Content-Type: audio/webm` or `audio/wav`, ≤2 MB, ≤15 s; for webm send `X-Clip-Duration` → `{clip_url, expires_at}` |
| GET  | /api/clips/{id}/{file} | the clip link: redirects to S3 for 24 hours, then 410 |
| POST | /api/walks/{id}/end | `{reason:"arrived"\|"stopped"}` |
| GET  | /api/negotiate?token= | WebSocket URL for that walk |
| GET  | /api/track/{share_token} | snapshot for the tracking page; 410 `link expired` |
| GET  | /track/{share_token} | the tracking page itself |

Messages sent to tracking pages: `position`, `status` (`alert` / `home_safe` / `ended`), `clip`. See `contracts/mock-api/live-messages.json`.

**Lambda payload limit:** API Gateway caps request bodies at 10 MB, so the 2 MB clip limit fits comfortably.

## Setup

**Tools (once):** install the [AWS CLI](https://aws.amazon.com/cli/) and the [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html). Then run `aws configure` with an access key from your AWS account (IAM → Users → Security credentials).

**Database (once):** put the Tiger URL in `api/local.settings.json` (copy `local.settings.example.json`), then run the schema:

```
cd api
npm install
npm run migrate
```

**Deploy** (first time, from `api/`):

```
npm run build:page
cd ..
sam build
sam deploy --guided
```

`--guided` asks for:
- **Stack name:** `firefly`
- **Region:** `us-east-1` is a safe choice, since Amazon Location Routes is available there.
- **TigerDatabaseUrl:** the full URL, with the password.
- **Twilio settings:** leave them blank to log texts instead.
- **"ApiFunction has no authentication. Is this okay?":** answer `y`.

It saves your answers to `samconfig.toml` (git-ignored, because it holds the password). Later deploys are just `npm run build:page`, then `sam build`, then `sam deploy`.

The `AppUrl` output is your app's base URL. Give it to P4: the API lives at `AppUrl/api/...`, and tracking links look like `AppUrl/track/...`.

**Run locally:** `cd api && npm start` serves http://localhost:4280. Routes are straight lines (`MOCK_MAPS=1`), texts and live pushes are logged, and the tracking page polls every 3 s instead of using the WebSocket.

## Hosting options

The same code runs these ways:

| Where | How | Notes |
|---|---|---|
| Normal AWS account | `deploy.ps1` (SAM) | Full setup: WebSocket live updates, Amazon Location routes, S3 clips |
| **AWS Workshop Studio sandbox, whole app (use this)** | `deploy/aws/deploy.sh` (the team's) | App + API + tracking page on one Lambda URL. Run from Git Bash with `FIREFLY_ROLE=DemoToolLambdaRole`; it copies `api/local.settings.json` into the Lambda |
| AWS Workshop Studio sandbox, API only | `deploy-workshop.ps1` | That sandbox blocks CloudFormation, API Gateway, Amazon Location and S3, so it uses a Lambda function URL, straight-line routes and clips stored in Tiger Data, and the page polls every 3 s |

## Tests

```
cd api && npm test
```

29 tests:
- route math on a hand-made L-shaped route (W4, W5)
- validation 400s (W1)
- the exact alert text and the 60 s guard (W6)
- link expiry (W10)
- the router

## Design decisions to confirm with the team

- **Walk JSON shape** and the users / memories / conversation_turns columns. I didn't have the team plan, so check `lib/walks.js#walkJson` and `db/schema.sql` against it.
- **Clip links** point at `/api/clips/...` rather than straight at S3. An S3 link signed by Lambda dies when the Lambda's temporary credentials do, often in under 24 hours. The endpoint enforces exactly 24 hours instead.
- **Duplicate guard** is one atomic `UPDATE ... WHERE last_alert_at < now() - 60s`, so it holds across Lambda instances. Duplicates are still logged, just not texted.
- **An alert on a closed walk reopens it.** Dropping an alert because the walk looked finished seemed like the worse failure.
- **on_route** means within 50 m, widened up to 150 m when the phone reports poor GPS accuracy.
- **Unknown token and expired walk both return 410**, so tokens can't be probed.
- The **Call 911** button is a real `tel:911` link. Don't tap it during the demo.
- **P1's endpoints** go in `api/src/functions/` using the same `app.http(...)` style (see any existing file). They're picked up automatically.
