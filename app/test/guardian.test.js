import { describe, it, expect, afterEach, vi } from 'vitest';
import * as bus from '../src/bus.js';
import { startGuardian } from '../src/guardian/index.js';
import { createFakeClock } from '../src/guardian/clock.js';
import { createClipBuffer, encodeWav } from '../src/guardian/audio/clipBuffer.js';
import { createScoreLog } from '../src/guardian/scoreLog.js';
import { createApi } from '../src/guardian/api.js';

const flush = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('clip buffer (G11)', () => {
  it('captures 5 s before + 5 s after the trigger = 10 s', async () => {
    const buf = createClipBuffer();
    const sec = (v, s = 1) => new Float32Array(16000 * s).fill(v);
    for (let i = 1; i <= 20; i++) buf.push(sec(i)); // seconds 1..20, value = second number
    const clip = buf.capture();
    for (let i = 21; i <= 26; i++) buf.push(sec(i));
    const pcm = await clip;
    expect(pcm.length).toBe(160000);
    expect(pcm[0]).toBe(16); // starts 5 s before the trigger (after second 20)
    expect(pcm[16000 * 5 - 1]).toBe(20);
    expect(pcm[16000 * 5]).toBe(21); // first second after the trigger
    expect(pcm.at(-1)).toBe(25);
  });

  it('zero-pads when less than 5 s of history exists', async () => {
    const buf = createClipBuffer();
    buf.push(new Float32Array(16000).fill(0.5));
    const clip = buf.capture();
    buf.push(new Float32Array(16000 * 5).fill(0.25));
    const pcm = await clip;
    expect(pcm.length).toBe(160000);
    expect(pcm[0]).toBe(0);
    expect(pcm[16000 * 4]).toBe(0.5);
  });

  it('encodes a 10 s mono 16-bit WAV well under the 2 MB limit', async () => {
    const blob = encodeWav(new Float32Array(160000));
    expect(blob.size).toBe(44 + 320000);
    expect(blob.type).toBe('audio/wav');
    const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    expect(String.fromCharCode(...head.slice(0, 4))).toBe('RIFF');
  });
});

describe('score log', () => {
  it('posts numbers every 30 s, in batches of ≤ 200', async () => {
    const clock = createFakeClock();
    const posts = [];
    const log = createScoreLog({ clock, post: async (s) => posts.push(s) });
    log.start();
    for (let i = 0; i < 62; i++) log.add({ ts: `t${i}`, scream_score: 0.123456, triggered: false });
    clock.advance(30000);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toHaveLength(62);
    expect(posts[0][0]).toEqual({ ts: 't0', scream_score: 0.1235, triggered: false, score: 0.1235, label: null });
    clock.advance(30000);
    expect(posts).toHaveLength(1); // nothing new → no empty POST

    const fetchCalls = [];
    const api = createApi({ getWalkId: () => 'w_1', mock: false, fetchImpl: async (url, init) => {
      fetchCalls.push([url, JSON.parse(init.body).scores.length]);
      return { ok: true, json: async () => ({ saved: JSON.parse(init.body).scores.length }) };
    } });
    const res = await api.postScores(Array.from({ length: 450 }, () => ({ ts: 'x', scream_score: 0, triggered: false })));
    expect(fetchCalls).toEqual([['/api/walks/w_1/scores', 200], ['/api/walks/w_1/scores', 200], ['/api/walks/w_1/scores', 50]]);
    expect(res.saved).toBe(450);
  });
});

