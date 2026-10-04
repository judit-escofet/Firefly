// Escalation state machine. Pure JS: no browser APIs. Everything with side effects is injected.
//
//   idle ──check-in trigger──▶ checking_in ──ok:true──▶ idle
//     │                          │  ok:false / 2× ok:null
//     │ scream / code phrase     ▼
//     └────────────────────▶ countdown ──10 s──▶ alerted ──walk.ended──▶ idle
//                               │ pin cancel / duress
//                               ▼
//                            resolved ──20 s──▶ idle   (new screams ignored meanwhile)
//
// Deps:
//   emit(type, payload)        bus emit (alert.state, checkin.request, danger.signal)
//   logEvent(body)             POST /api/walks/{id}/events. body: {type, source, confidence, clip_url}
//   clip: { capture(), upload(blob) }  capture() → Promise<Blob|null> (5 s before + 5 s after now)
//   clock                      { now, setTimeout, clearTimeout }

export const STATES = Object.freeze({
  IDLE: 'idle',
  CHECKING_IN: 'checking_in',
  COUNTDOWN: 'countdown',
  ALERTED: 'alerted',
  RESOLVED: 'resolved',
});

// distress: she said she's hurt or in danger ("I've been stabbed", "help me"): see distress.js.
const COUNTDOWN_SOURCES = new Set(['scream', 'code_phrase', 'distress']);
const CHECKIN_SOURCES = new Set(['long_stop', 'off_route']);

const CHECKIN_PROMPTS = {
  long_stop: "Looks like you've stopped for a bit. Everything okay?",
  off_route: "You've wandered off the route. Are you okay?",
  manual: 'Just checking in. Are you okay?',
  no_answer_retry: "I didn't catch that. Are you okay?",
};

export function createStateMachine({
  emit,
  logEvent = async () => {},
  clip = null,
  clock,
  countdownS = 10,
  resolvedHoldS = 20,
  checkinTimeoutS = 25, // if the companion never answers, count it as ok:null
  clipWaitMs = 4000, // how long alert_sent waits for the clip before sending without it
}) {
  let state = STATES.IDLE;
  let secondsLeft = null;
  let timer = null; // single active timer: countdown tick, resolved hold, or check-in timeout
  let nullAnswers = 0;
  let trigger = null; // {source, confidence} that started the countdown
  let clipPromise = null;

  // Capture is started synchronously so the clip is centred on the exact trigger moment.
  const startClip = () => {
    if (!clip) return null;
    try {
      return Promise.resolve(clip.capture()).catch(() => null);
    } catch {
      return Promise.resolve(null);
    }
  };

  const setTimer = (fn, ms) => {
    clearTimer();
    timer = clock.setTimeout(() => {
      timer = null;
      fn();
    }, ms);
  };
  const clearTimer = () => {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  };

  function setState(next, seconds = null) {
    state = next;
    secondsLeft = seconds;
    emit('alert.state', { state, seconds_left: seconds });
  }

  function requestCheckin(reason) {
    emit('checkin.request', { reason, prompt: CHECKIN_PROMPTS[reason] ?? CHECKIN_PROMPTS.manual });
    setTimer(() => answer(null), checkinTimeoutS * 1000);
  }

  // ---- inputs ---------------------------------------------------------------------------------

  function checkinTrigger(reason = 'manual') {
    if (state !== STATES.IDLE) return false;
    nullAnswers = 0;
    setState(STATES.CHECKING_IN);
    requestCheckin(reason);
    return true;
  }

  function answer(ok) {
    if (state !== STATES.CHECKING_IN) return;
    if (ok === true) {
      clearTimer();
      nullAnswers = 0;
      logEvent({ type: 'checkin', source: 'checkin', confidence: 1 });
      setState(STATES.IDLE);
    } else if (ok === false) {
      startCountdown({ source: 'checkin', confidence: 1 });
    } else {
      nullAnswers += 1;
      if (nullAnswers >= 2) {
        emit('danger.signal', {
          source: 'no_response',
          confidence: 1,
          detail: `${nullAnswers} check-ins unanswered`,
        });
        startCountdown({ source: 'no_response', confidence: 1 });
      } else {
        requestCheckin('no_answer_retry');
      }
    }
  }

  function danger({ source, confidence = 1 } = {}) {
    if (CHECKIN_SOURCES.has(source)) return checkinTrigger(source);
    if (!COUNTDOWN_SOURCES.has(source)) return false;
    if (state !== STATES.IDLE && state !== STATES.CHECKING_IN) return false; // incl. 20 s resolved hold
    startCountdown({ source, confidence });
    return true;
  }

  function startCountdown(t) {
    clearTimer();
    trigger = t;
    nullAnswers = 0;
    clipPromise = startClip();
    logEvent({ type: 'countdown_started', source: t.source, confidence: t.confidence });
    const startedAt = clock.now();
    setState(STATES.COUNTDOWN, countdownS);
    const tick = () => {
      const left = countdownS - Math.round((clock.now() - startedAt) / 1000);
      if (left <= 0) return fireAlert();
      setState(STATES.COUNTDOWN, left);
      setTimer(tick, 1000);
    };
    setTimer(tick, 1000);
  }

  async function clipUrl() {
    if (!clipPromise || !clip) return null;
    let timeoutId;
    const timeout = new Promise((r) => (timeoutId = clock.setTimeout(() => r(null), clipWaitMs)));
    const blob = await Promise.race([clipPromise, timeout]);
    clock.clearTimeout(timeoutId);
    if (!blob) return null;
    try {
      return (await clip.upload(blob)) ?? null;
    } catch {
      return null;
    }
  }

  async function sendWithClip(type) {
    const t = trigger ?? { source: 'unknown', confidence: 1 };
    const clip_url = await clipUrl();
    return logEvent({ type, source: t.source, confidence: t.confidence, clip_url });
  }

  function fireAlert() {
    clearTimer();
    setState(STATES.ALERTED);
    return sendWithClip('alert_sent');
  }

  function enterResolved() {
    setState(STATES.RESOLVED);
    setTimer(() => {
      trigger = null;
      clipPromise = null;
      setState(STATES.IDLE);
    }, resolvedHoldS * 1000);
  }

  function pin(kind) {
    if (kind === 'cancel') {
      if (state === STATES.COUNTDOWN || state === STATES.ALERTED) {
        clearTimer();
        logEvent({ type: 'alert_cancelled', source: trigger?.source ?? 'pin', confidence: 1 });
        clipPromise = null; // never uploaded
        enterResolved();
      } else if (state === STATES.CHECKING_IN) {
        answer(true);
      }
    } else if (kind === 'duress') {
      // Must look exactly like a cancel on screen, while contacts ARE alerted.
      if (!trigger || (state !== STATES.COUNTDOWN && state !== STATES.ALERTED)) {
        trigger = { source: 'duress', confidence: 1 };
        clipPromise ??= startClip();
      }
      clearTimer();
      const sent = sendWithClip('duress');
      if (state !== STATES.IDLE) enterResolved();
      return sent;
    }
  }

  function walkEnded() {
    // A countdown keeps running: ending the walk must not silently swallow an alarm.
    if (state === STATES.COUNTDOWN) return;
    clearTimer();
    trigger = null;
    clipPromise = null;
    nullAnswers = 0;
    if (state !== STATES.IDLE) setState(STATES.IDLE);
  }

  function dispose() {
    clearTimer();
  }

  return {
    get state() {
      return state;
    },
    get secondsLeft() {
      return secondsLeft;
    },
    checkinTrigger,
    answer,
    danger,
    pin,
    walkEnded,
    dispose,
  };
}
