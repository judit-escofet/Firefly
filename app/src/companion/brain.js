// Conversation logic for the companion. Pure: clock, voice and API are injected (unit-tested).
//
// chat     after a final transcript followed by ~1.8 s of silence, speak the reply. The request
//          starts speculatively at the final (saves ~1 s, C2) and is discarded if she goes on.
//          Never interrupts: if she starts talking again while a reply is on its way, the reply
//          is dropped and her words are answered together once she pauses.
//          After 90 s of quiet, casually bring something up (mode "idle"); each further silence
//          waits twice as long (90 s, 3 min, 6 min…), reset as soon as she talks.
// ETA      time to home is mentioned at most once every 5 minutes (context.eta_due), not every turn.
// checkin  on checkin.request: speak the prompt, then classify her next words (keywords first,
//          the model only if unclear) → checkin.answered {ok, text} within ~1 s; 20 s of
//          silence after the prompt → {ok: null}.
// calm     while alert.state is countdown/alerted: replies stay ordinary and never mention the
//          alert (the server enforces this too); a calm line starts soon after the alert begins.
// News is offered at most once every 3 minutes, and only items from /api/news.

import { classifyCheckinKeywords } from './checkinWords.js';

export const TURN_SILENCE_MS = 1800;
export const IDLE_MS = 90000;
export const IDLE_MAX_MS = 8 * 60e3;
export const ETA_GAP_MS = 5 * 60e3;
export const CHECKIN_SILENCE_MS = 20000;
export const NEWS_GAP_MS = 3 * 60e3;

