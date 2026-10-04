import { describe, it, expect } from 'vitest';
import { createBrain, TURN_SILENCE_MS, IDLE_MS, CHECKIN_SILENCE_MS, NEWS_GAP_MS, ETA_GAP_MS } from '../src/companion/brain.js';
import { classifyCheckinKeywords } from '../src/companion/checkinWords.js';
import { parseServerMessage, pcm16Base64, createSpeechGain, createVoiceGate } from '../src/companion/stt.js';
import { cleanTranscript, isMeaningful } from '../src/companion/noiseFilter.js';
import { createFakeClock } from '../src/guardian/clock.js';

// setImmediate, not setTimeout(0): Windows timers are ~15 ms coarse, which made the long
// news test exceed vitest's 5 s limit there. Both let pending promises settle.
const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

function setup({ reply = { reply_text: 'Tell me more!', topic: 'day' }, classifyResult = null } = {}) {
  const clock = createFakeClock();
  const said = [];
  const turns = [];
  const emitted = [];
  const brain = createBrain({
    clock,
    say: async (text) => said.push(text),
    turn: async (body) => (turns.push(body), typeof reply === 'function' ? reply(body) : reply),
    classify: async () => classifyResult,
    emit: (type, p) => emitted.push({ type, ...p }),
    line: async (id) => ({ greeting: 'Hi! How was your day?', ack_ok: 'Glad to hear it.', ack_not_ok: "Okay, I'm here." })[id] ?? null,
    getContext: () => ({ eta_s: 360, remaining_m: 500 }),
    getNews: () => [{ title: 'Big album drop', source: 'NPR' }],
    identity: () => ({ user_id: 'u_t', walk_id: 'w_t' }),
  });
  return { clock, said, turns, emitted, brain };
}

