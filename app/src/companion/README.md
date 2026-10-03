# Companion (P1): the firefly's voice and personality

Keeps her company on the walk: listens (live transcription), talks back warmly (Gemini +
the team's ElevenLabs "firefly" voice), remembers her last walk, brings up news she cares
about, checks in when the Guardian asks, and stays calm and normal-sounding during an alert.

## Run it

```bash
cd api && npm install && npm start       # API on http://localhost:4280 (keys: api/local.settings.json)
cd app && npm run dev:local              # http://localhost:5173 (proxies /api to :4280)
```

`api/local.settings.json` (git-ignored; copy `local.settings.example.json`) needs
`GEMINI_API_KEY` and `ELEVENLABS_API_KEY`. Optional: `ELEVENLABS_VOICE_ID` (defaults to
"Voice 1 - firefly"), `GEMINI_MODEL`, `TIGER_DATABASE_URL` (memories + call record; without it
they go to `api/.data/companion.json`). On a phone: `npm run dev` (HTTPS), same Wi-Fi,
`https://<laptop-ip>:5173`.

The demo page (`index.html`) is a **temporary shell** standing in for P4's app: "Walk with me",
a simulated GPS walk, live captions, the PIN screen. **Walk with test audio ▶** plays a
recorded voice through the real mic pipeline (no microphone needed) and exercises the whole
loop: transcription → reply → code phrase → Guardian countdown.

## For P4

```js
import { startCompanion } from './companion/index.js';
startCompanion(); // once at boot, next to startGuardian()
```

Emit `walk.started` **synchronously inside the "Walk with me" tap**: the companion and the
Guardian open the one shared microphone (`src/audio/micHub.js`) right there; iOS only allows it
inside a user gesture. Glow the firefly on `companion.speaking`.

| Flag / setting | Effect |
| --- | --- |
| `?mock=1` | No network: a "Say something" box types what she says (speech.heard partials + final), canned replies in the pre-generated voice (C12). |
| `localStorage firefly.name`, `firefly.user_id`, `firefly.interests` | Until the setup screen exists (defaults: none, `u_demo`, `music,tech`). |

## Events

Listens: `walk.started`, `position.updated`, `checkin.request`, `alert.state`, `walk.ended`,
`speech.heard` (its own, and the mock's).

| Emits | Payload | When |
| --- | --- | --- |
| `speech.heard` | `text`, `final` | every partial (~0.5 s while she talks) and every final (~0.2 s after she stops) |
| `checkin.answered` | `ok` (true/false/null), `text` | within ~1 s of her answer; `null` after 20 s of silence |
| `companion.speaking` | `on`, `text` | when a line starts/stops (text = caption) |

## How it works

| Piece | What |
| --- | --- |
| `stt.js` | Shared mic → 100 ms PCM16 chunks → Gemini Live `gemini-3.5-transcribe-live` over a WebSocket, authorised by a single-use token from `/api/speech-token` (the key stays on the server). Reconnects before the 10-min session limit. Her code phrase is passed as custom vocabulary. |
| `echo.js` | The firefly's voice coming back through a phone speaker is dropped (C4). Everything else she says — **including while the firefly talks** — goes out as `speech.heard`, so the Guardian always hears the code phrase; the firefly stops talking (barge-in). |
| `brain.js` | Turn-taking (reply after ~1.2 s of silence; the request starts speculatively at her final words), idle topic after 45 s (C5), news at most every 3 min (C6), check-ins (keywords first, the model only if unclear), calm mode during an alert. |
| `voice.js` | Pre-generated lines (`public/voice/`, `scripts/gen-voice-lines.mjs`) or `/api/companion/speak`; plays through the shared AudioContext (already unlocked by the tap on iOS). |
| `api.js` | `/api/companion/turn`, `/speak`, `/checkin`, `/end`, `/api/news`, `/api/speech-token`; canned fallback. |

Backend: `api/src/functions/companion.js`, `api/lib/{companion,gemini,eleven,news,companionStore}.js`.
Replies: Gemini `gemini-3.5-flash` (falls back to `-flash-lite` on overload or > 2.5 s),
JSON output, 1–2 sentences < 35 words, at most one question (enforced server-side, C3).
Calm mode never says alert/police/danger/safe/etc. (prompt + server filter, C10).
News: Google News RSS per interest, 5 items, cached 30 min (no key needed).
Memory: at walk end, up to 5 facts → `memories` (latest 15 kept), used in the next walk (C8).
Call record: every turn → `conversation_turns` (P3's schema: role user/assistant, data.mode,
data.latency_ms).

## Measured (laptop, 2026-10-03)

| | |
| --- | --- |
| Partial transcript while she talks | every ~0.5 s (C1 < 1 s ✅) |
| Final transcript after she stops | ~0.2 s (C1 < 1.5 s ✅) |
| Her last word → firefly starts speaking | 1.8 s (C2 < 3 s ✅) |
| Gemini reply / ElevenLabs sentence | ~0.8–1.1 s / ~0.3–0.5 s |
| Code phrase said while the firefly talks | heard → Guardian countdown ✅ |

Not yet checked on a real phone (iOS Safari / Android Chrome) or outdoors with earbuds.

Tests: `cd app && npm test` (brain timing rules, check-in keywords, echo filter, protocol),
`cd api && npm test` (reply shaping, keywords, calm filters, RSS parsing).
