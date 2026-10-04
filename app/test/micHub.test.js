import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Fake Web Audio + getUserMedia, enough to drive the mic hub the way an iPhone misbehaves:
// audio arrives for a moment, then simply stops.
const nodes = [];
let contexts = [];
let gumCalls = [];

class FakeNode {
  constructor() {
    this.port = { onmessage: null };
    nodes.push(this);
  }
  connect(n) {
    return n;
  }
  disconnect() {}
  push(samples) {
    this.port.onmessage?.({ data: samples });
  }
}

class FakeCtx {
  constructor(opts = {}) {
    this.sampleRate = opts.sampleRate ?? 48000;
    this.state = 'running';
    this.destination = {};
    this.audioWorklet = { addModule: async () => {} };
    contexts.push(this);
  }
  resume() {
    if (this.state !== 'closed') this.state = 'running';
    return Promise.resolve();
  }
  close() {
    this.state = 'closed';
    return Promise.resolve();
  }
  createMediaStreamSource() {
    return { connect: (n) => n, disconnect() {} };
  }
  createGain() {
    return { gain: { value: 1 }, connect: (n) => n, disconnect() {} };
  }
}

function fakeStream() {
  const track = { readyState: 'live', muted: false, getSettings: () => ({ sampleRate: 48000 }), stop() { this.readyState = 'ended'; } };
  return { getAudioTracks: () => [track], getTracks: () => [track] };
}

const speech = () => Float32Array.from({ length: 2048 }, (_, i) => 0.1 * Math.sin(i / 7));

let mod;
beforeEach(async () => {
  vi.useFakeTimers();
  nodes.length = 0;
  contexts = [];
  gumCalls = [];
  vi.stubGlobal('AudioContext', FakeCtx);
  vi.stubGlobal('AudioWorkletNode', FakeNode);
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('document', { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' });
  vi.stubGlobal('navigator', {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1',
    platform: 'iPhone',
    maxTouchPoints: 5,
    mediaDevices: { getUserMedia: async (c) => (gumCalls.push(c), fakeStream()) },
  });
  vi.resetModules();
  mod = await import('../src/audio/micHub.js');
});

afterEach(() => {
  mod.currentMic()?.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('mic hub on iPhone', () => {
  it('asks iOS for echo cancellation (keeps capture alive while the firefly talks)', async () => {
    const mic = mod.acquireMic();
    await mic.ready;
    expect(gumCalls[0].audio.echoCancellation).toBe(true);
    expect(mod.micConstraints(false).audio.echoCancellation).toBe(false); // desktop/Android stay raw
  });

  it('notices audio stopping and gets it flowing again on its own', async () => {
    const mic = mod.acquireMic();
    const got = [];
    mic.subscribe((x) => got.push(x.length));
    await mic.ready;
    nodes.at(-1).push(speech());
    expect(got.length).toBe(1);
    expect(mic.level).toBeGreaterThan(0);

    // …then nothing. The meter must drop to zero, not freeze on the last value.
    await vi.advanceTimersByTimeAsync(800);
    expect(mic.level).toBe(0);
    await vi.advanceTimersByTimeAsync(3000);
    expect(mic.stats.recoveries).toBeGreaterThanOrEqual(1);
    expect(contexts.length).toBeGreaterThan(1); // rebuilt on a fresh context
    expect(contexts[0].state).toBe('closed');

    // The new capture node delivers to the same subscribers.
    nodes.at(-1).push(speech());
    expect(got.length).toBe(2);
    expect(mic.stalled).toBe(false);
  });

  it('a tap revives a stalled mic with a fresh context and a fresh stream', async () => {
    const mic = mod.acquireMic();
    await mic.ready;
    nodes.at(-1).push(speech());
    await vi.advanceTimersByTimeAsync(1500);
    const before = gumCalls.length;
    mic.revive();
    await vi.advanceTimersByTimeAsync(10);
    expect(mic.stats.revived).toBe(1);
    expect(gumCalls.length).toBe(before + 1);
    nodes.at(-1).push(speech());
    expect(mic.level).toBeGreaterThan(0);
  });

  it('stops auto-recovering after a few tries instead of looping forever', async () => {
    const mic = mod.acquireMic();
    await mic.ready;
    await vi.advanceTimersByTimeAsync(60000); // a dead mic for a minute
    expect(mic.stats.recoveries).toBeLessThanOrEqual(8);
    expect(mic.stalled).toBe(true); // the UI shows "Tap to wake the mic"
  });
});