export function createBrain({
  clock,
  say, // (text, {t0}) → Promise (resolves when finished speaking)
  turn, // (body) → Promise<{reply_text, topic, memory_saved}>
  classify, // (text) → Promise<true|false|null>
  emit, // bus emit
  line = async () => null, // (id) → pre-generated line text
  getContext = () => ({}),
  getNews = () => [],
  identity = () => ({}), // {user_id, walk_id, name}
}) {
  let active = false;
  let mode = 'chat';
  let alertActive = false;
  let speaking = false;
  let pending = ''; // finals not yet answered
  let lastFinalAt = 0;
  let lastNewsAt = -Infinity;
  let lastEtaAt = 0; // the walk screen shows the ETA; the firefly says it at most every 5 min
  let lastHeardAt = 0; // any partial or final from her
  let idleStreak = 0; // silences in a row: each idle prompt waits twice as long
  let awaitingAnswer = false;
  let checkinReason = null;
  let inFlight = false;
  const history = []; // {speaker: 'user'|'firefly', text}
  const timers = { turn: null, idle: null, checkin: null, calm: null };

  const clear = (name) => {
    if (timers[name] !== null) clock.clearTimeout(timers[name]);
    timers[name] = null;
  };
  const set = (name, fn, ms) => {
    clear(name);
    timers[name] = clock.setTimeout(() => {
      timers[name] = null;
      fn();
    }, ms);
  };

  function armIdle() {
    if (!active || alertActive || awaitingAnswer) return clear('idle');
    set('idle', () => takeTurn({ idle: true }), Math.min(IDLE_MS * 2 ** idleStreak, IDLE_MAX_MS));
  }

  async function speak(text, t0) {
    history.push({ speaker: 'firefly', text });
    await say(text, { t0 });
  }

  // Build the request for the current state without changing it (speculation must be free).
  function request({ idle, userText }) {
    const offerNews = clock.now() - lastNewsAt >= NEWS_GAP_MS;
    const etaDue = !alertActive && clock.now() - lastEtaAt >= ETA_GAP_MS;
    return turn({
      ...identity(),
      user_text: userText,
      mode: alertActive ? 'calm' : idle ? 'idle' : 'chat',
      context: { ...getContext(), checkin_reason: null, eta_due: etaDue },
      history: history.slice(-8),
      news: offerNews ? getNews().slice(0, 3) : [],
    });
  }

  // Speculative reply: requested as soon as a sentence is final, while the 1.2 s pause runs.
  // Used only if she then stays quiet and the text hasn't changed; otherwise thrown away.
  let spec = null; // {text, promise}
  function speculate() {
    const userText = pending.trim();
    if (!userText || inFlight || awaitingAnswer) return;
    const promise = request({ idle: false, userText });
    promise.catch(() => {});
    spec = { text: userText, promise };
  }

  async function takeTurn({ idle = false } = {}) {
    if (!active || inFlight) return;
    const userText = pending.trim();
    if (!userText && !idle && mode !== 'calm') return;
    pending = '';
    inFlight = true;
    const t0 = idle || !userText ? clock.now() : lastFinalAt;
    const etaWasDue = clock.now() - lastEtaAt >= ETA_GAP_MS;
    const reuse = !idle && userText && spec?.text === userText ? spec.promise : null;
    spec = null;
    if (idle) idleStreak += 1;
    try {
      const reply = await (reuse ?? request({ idle, userText }));
      if (!active) return;
      // She started talking again while the reply was on its way: don't talk over her. Keep her
      // earlier words and answer everything together once she pauses.
      if (lastHeardAt > t0) {
        if (userText) pending = `${userText} ${pending}`.trim();
        return;
      }
      if (userText) history.push({ speaker: 'user', text: userText });
      if (reply.topic === 'news') lastNewsAt = clock.now();
      if (etaWasDue || reply.topic === 'eta') lastEtaAt = clock.now();
      if (awaitingAnswer) return; // a check-in started meanwhile: don't talk over it
      await speak(reply.reply_text, t0);
    } finally {
      inFlight = false;
      if (pending.trim() && !awaitingAnswer) set('turn', () => takeTurn(), TURN_SILENCE_MS);
      else armIdle();
    }
  }

  async function answerCheckin(text) {
    awaitingAnswer = false;
    clear('checkin');
    let ok = classifyCheckinKeywords(text);
    if (ok === undefined) ok = await classify(text);
    emit('checkin.answered', { ok, text });
    mode = alertActive ? 'calm' : 'chat';
    if (ok === true) {
      const ack = (await line('ack_ok')) ?? "Glad to hear it. I'm right here with you.";
      await speak(ack, clock.now());
    } else if (ok === false) {
      // The Guardian starts its silent countdown now; keep talking normally.
      const ack = (await line('ack_not_ok')) ?? "Okay. I'm right here, keep talking to me.";
      await speak(ack, clock.now());
    }
    armIdle();
  }

  return {
    get mode() {
      return mode;
    },
    get history() {
      return history.slice();
    },
    get awaitingAnswer() {
      return awaitingAnswer;
    },

    async start() {
      active = true;
      mode = 'chat';
      history.length = 0;
      pending = '';
      lastNewsAt = -Infinity;
      lastEtaAt = clock.now();
      lastHeardAt = 0;
      idleStreak = 0;
      const greet = (await line('greeting')) ?? "Hey, I'm here with you. How was your day?";
      if (active) await speak(greet, clock.now());
      armIdle();
    },

    heard({ text, final }) {
      // While the firefly talks, partials are ignored (the companion stops the voice on
      // barge-in); her finished sentence still counts.
      if (!active || (speaking && !final)) return;
      lastHeardAt = clock.now();
      idleStreak = 0;
      clear('idle');
      if (awaitingAnswer) {
        if (final) answerCheckin(text);
        else clear('checkin'); // she's answering: no "silence" timeout mid-sentence
        return;
      }
      if (final) {
        pending = `${pending} ${text}`.trim();
        lastFinalAt = clock.now();
        speculate();
        set('turn', () => takeTurn(), TURN_SILENCE_MS);
      } else {
        clear('turn'); // still talking: wait for the end of her sentence
      }
    },

    async checkinRequest({ reason, prompt }) {
      if (!active) return;
      clear('turn');
      clear('idle');
      pending = '';
      mode = 'checkin';
      checkinReason = reason;
      awaitingAnswer = false;
      await speak(prompt || "Hey, just checking in. Everything alright?", clock.now());
      if (!active || mode !== 'checkin') return;
      awaitingAnswer = true;
      set(
        'checkin',
        () => {
          awaitingAnswer = false;
          emit('checkin.answered', { ok: null, text: '' });
          mode = alertActive ? 'calm' : 'chat';
          armIdle();
        },
        CHECKIN_SILENCE_MS,
      );
    },

    alertState({ state }) {
      const was = alertActive;
      alertActive = state === 'countdown' || state === 'alerted';
      if (alertActive && !was) {
        mode = 'calm';
        awaitingAnswer = false;
        clear('checkin');
        clear('idle');
        // Keep her talking with something ordinary shortly after the alert starts.
        set('calm', () => !speaking && !inFlight && takeTurn(), 2500);
      } else if (!alertActive && was) {
        clear('calm');
        mode = 'chat';
        armIdle();
      }
    },

    speakingChanged(on) {
      speaking = on;
      if (on) {
        clear('idle');
        clear('turn');
      }
    },

    stop() {
      active = false;
      for (const k of Object.keys(timers)) clear(k);
      awaitingAnswer = false;
      pending = '';
    },

    get checkinReason() {
      return checkinReason;
    },
  };
}
