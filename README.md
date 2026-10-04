# Firefly

**Walk home with someone.** Firefly is a voice companion for the walk home at night. It chats with you the whole way, shows you the route, and quietly watches out for you. If something goes wrong, it gets you help without anyone nearby noticing.

Built for GirlHacks 2026 by Team Firefly.

## What it does

- **Someone to talk to.** A firefly companion listens and talks back in a warm, natural voice. It remembers your last walk and brings up the news you care about.
- **Google Maps-style directions.** Walking routes follow real streets (OpenStreetMap), with a turn banner, spoken turns, ETA and distance in miles, and automatic rerouting.
- **A secret phrase.** Say your code phrase (for example *"i think i left the oven on"*) and a quiet 10-second countdown starts. It looks like a plain lock screen.
- **Scream and distress detection.** An on-device model (YAMNet plus a trained head) listens for screams. Phrases like "help me" also start the countdown.
- **One PIN, two outcomes.** The right PIN cancels the countdown. Any wrong PIN shows the same "All good, enjoy your walk" screen, but help is called silently. Someone forcing you to cancel can't tell the difference.
- **Contacts kept in the loop.** Trusted contacts get a text with a live tracking link when you start, an alert with your location and an audio clip if something happens, and a "home safe" text when you arrive.
- **Simulated 911.** When the countdown runs out, or you tap **Call 911**, Firefly calls a demo dispatcher with a spoken report, then connects you through the app. It **never calls real 911**: the demo number 312-826-2020 stands in for it, and the code refuses 911 and other N11 numbers.

## How it fits together

```
 phone browser (app/)                                       server (api/), one AWS Lambda
┌──────────────────────────────────────────────┐            ┌──────────────────────────────────┐
│ screens, walk lifecycle, map, navigation (P4)│  /api/*    │ profiles, walks, location        │
│ companion: listen, talk, check in       (P1) │──────────▶ │ alerts, texts, clips   (P3)      │
│ guardian: scream model, code phrase,         │            │ companion replies + voice (P1)   │
│           countdown state machine       (P2) │ ◀────────  │ routes, geocoding, dispatch call │
│        all talk through src/bus.js           │  live      │ tracking page /track/{token}     │
└──────────────────────────────────────────────┘            └──────────────────────────────────┘
                                                                 │        │        │
                                     Tiger Data (Postgres)  Gemini +   Twilio / Vonage
                                                            ElevenLabs  (texts, calls)
```

The app's modules never call each other directly. They publish and subscribe to events on `app/src/bus.js` (`walk.started`, `position.updated`, `alert.state`, `pin.entered`, `companion.speaking`, `walk.ended`, …).

## Repository

| Path | What's there |
| --- | --- |
| [`app/`](app/README.md) | React + Vite + Tailwind web app: screens, walk lifecycle, map, navigation, PIN, dispatch call |
| [`app/src/companion/`](app/src/companion/README.md) | P1, the companion: speech-to-text, replies, voice, check-ins |
| [`app/src/guardian/`](app/src/guardian/README.md) | P2, the guardian: scream model, code phrase, distress words, countdown state machine |
| [`api/`](README-P3.md) | P3, the Node backend: walks, alerts, texts, clips, routes, companion endpoints, dispatch calls |
| `api/db/` | Postgres schema and migration (Tiger Data) |
| [`contracts/mock-api/`](contracts/mock-api/README.md) | Sample API responses the app was built against |
| [`ml/`](ml/README.md) | Training and honest evaluation of the scream classifier |
| `deploy/aws/deploy.sh` | Deploys the app and API together as one Lambda with an HTTPS function URL |
| `deploy-aws.ps1`, `deploy-workshop.ps1`, `deploy.ps1`, `template.yaml` | Other ways to deploy (Windows wrapper, sandbox, full SAM stack) |
| `presentation/` | The looping pitch video (`slides.html` → `render.py` → `firefly-loop.mp4`) |
| `firefly-architecture.drawio` | Architecture diagram |

## Quick start

You need Node 20 or newer.

**Try it with no keys at all (demo mode):**

```bash
cd app
npm install
npm run dev:local
```

Open http://localhost:5173/?mock=1 and tap **Try the demo**. Everything runs on the device: a simulated walk at walking speed, canned companion lines with a pre-recorded voice, and the real guardian. The demo profile is Priya, code phrase *"i think i left the oven on"*, PIN **1234**. The **Demo** drawer at the top right can jump ahead, arrive home, say the code phrase, or fake a scream.

**Run the full stack locally:**

```bash
cd api
npm install
cp local.settings.example.json local.settings.json   # then fill in your keys
npm start                                            # API on http://localhost:4280
```

```bash
cd app
npm run dev:local    # http://localhost:5173, proxies /api to :4280
```

**On a phone:** run `npm run dev` instead (HTTPS, needed for the mic). Join the same Wi-Fi, open `https://<laptop-ip>:5173`, and accept the certificate warning.

## Configuration

Keys go in `api/local.settings.json`, which is git-ignored. Never commit it. Everything is optional; whatever is missing falls back to logging or local storage.

| Setting | Used for |
| --- | --- |
| `TIGER_DATABASE_URL` | Postgres for profiles, walks, events and memories. Run `npm run migrate` in `api/` once. |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Companion replies and transcription |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | The firefly's voice |
| `TWILIO_*` | Texts to contacts (and calls if Vonage isn't set up) |
| `VONAGE_APPLICATION_ID`, `VONAGE_PRIVATE_KEY`, `VONAGE_FROM_NUMBER` | In-app and automated dispatch calls. Set them up with `node scripts/setup-vonage.js`. |
| `DISPATCH_NUMBER` | The stand-in for 911 (default 312-826-2020). Real emergency numbers are refused. |
| `OSM_ROUTES=0`, `MOCK_MAPS=1` | Turn off street routing, or use straight-line routes |

## Deploy

The hackathon deployment is one Lambda behind an HTTPS function URL. It serves the built app, the API and the tracking page from the same origin, so the mic and `/api` work on phones.

```bash
FIREFLY_ROLE=DemoToolLambdaRole ./deploy/aws/deploy.sh    # from Git Bash
```

On Windows, `deploy-aws.ps1` wraps the same steps. The script copies `api/local.settings.json` into the Lambda's settings and merges them with what's already there. `--teardown` removes everything. For a normal AWS account with WebSockets, S3 and Amazon Location, see the SAM setup in [README-P3.md](README-P3.md).

## Tests

```bash
cd api && npm test     # routes, alerts, texts, dispatch safety, companion shaping
cd app && npm test     # bus, PIN hashing, route math, navigation, companion, guardian
```

## Safety and privacy notes

- Firefly never dials real 911. For the demo, every emergency call goes to 312-826-2020.
- PINs are hashed in the browser (SHA-256, salted with the user id). The server never sees them.
- The scream model runs entirely on the phone. Audio only leaves the device as a 15-second clip, and only when an alert fires. Clip links expire after 24 hours.
- Tracking links expire when the walk ends. Unknown and expired links both return 410, so tokens can't be probed.
- The countdown screen avoids red and alarming words, and the companion keeps chatting normally during an alert, so nothing nearby gives it away.