describe('guardian wired to the bus (G10, G11, G12)', () => {
  let g;
  afterEach(() => g?.stop());

  function boot() {
    const clock = createFakeClock();
    const requests = [];
    vi.stubGlobal('fetch', async (url, init) => {
      requests.push({ url, body: init.body });
      if (url.endsWith('/clip')) return { ok: true, json: async () => ({ clip_url: 'https://blob/clip.wav' }) };
      return { ok: true, json: async () => ({ ok: true, notified: ['+1555'] }) };
    });
    g = startGuardian({ mock: false, mic: false, debug: false, clock });
    const states = [];
    bus.on('alert.state', (e) => states.push(e.state));
    bus.emit('walk.started', { walk_id: 'w_456', share_url: 'x', route: { points: [], distance_m: 0, eta_s: 0 } });
    // Fake mic: 1 s of 16 kHz audio per simulated second, as the detector would deliver it.
    // Yields after each second so promise callbacks run between timers, as with real time.
    const tick = async (seconds) => {
      for (let i = 0; i < seconds; i++) {
        g.pushAudio(new Float32Array(16000).fill(0.1));
        clock.advance(1000);
        await flush(2);
      }
    };
    for (let i = 0; i < 6; i++) g.pushAudio(new Float32Array(16000).fill(0.1));
    return { clock, requests, states, tick };
  }
  const posted = (requests, path) => requests.filter((r) => r.url.endsWith(path));

  it('scream → countdown → alerted posts alert_sent with a 10 s clip', async () => {
    const { requests, states, tick } = boot();
    bus.emit('danger.signal', { source: 'scream', confidence: 0.9, detail: 'test' });
    expect(g.sm.state).toBe('countdown');
    await tick(10);
    await flush();
    expect(states).toContain('alerted');
    const clips = posted(requests, '/clip');
    expect(clips).toHaveLength(1);
    expect(clips[0].body.size).toBe(44 + 320000);
    const events = posted(requests, '/events').map((r) => JSON.parse(r.body));
    expect(events.map((e) => e.type)).toEqual(['countdown_started', 'alert_sent']);
    expect(events[1].clip_url).toBe('https://blob/clip.wav');
  });

  it('cancel PIN: no audio is ever uploaded', async () => {
    const { requests, tick } = boot();
    bus.emit('danger.signal', { source: 'code_phrase', confidence: 0.9, detail: 'test' });
    await tick(3);
    bus.emit('pin.entered', { kind: 'cancel' });
    await tick(30);
    await flush();
    expect(posted(requests, '/clip')).toHaveLength(0);
    expect(posted(requests, '/events').map((r) => JSON.parse(r.body).type)).toEqual(['countdown_started', 'alert_cancelled']);
  });

  it('duress PIN: screen shows resolved, but duress is posted with the clip', async () => {
    const { requests, states, tick } = boot();
    bus.emit('danger.signal', { source: 'scream', confidence: 0.9, detail: 'test' });
    await tick(2);
    bus.emit('pin.entered', { kind: 'duress' });
    expect(states.at(-1)).toBe('resolved');
    await tick(4);
    await flush();
    const events = posted(requests, '/events').map((r) => JSON.parse(r.body));
    expect(events.map((e) => e.type)).toEqual(['countdown_started', 'duress']);
    expect(events[1].clip_url).toBe('https://blob/clip.wav');
  });

  it('code phrase heard in speech → danger.signal → countdown', () => {
    boot();
    const signals = [];
    bus.on('danger.signal', (e) => signals.push(e));
    bus.emit('speech.heard', { text: 'oh no I think I left the oven', final: false });
    expect(signals.map((s) => s.source)).toEqual(['code_phrase']);
    expect(g.sm.state).toBe('countdown');
  });

  it('no mic audio: alert still goes out, just without a clip', async () => {
    const clock = createFakeClock();
    const requests = [];
    vi.stubGlobal('fetch', async (url, init) => {
      requests.push({ url, body: init.body });
      return { ok: true, json: async () => ({ ok: true }) };
    });
    g = startGuardian({ mock: false, mic: false, debug: false, clock });
    bus.emit('walk.started', { walk_id: 'w_1' });
    bus.emit('danger.signal', { source: 'scream', confidence: 0.9 });
    clock.advance(10000);
    await flush();
    expect(requests.filter((r) => r.url.endsWith('/clip'))).toHaveLength(0);
    expect(JSON.parse(requests.at(-1).body)).toMatchObject({ type: 'alert_sent', clip_url: null });
  });

  it('check-in: two unanswered → countdown', () => {
    boot();
    const reqs = [];
    bus.on('checkin.request', (e) => reqs.push(e));
    bus.emit('danger.signal', { source: 'off_route', confidence: 0.6, detail: 'test' });
    expect(reqs).toHaveLength(1);
    bus.emit('checkin.answered', { ok: null, text: '' });
    bus.emit('checkin.answered', { ok: null, text: '' });
    expect(g.sm.state).toBe('countdown');
  });
});
