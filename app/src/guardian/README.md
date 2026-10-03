# Guardian (P2): the safety brain

Runs entirely in the phone's browser. Talks to the rest of the app only through `src/bus.js`
and P3's `/api/walks/{walk_id}/{events,clip,scores}`.

## For P4: mounting it

```js
import { startGuardian } from './guardian/index.js';
startGuardian(); // once, at app boot. Idempotent.
```

- Emit `walk.started` **synchronously inside the "Walk with me" tap handler** (no `await`
  before it). The Guardian opens the mic and AudioContext right there, before loading anything,
  because iOS Safari only starts audio from inside a user gesture. If it ends up `suspended`,
  the console says so.
- YAMNet (15 MB, vendored in `public/models/yamnet/`) loads lazily on `walk.started`; first
  load takes a few seconds, and it's cached after that. Works offline once loaded (A10).
- Backend: on load it times **WASM** (SIMD) and **WebGL** and keeps the faster one (WebGL only
  if the GPU does full 32-bit floats). Laptop: WASM ~7 ms per window, WebGL ~25 ms. Force one
  with `?backend=wasm|webgl|cpu`. If deployed WASM fails to load, add
  `"mimeTypes": {".wasm": "application/wasm"}` to `staticwebapp.config.json`.
- The page must be served over HTTPS (or localhost) for the mic. `npm run dev` serves HTTPS.

| URL flag | Effect |
| --- | --- |
| `?mock=1` | API calls are logged to the console instead of sent; a floating **Guardian mock** panel (and keys) drives every flow. The mic still runs, so a played scream still works. |
| `?mic=0` | No microphone. The mock panel still drives the whole countdown (G12). |
| `?debug=1` | Overlay with live scream score, threshold, state, inference ms, backend, dropped windows. |
| `?threshold=0.5` | Override the scream threshold (also `localStorage["firefly.scream_threshold"]`). Higher = fewer false alarms, more missed screams. |
| `?backend=wasm` | Force the TF.js backend (`wasm`, `webgl`, `cpu`). |

Code phrase: `localStorage["firefly.code_phrase"]` (default `"i think i left the oven on"`).
The setup screen should write the user's phrase there.

## Events

Listens to `walk.started`, `position.updated`, `speech.heard`, `checkin.answered`,
`pin.entered`, `walk.ended`. Emits:

| Event | Payload | When |
| --- | --- | --- |
| `alert.state` | `state`, `seconds_left` | every change; every second during `countdown` (10 → 1) |
| `checkin.request` | `reason` (`long_stop`, `off_route`, `no_answer_retry`), `prompt` | entering `checking_in`, and once more after the first unanswered check-in |
| `danger.signal` | `source`, `confidence`, `detail` | scream (2 of last 3 windows, every 0.24 s), code phrase, long_stop, off_route, no_response |
| `guardian.score` | `score`, `yamnetScore`, `ms`, `triggered`, `classScores` | *debug only*, every 0.24 s; not part of the contract, don't build on it |

`alert.state` after a **duress** PIN is identical to a cancel (`resolved`). Only the backend
knows (it receives `duress`). The 20 s `resolved` hold ignores new screams.

## Behaviour notes (beyond the spec table)

- If the companion never answers a check-in, the Guardian counts it as `ok: null` after 25 s,
  so a silent companion can't stall escalation.
- `walk.ended` during a countdown does **not** cancel it; only a PIN does.
- Cancel PIN during `checking_in` counts as "I'm ok". Cancel during `alerted` posts `alert_cancelled`.
- Duress PIN outside a countdown (e.g. during a check-in) still posts `duress`.
- The alert clip is a 10 s **16 kHz mono WAV** (5 s before the trigger + 5 s after, 320 KB),
  cut from the same in-memory audio YAMNet hears. The spec suggested MediaRecorder chunks, but a
  rolling buffer of 1 s webm chunks can't be cut cleanly (only the first chunk carries the
  header) and iOS and Android produce different containers. WAV is exact and allowed by `/clip`.
  The clip is uploaded **only** for `alert_sent` / `duress`. If no mic audio exists, the alert
  goes out without a clip.

## Testing on a phone

1. Laptop and phone on the same Wi-Fi. Run `cd app && npm run dev`, then open
   `https://<laptop-ip>:5173/guardian-test.html` on the phone and accept the certificate warning.
2. **Start mic**: the status line shows the chosen backend, the per-window time, and
   `audio running` (if it says `suspended`, audio didn't start inside the tap).
3. **Test scream ▶** plays a held-out recorded scream through the real live pipeline (no mic
   needed) and logs how long after the scream's onset the trigger fired (G6: < 2 s).
4. Leave it running 10 minutes: "Avg 1st minute → last minute" and the tensor count should stay
   flat (G1).
5. **Parity check vs Python** confirms this phone's backend computes the same scores as training.

Scores go to P3's `/scores` with both field names (`scream_score`/`triggered` from the team
contract and `score`/`label` from P3's implementation) until the two are reconciled.

## Files

| File | What |
| --- | --- |
| `index.js` | wiring: bus ⇄ state machine, detectors, API |
| `stateMachine.js` | escalation state machine (pure, clock injected) |
| `codePhrase.js` | fuzzy code-phrase spotting (char ratio ≥ 0.8 + word alignment of content words) |
| `checkins.js` | long_stop / off_route from `position.updated` |
| `../audio/micHub.js`, `../audio/resampler.js`, `../audio/capture-worklet.js` | **shared** mic: one capture, 16 kHz, fanned out to the scream model, clip buffer and the companion's speech-to-text (resampler mirrored bit-exactly by `ml/resample.py`) |
| `audio/windows.js` | 0.96 s windows (hop from the head: 0.24 s), head scoring (logistic / context / MLP), k-of-n trigger rule |
| `audio/backend.js` | picks the fastest TF.js backend (WASM / WebGL) on this device |
| `audio/yamnet.js`, `audio/detector.js` | shared mic → YAMNet → score |
| `audio/clipBuffer.js` | rolling 15 s buffer + WAV encoder |
| `scoreLog.js` | score batches every 30 s → `/scores` |
| `mock.js`, `overlay.js` | `?mock=1` panel, `?debug=1` overlay |
| `/guardian-test.html` | standalone live-score page (G1 timing, threshold slider, parity check) |

Tests: `cd app && npm test` (state machine rows, code phrase 10 + 10, check-ins, audio, wiring).
