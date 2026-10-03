import { describe, it, expect } from 'vitest';
import { createBrain, TURN_SILENCE_MS, IDLE_MS, CHECKIN_SILENCE_MS, NEWS_GAP_MS } from '../src/companion/brain.js';
import { classifyCheckinKeywords } from '../src/companion/checkinWords.js';
import { parseServerMessage, pcm16Base64 } from '../src/companion/stt.js';
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
    for (let s = 0; s < NEWS_GAP_MS / 1000 + 60; s++) {
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
});
