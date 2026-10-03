import { describe, it, expect, beforeEach } from 'vitest';
import { createStateMachine } from '../src/guardian/stateMachine.js';
import { createFakeClock } from '../src/guardian/clock.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(overrides = {}) {
  const clock = createFakeClock();
  const emitted = [];
  const logged = [];
  const uploads = [];
  const clip = {
    captures: 0,
    capture() {
      this.captures += 1;
      return Promise.resolve(new Blob(['fake-wav']));
    },
    upload(blob) {
      uploads.push(blob);
      return Promise.resolve('https://clips.example/abc.wav');
    },
  };
  const sm = createStateMachine({
    clock,
    clip,
    emit: (type, payload) => emitted.push({ type, ...payload }),
    logEvent: async (body) => logged.push(body),
    ...overrides,
  });
  const states = () => emitted.filter((e) => e.type === 'alert.state').map((e) => e.state);
  return { sm, clock, emitted, logged, uploads, clip, states };
}

describe('state machine — one test per table row', () => {
  let t;
  beforeEach(() => (t = setup()));

  it('idle → checking_in on a check-in trigger, emits checkin.request', () => {
    t.sm.danger({ source: 'long_stop', confidence: 0.6 });
    expect(t.sm.state).toBe('checking_in');
    const req = t.emitted.find((e) => e.type === 'checkin.request');
    expect(req.reason).toBe('long_stop');
    expect(typeof req.prompt).toBe('string');
    expect(t.states()).toEqual(['checking_in']);
  });

  it('checking_in → idle on ok:true, logs checkin', () => {
    t.sm.checkinTrigger('off_route');
    t.sm.answer(true);
    expect(t.sm.state).toBe('idle');
    expect(t.logged.map((l) => l.type)).toEqual(['checkin']);
  });

  it('checking_in → countdown on ok:false', () => {
    t.sm.checkinTrigger('off_route');
    t.sm.answer(false);
    expect(t.sm.state).toBe('countdown');
    expect(t.sm.secondsLeft).toBe(10);
  });

  it('checking_in → countdown on two ok:null in a row (asks again after the first)', () => {
    t.sm.checkinTrigger('long_stop');
    t.sm.answer(null);
    expect(t.sm.state).toBe('checking_in');
    expect(t.emitted.filter((e) => e.type === 'checkin.request')).toHaveLength(2);
    t.sm.answer(null);
    expect(t.sm.state).toBe('countdown');
    const sig = t.emitted.find((e) => e.type === 'danger.signal');
    expect(sig.source).toBe('no_response');
  });

  it('idle → countdown on scream; logs countdown_started and starts the clip', () => {
    t.sm.danger({ source: 'scream', confidence: 0.91 });
    expect(t.sm.state).toBe('countdown');
    expect(t.logged[0]).toMatchObject({ type: 'countdown_started', source: 'scream', confidence: 0.91 });
    return flush().then(() => expect(t.clip.captures).toBe(1));
  });

  it('checking_in → countdown on code phrase', async () => {
    t.sm.checkinTrigger('long_stop');
    t.sm.danger({ source: 'code_phrase', confidence: 0.85 });
    expect(t.sm.state).toBe('countdown');
    expect(t.logged[0]).toMatchObject({ type: 'countdown_started', source: 'code_phrase' });
    await flush();
    expect(t.clip.captures).toBe(1);
  });

  it('countdown → resolved on cancel PIN, logs alert_cancelled, uploads nothing', async () => {
    t.sm.danger({ source: 'scream', confidence: 0.9 });
    t.clock.advance(3000);
    t.sm.pin('cancel');
    expect(t.sm.state).toBe('resolved');
    expect(t.logged.map((l) => l.type)).toEqual(['countdown_started', 'alert_cancelled']);
    t.clock.advance(20000);
    await flush();
    expect(t.uploads).toHaveLength(0);
  });

  it('countdown → resolved on duress PIN: looks cancelled, but posts duress with the clip', async () => {
    t.sm.danger({ source: 'scream', confidence: 0.9 });
    t.clock.advance(2000);
    const sent = t.sm.pin('duress');
    expect(t.sm.state).toBe('resolved');
    // What the screen sees is identical to a cancel.
    const last = t.emitted.filter((e) => e.type === 'alert.state').at(-1);
    expect(last).toEqual({ type: 'alert.state', state: 'resolved', seconds_left: null });
    await sent;
    const duress = t.logged.find((l) => l.type === 'duress');
    expect(duress).toMatchObject({ source: 'scream', clip_url: 'https://clips.example/abc.wav' });
    expect(t.logged.some((l) => l.type === 'alert_cancelled')).toBe(false);
  });

  it('countdown → alerted after 10 s, emits seconds_left every second, posts alert_sent with clip_url', async () => {
    t.sm.danger({ source: 'scream', confidence: 0.9 });
    for (let i = 0; i < 9; i++) t.clock.advance(1000);
    expect(t.sm.state).toBe('countdown');
    expect(t.sm.secondsLeft).toBe(1);
    t.clock.advance(1000);
    expect(t.sm.state).toBe('alerted');
    const secs = t.emitted.filter((e) => e.state === 'countdown').map((e) => e.seconds_left);
    expect(secs).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    await flush();
    await flush();
    expect(t.logged.at(-1)).toMatchObject({
      type: 'alert_sent',
      source: 'scream',
      clip_url: 'https://clips.example/abc.wav',
    });
  });

  it('alerted → idle on walk.ended', () => {
    t.sm.danger({ source: 'scream' });
    t.clock.advance(10000);
    expect(t.sm.state).toBe('alerted');
    t.sm.walkEnded();
    expect(t.sm.state).toBe('idle');
  });

  it('resolved → idle after 20 s, ignoring new screams meanwhile', () => {
    t.sm.danger({ source: 'scream' });
    t.sm.pin('cancel');
    t.clock.advance(19000);
    expect(t.sm.danger({ source: 'scream' })).toBe(false);
    expect(t.sm.state).toBe('resolved');
    t.clock.advance(1000);
    expect(t.sm.state).toBe('idle');
    expect(t.sm.danger({ source: 'scream' })).toBe(true);
    expect(t.sm.state).toBe('countdown');
  });
});

describe('state machine — edge cases', () => {
  it('counts a check-in with no answer at all as ok:null (companion silent)', () => {
    const t = setup();
    t.sm.checkinTrigger('long_stop');
    t.clock.advance(25000);
    expect(t.sm.state).toBe('checking_in');
    t.clock.advance(25000);
    expect(t.sm.state).toBe('countdown');
  });

  it('ignores screams during countdown and alerted', () => {
    const t = setup();
    t.sm.danger({ source: 'scream' });
    expect(t.sm.danger({ source: 'scream' })).toBe(false);
    t.clock.advance(10000);
    expect(t.sm.danger({ source: 'code_phrase' })).toBe(false);
  });

  it('walk.ended does not cancel a running countdown', () => {
    const t = setup();
    t.sm.danger({ source: 'scream' });
    t.sm.walkEnded();
    expect(t.sm.state).toBe('countdown');
  });

  it('sends alert_sent without clip_url when the clip is not ready in time', async () => {
    const t = setup({
      clip: { capture: () => new Promise(() => {}), upload: async () => 'never' },
    });
    t.sm.danger({ source: 'scream' });
    t.clock.advance(10000);
    await flush();
    t.clock.advance(4000);
    await flush();
    expect(t.logged.at(-1)).toMatchObject({ type: 'alert_sent', clip_url: null });
  });
});
