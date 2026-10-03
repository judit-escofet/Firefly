# Firefly app (P4) — and how P1, P2, P3 plug in

React + Vite + Tailwind web app (started in Lovable, "delightful-hubble"), deployed as the
front end of the team's Azure Static Web App. It owns the screens, the walk lifecycle and the
P4 events of the team contract; the companion (P1, `src/companion/`) and the guardian (P2,
`src/guardian/`) start once at boot (`src/main.jsx`) and talk to it only through `src/bus.js`.

## Run

```bash
cd api && npm install && npm run dev      # P3 + P1 functions on :7071 (keys in api/local.settings.json)
cd app && npm install && npm run dev:local  # http://localhost:5173  (npm run dev = HTTPS for phones)
```

Phone: `npm run dev`, same Wi-Fi, open `https://<laptop-ip>:5173`, accept the certificate.
Tests: `npm test` (99: bus, PIN hashing, P3 contract helpers, route math, P1, P2).

## Flow

| Screen | What happens |
| --- | --- |
| Welcome | "Set up" or "Try the demo" (mock profile: PINs **1234** cancel / **9999** duress). With a profile: **Walk with me**. |
| Setup (3 steps) | Name + 1–3 contacts (US numbers → `+1…`) · code phrase (≥ 3 words) with a **real "Say it once" test** (live transcription + the Guardian's matcher) · cancel + duress PIN, entered twice, must differ, **hashed in the browser** (SHA-256, user id as salt) · news chips · **home on a map** (tap, or "I'm home now"). Saved to `POST /api/profile`; kept on the phone if P3 is unreachable. |
| Walk | Opens the shared mic **inside the tap** (iOS), gets a GPS fix, `POST /api/walks` (Azure Maps route via P3; local route if unavailable), emits `walk.started`. Map with glowing route, trail and firefly; ETA/distance; "Listening" badge from the real mic state; firefly captions from `companion.speaking`; Call 911 (`tel:911`; a demo sheet in mock mode); screen wake lock. GPS → `POST /api/walks/{id}/location` every 5 s → `position.updated`; < 30 m from home ends the walk (`arrived`). |
| Countdown | Shown when the Guardian emits `alert.state: countdown`; dim, no red, no alarming words, quiet chime + vibration. PIN checked locally against the hashes → `pin.entered {kind}`. Cancel and duress both show the identical "All good, enjoy your walk". If time runs out the Guardian moves to `alerted` and the walk screen shows a small note. **The app never emits `alert.state` itself.** |
| Home | "You're home. Your contacts know you're safe." Time, distance, share card. |

Mock mode (`?mock=1`, or "Try the demo"): no network calls; a simulated walk near NJIT at
walking speed; P1 uses canned lines + pre-generated voice (type in the box to "talk"); P2 runs
for real. Works with Wi-Fi off after loading (map tiles just go dark).

Demo drawer (top right): jump ahead (`J`), arrive home, **stop here** (long-stop check-in after
90 s), **wander off** (95 m off route → check-in after 30 s), say the code phrase, scream
detected, **walk with test audio** (a recorded voice through the real mic pipeline), mock
toggle, and the live **event-bus inspector**.

## Contract notes for the team

- `position.updated` carries the contract fields `lat, lng, remaining_m, eta_s, on_route,
  off_route_m` (+ `accuracy_m`, `near_destination`, `trail`).
- `walk.ended.reason` is `arrived` or `stopped`; `companion.speaking` is `{on, text}`.
- P3 field names used: `pin_hash` / `duress_pin_hash`, `start` / `destination{lat,lng,label}`,
  `/api/walks/{id}/location`, `/api/walks/{id}/end`, user ids `u_…`.
- Map tiles: Azure Maps through P3's `/api/tiles` (key stays on the server), darkened in CSS;
  Esri's free dark basemap when that's not configured. `public/staticwebapp.config.json`
  keeps P3's `/track` route and adds the SPA fallback, `.wasm` MIME type and permissions.

## Changes from the Lovable starter (and why)

- The countdown no longer runs its own timer or emits `alert.state` (that's the Guardian's
  state machine); the demo buttons trigger the real Guardian instead of faking the countdown.
- Event payloads and P3 calls renamed to match the contract and P3's actual endpoints.
- Fake companion scripts removed (the real P1 talks, also in mock mode).
- "Say it once" used to pass even when recognition failed; now it really checks the phrase.
- Fixed: undefined Tailwind colours/animations, a see-through countdown screen
  (`bg-…/98` isn't a Tailwind opacity), tiles inverted to light, CARTO tiles now needing a key,
  markers lost on React StrictMode remounts, "wander off" that only went 60 m off route.