describe('companion brain', () => {
  it('greets at walk start', async () => {
    const t = setup();
    await t.brain.start();
    expect(t.said).toEqual(['Hi! How was your day?']);
  });

  it('turn-taking: replies only after a final + 1.2 s of silence, never mid-sentence', async () => {
    const t = setup();
    await t.brain.start();
    t.brain.heard({ text: 'long day', final: false });
    t.brain.heard({ text: 'long day my exam was rough', final: true });
    t.clock.advance(TURN_SILENCE_MS - 100);
    t.brain.heard({ text: 'and', final: false }); // she keeps going → timer cancelled
    t.clock.advance(1000);
    await flush();
    expect(t.said).toEqual(['Hi! How was your day?']); // nothing spoken while she's mid-sentence
    t.brain.heard({ text: 'and I am tired', final: true });
    t.clock.advance(TURN_SILENCE_MS);
    await flush();
    // Requests start speculatively at each final; only the one for the full text is used.
    expect(t.turns.map((x) => x.user_text)).toEqual(['long day my exam was rough', 'long day my exam was rough and I am tired']);
    expect(t.turns.at(-1)).toMatchObject({ mode: 'chat', walk_id: 'w_t' });
    expect(t.turns.at(-1).context).toMatchObject({ eta_s: 360, remaining_m: 500 });
    expect(t.said.at(-1)).toBe('Tell me more!');
    expect(t.said.filter((x) => x === 'Tell me more!')).toHaveLength(1); // spoken once
  });

  it('offers a topic after 45 s of quiet (mode idle) — C5', async () => {
    const t = setup();
    await t.brain.start();
    t.clock.advance(IDLE_MS);
    await flush();
    expect(t.turns.at(-1)).toMatchObject({ mode: 'idle', user_text: '' });
  });

  it('news at most once every 3 minutes — C6', async () => {
    const t = setup({
      reply: (body) => (body.news.length ? { reply_text: 'NPR says a big album dropped.', topic: 'news' } : { reply_text: 'Tell me more!', topic: 'day' }),
    });
    await t.brain.start();
    t.brain.heard({ text: 'tell me something', final: true });
    t.clock.advance(TURN_SILENCE_MS);
    await flush();
    expect(t.turns[0].news).toHaveLength(1);
    t.brain.heard({ text: 'cool what else', final: true });
    t.clock.advance(TURN_SILENCE_MS);
    await flush();
    expect(t.turns[1].news).toEqual([]);
    // Long enough for two idle prompts (90 s, then 3 min later): the second comes after the gap.
    for (let s = 0; s < NEWS_GAP_MS / 1000 + 180; s++) {
      t.clock.advance(1000); // idle prompts happen along the way
      await flush(2);
    }
    const withNews = t.turns.filter((x) => x.news.length);
    expect(withNews.length).toBe(2); // the first one, then exactly one more after the 3-minute gap
  });

  it('check-in: speaks the prompt, clear answer → checkin.answered immediately — C9', async () => {
    const t = setup();
    await t.brain.start();
    await t.brain.checkinRequest({ reason: 'long_stop', prompt: "Looks like you've stopped. Everything okay?" });
    expect(t.said.at(-1)).toBe("Looks like you've stopped. Everything okay?");
    t.brain.heard({ text: "yeah I'm fine, just tying my shoe", final: true });
    await flush();
    expect(t.emitted.find((e) => e.type === 'checkin.answered')).toMatchObject({ ok: true });
    expect(t.said.at(-1)).toBe('Glad to hear it.');
    expect(t.turns).toHaveLength(0); // no LLM round trip for a clear answer
  });

  it('check-in: unclear answer asks the model; not-ok answer → ok:false', async () => {
    const t = setup({ classifyResult: false });
    await t.brain.start();
    await t.brain.checkinRequest({ reason: 'off_route', prompt: 'You okay?' });
    t.brain.heard({ text: 'uh I guess', final: true });
    await flush();
    expect(t.emitted.find((e) => e.type === 'checkin.answered')).toMatchObject({ ok: false, text: 'uh I guess' });
  });

  it('check-in: 20 s of silence → ok:null', async () => {
    const t = setup();
    await t.brain.start();
    await t.brain.checkinRequest({ reason: 'long_stop', prompt: 'You okay?' });
    t.clock.advance(CHECKIN_SILENCE_MS - 1);
    expect(t.emitted.filter((e) => e.type === 'checkin.answered')).toHaveLength(0);
    t.clock.advance(1);
    expect(t.emitted.find((e) => e.type === 'checkin.answered')).toEqual({ type: 'checkin.answered', ok: null, text: '' });
  });

  it('calm mode during an alert: turns use mode calm and a calm line starts by itself — C10', async () => {
    const t = setup();
    await t.brain.start();
    t.brain.alertState({ state: 'countdown', seconds_left: 10 });
    expect(t.brain.mode).toBe('calm');
    t.clock.advance(2500);
    await flush();
    expect(t.turns.at(-1)).toMatchObject({ mode: 'calm' });
    t.brain.heard({ text: 'i had pasta', final: true });
    t.clock.advance(TURN_SILENCE_MS);
    await flush();
    expect(t.turns.at(-1)).toMatchObject({ mode: 'calm', user_text: 'i had pasta' });
    t.brain.alertState({ state: 'resolved', seconds_left: null });
    expect(t.brain.mode).toBe('chat');
  });

  it('ignores partials while the firefly talks, but her finished sentence still counts (barge-in)', async () => {
    const t = setup();
    await t.brain.start();
    t.brain.speakingChanged(true);
    t.brain.heard({ text: 'wait', final: false });
    t.clock.advance(TURN_SILENCE_MS * 2);
    await flush();
    expect(t.turns).toHaveLength(0);
    t.brain.speakingChanged(false);
    t.brain.heard({ text: 'wait I have a question', final: true });
    t.clock.advance(TURN_SILENCE_MS);
    await flush();
    expect(t.turns.at(-1)).toMatchObject({ user_text: 'wait I have a question' });
  });
});

describe('echo filter (C4) — the firefly must not answer itself', () => {
  it('drops transcripts of the firefly line, keeps her words', async () => {
    const { isEcho } = await import('../src/companion/echo.js');
    const line = "Oh, I'm so sorry the exam was rough. We have about 6 minutes to home.";
    expect(isEcho("I'm so sorry the exam was rough", line)).toBe(true);
    expect(isEcho('about 6 minutes to home', line)).toBe(true);
    expect(isEcho('I think I left the oven on', line)).toBe(false); // her code phrase gets through
    expect(isEcho('yeah', line)).toBe(false);
    expect(isEcho('rough', line)).toBe(true);
  });
});

describe('check-in keywords (browser copy of api/lib/companion.js)', () => {
  it('matches the server rules', () => {
    for (const s of ["yeah I'm fine", 'yes', 'all good', "no, I'm fine", 'no worries']) expect(classifyCheckinKeywords(s)).toBe(true);
    for (const s of ['no', 'help', 'not really', "someone's following me", 'not okay']) expect(classifyCheckinKeywords(s)).toBe(false);
    expect(classifyCheckinKeywords('')).toBe(null);
    expect(classifyCheckinKeywords('what time is it')).toBe(undefined);
  });
});

