// "Say it once" (setup, P4 spec): she says her code phrase and we check it the way the walk
// will — same live transcription (P1's transcriber on the shared mic) and the same fuzzy match
// the Guardian (P2) uses. Passing here means the phrase will actually be caught on a walk.
// Must be started synchronously inside the tap (the mic opens there on iOS).

import { acquireMic } from '../audio/micHub.js';
import { createTranscriber } from '../companion/stt.js';
import { createCompanionApi } from '../companion/api.js';
import { scorePhrase } from '../guardian/codePhrase.js';

// onUpdate({state: 'listening'|'passed'|'failed'|'error', heard, score, message})
export function startPhraseTest(phrase, onUpdate, { timeoutMs = 12000 } = {}) {
  const mic = acquireMic();
  const api = createCompanionApi();
  let transcriber = null;
  let done = false;
  let best = { score: 0, heard: '' };

  const finish = (result) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    transcriber?.stop();
    mic.release();
    onUpdate(result);
  };
  const check = (text, final) => {
    const r = scorePhrase(text, phrase);
    if (r.score > best.score) best = { score: r.score, heard: text };
    if (r.matched) finish({ state: 'passed', heard: text, score: r.score });
    else onUpdate({ state: 'listening', heard: text, score: r.score });
    if (final && !r.matched) setTimeout(() => !done && finish({ state: 'failed', ...best, message: "That didn't match. Try once more, a little slower." }), 1500);
  };
  const timer = setTimeout(
    () => finish(best.heard ? { state: 'failed', ...best, message: "That didn't match. Try once more." } : { state: 'failed', heard: '', score: 0, message: "I didn't hear anything. Check the mic and try again." }),
    timeoutMs,
  );

  onUpdate({ state: 'listening', heard: '', score: 0 });
  mic.ready
    .then(() => {
      if (done) return;
      transcriber = createTranscriber({
        mic,
        getToken: () => api.speechToken(),
        vocabulary: [phrase],
        onPartial: (t) => check(t, false),
        onFinal: (t) => check(t, true),
        onStatus: (s) => /error|failed/.test(s) && finish({ state: 'error', heard: '', score: 0, message: 'Speech service unavailable right now.' }),
      });
    })
    .catch((err) => finish({ state: 'error', heard: '', score: 0, message: err.message }));

  return { cancel: () => finish({ state: 'failed', heard: best.heard, score: best.score, message: 'Cancelled.' }) };
}