describe('live transcription protocol', () => {
  it('parses partial and final transcripts', () => {
    expect(parseServerMessage({ setupComplete: {} })).toEqual({ setupComplete: true });
    expect(parseServerMessage({ serverContent: { interimInputTranscription: { text: 'I think I' } } })).toEqual({ partial: 'I think I' });
    expect(parseServerMessage({ serverContent: { inputTranscription: { text: 'I think I left the oven on.' } } })).toEqual({ final: 'I think I left the oven on.' });
  });

  it('encodes 16-bit little-endian PCM', () => {
    const b64 = pcm16Base64(Float32Array.from([0, 1, -1, 0.5]));
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const v = new DataView(bytes.buffer);
    expect([v.getInt16(0, true), v.getInt16(2, true), v.getInt16(4, true), v.getInt16(6, true)]).toEqual([0, 32767, -32768, 16383]);
  });

  it('never talks over her: a reply that arrives after she started talking again is dropped', async () => {
    let release;
    const t = setup({ reply: () => new Promise((r) => (release = () => r({ reply_text: 'Ha, nice!', topic: 'day' }))) });
    await t.brain.start();
    t.brain.heard({ text: 'so today', final: true });
    t.clock.advance(TURN_SILENCE_MS); // her pause: the reply request goes out
    t.brain.heard({ text: 'and then', final: false }); // …but she keeps going
    release();
    await flush();
    expect(t.said).toEqual(['Hi! How was your day?']); // nothing said over her
    t.brain.heard({ text: 'and then my exam got moved', final: true });
    t.clock.advance(TURN_SILENCE_MS);
    await flush();
    release?.();
    await flush();
    expect(t.turns.at(-1).user_text).toBe('so today and then my exam got moved'); // answered together
  });

  it('says the time to home every 5 minutes, in miles, even if she is quiet', async () => {
    const t = setup(); // context: 6 min, 500 m to go
    await t.brain.start();
    t.clock.advance(ETA_GAP_MS - 1000);
    await flush();
    expect(t.said.some((x) => /minutes/.test(x))).toBe(false); // not before 5 minutes
    t.clock.advance(1000);
    await flush();
    expect(t.said.at(-1)).toBe('About 6 minutes to go, 0.3 miles left.');
    for (let i = 0; i < ETA_GAP_MS / 10000 + 1; i++) { // 10 s steps, like real time
      t.clock.advance(10000);
      await flush();
    }
    expect(t.said.filter((x) => /minutes/.test(x))).toHaveLength(2); // and again 5 minutes later
    expect(t.turns.every((x) => x.context.eta_due === false)).toBe(true); // the model never adds it on its own
  });

  it('waits for a quiet moment: no time update while she is talking', async () => {
    const t = setup();
    await t.brain.start();
    t.clock.advance(ETA_GAP_MS - 2000);
    await flush();
    t.brain.heard({ text: 'so anyway', final: false }); // she is mid-sentence at the 5-minute mark
    t.clock.advance(2000);
    await flush();
    expect(t.said.some((x) => /minutes to go/.test(x))).toBe(false);
    t.brain.heard({ text: 'so anyway the exam was fine', final: true });
    t.clock.advance(TURN_SILENCE_MS); // her turn gets answered first
    await flush();
    t.clock.advance(10000);
    await flush();
    const order = t.said.slice(1);
    expect(order[0]).toBe('Tell me more!');
    expect(order.some((x) => /minutes to go/.test(x))).toBe(true); // then the update
  });

  it('fills silences less and less often: 90 s, then twice as long', async () => {
    const t = setup();
    await t.brain.start();
    t.clock.advance(IDLE_MS);
    await flush();
    expect(t.turns.filter((x) => x.mode === 'idle')).toHaveLength(1);
    t.clock.advance(IDLE_MS); // 90 s more: not yet (the next one waits 3 min)
    await flush();
    expect(t.turns.filter((x) => x.mode === 'idle')).toHaveLength(1);
    t.clock.advance(IDLE_MS);
    await flush();
    expect(t.turns.filter((x) => x.mode === 'idle')).toHaveLength(2);
  });

  it('directions: spoken at once when quiet, after she finishes if she is talking, never during an alert', async () => {
    const t = setup();
    await t.brain.start();
    t.brain.navPrompt('In 200 feet, turn left onto Summit Street.');
    await flush();
    expect(t.said.at(-1)).toBe('In 200 feet, turn left onto Summit Street.');

    t.brain.heard({ text: 'so I was saying', final: false }); // she is mid-sentence
    t.brain.navPrompt('Turn left onto Summit Street.');
    t.clock.advance(1000);
    await flush();
    expect(t.said.at(-1)).not.toBe('Turn left onto Summit Street.'); // not over her
    t.clock.advance(1000); // she paused
    await flush();
    expect(t.said.at(-1)).toBe('Turn left onto Summit Street.');

    t.brain.alertState({ state: 'countdown', seconds_left: 10 });
    t.brain.navPrompt('Turn right.');
    t.clock.advance(1000);
    await flush();
    expect(t.said).not.toContain('Turn right.');
  });
});

describe('speech gain for transcription (quiet iPhone mics)', () => {
  const tone = (amp, n = 1600) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin(i / 5));
  const peak = (x) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

  it('brings quiet speech up, but no more than 6x', () => {
    const g = createSpeechGain();
    let out;
    for (let i = 0; i < 60; i++) out = g(tone(0.01));
    expect(peak(out)).toBeGreaterThan(0.05);
    expect(peak(out)).toBeLessThanOrEqual(0.061);
  });

  it('is driven by her voice only: background noise never raises the gain', () => {
    const g = createSpeechGain();
    for (let i = 0; i < 30; i++) g(tone(0.3), true); // she talked at a normal level
    let out;
    for (let i = 0; i < 60; i++) out = g(tone(0.005), false); // then only background
    expect(peak(out)).toBeLessThan(0.01);
  });

  it('leaves loud speech alone and never clips past full scale', () => {
    const g = createSpeechGain();
    let out;
    for (let i = 0; i < 30; i++) out = g(tone(0.8));
    expect(peak(out)).toBeCloseTo(0.8, 2);
    const q = createSpeechGain();
    for (let i = 0; i < 60; i++) q(tone(0.01));
    expect(peak(q(tone(0.9)))).toBeLessThanOrEqual(1);
  });
});

describe('voice gate: only her voice reaches transcription', () => {
  // Deterministic pseudo-noise (wind, traffic hum) and a voiced "speech" signal in the voice band.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const noise = (amp, n = 1600) => Float32Array.from({ length: n }, () => amp * rnd());
  const voice = (amp, n = 1600, f = 220) => Float32Array.from({ length: n }, (_, i) => amp * (Math.sin((2 * Math.PI * f * i) / 16000) + 0.5 * Math.sin((2 * Math.PI * 3 * f * i) / 16000)));
  const mix = (a, b) => a.map((v, i) => v + b[i]);
  const energy = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);

  it('stays closed on steady background noise (sends silence)', () => {
    const gate = createVoiceGate();
    let opened = 0;
    for (let i = 0; i < 100; i++) {
      const r = gate(noise(0.02));
      if (i > 20 && r.voice) opened++;
    }
    expect(opened).toBe(0);
  });

  it('opens for her voice close to the phone, including the chunk before her first word', () => {
    const gate = createVoiceGate();
    for (let i = 0; i < 40; i++) gate(noise(0.01));
    const onset = mix(noise(0.01), voice(0.2));
    const r1 = gate(onset); // decision looks one chunk ahead…
    expect(r1.voice).toBe(true); // …so the chunk just before her first word is sent too
    const r2 = gate(mix(noise(0.01), voice(0.2)));
    expect(r2.voice).toBe(true);
    expect(energy(r2.out)).toBeGreaterThan(0.1); // and the word itself goes out
  });

  it('ignores faint far-away voices but keeps short pauses inside her sentence', () => {
    const gate = createVoiceGate();
    for (let i = 0; i < 40; i++) gate(noise(0.01));
    let farOpen = 0;
    for (let i = 0; i < 30; i++) if (gate(mix(noise(0.01), voice(0.008))).voice) farOpen++;
    expect(farOpen).toBe(0); // someone across the street
    for (let i = 0; i < 5; i++) gate(mix(noise(0.01), voice(0.2)));
    const pause = [1, 2, 3].map(() => gate(noise(0.01)).voice); // a 300 ms breath
    expect(pause.every(Boolean)).toBe(true);
  });
});

describe('noise transcripts are ignored', () => {
  it('drops tags, filler and stray single words', () => {
    expect(isMeaningful('[noise]')).toBe(false);
    expect(isMeaningful('<music> ♪')).toBe(false);
    expect(isMeaningful('um hmm')).toBe(false);
    expect(isMeaningful('the')).toBe(false);
    expect(isMeaningful('banana')).toBe(false);
  });
  it('keeps real sentences and one-word answers', () => {
    expect(isMeaningful('i think i left the oven on')).toBe(true);
    expect(isMeaningful('yeah')).toBe(true);
    expect(isMeaningful('No.')).toBe(true);
    expect(isMeaningful('help')).toBe(true);
    expect(isMeaningful('yeah', { final: false })).toBe(false); // partial: wait for more
    expect(cleanTranscript('[noise] long day (laughs)')).toBe('long day');
  });
});
