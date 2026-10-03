import { describe, it, expect } from 'vitest';
import { createResampler, resample } from '../src/guardian/audio/resampler.js';
import {
  createWindower,
  frameSignal,
  createTriggerRule,
  yamnetOnlyScore,
  headScore,
  validateHead,
  WINDOW_SAMPLES,
  HOP_SAMPLES,
} from '../src/guardian/audio/windows.js';

const sine = (freq, rate, seconds) =>
  Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => Math.sin((2 * Math.PI * freq * i) / rate));

const rms = (x) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);

describe('resampler', () => {
  it('48 kHz → 16 kHz keeps a 1 kHz tone at the right length and level', () => {
    const out = resample(sine(1000, 48000, 1), 48000);
    expect(Math.abs(out.length - 16000)).toBeLessThan(10);
    expect(rms(out.slice(200, 15000))).toBeCloseTo(Math.SQRT1_2, 1);
  });

  it('removes content above the new Nyquist (anti-aliasing)', () => {
    const out = resample(sine(12000, 48000, 1), 48000);
    expect(rms(out.slice(200, 15000))).toBeLessThan(0.01);
  });

  it('streaming in odd-sized chunks equals one-shot', () => {
    const x = sine(440, 44100, 0.5);
    const whole = resample(x, 44100);
    const r = createResampler(44100);
    const parts = [];
    for (let i = 0; i < x.length; i += 333) parts.push(...r.push(x.subarray(i, i + 333)));
    expect(parts.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i++) expect(parts[i]).toBeCloseTo(whole[i], 6);
  });

  it('16 kHz input passes through unchanged', () => {
    const x = sine(440, 16000, 0.1);
    expect(Array.from(resample(x, 16000))).toEqual(Array.from(x));
  });
});

describe('windowing', () => {
  it('emits 15600-sample windows every 7680 samples', () => {
    const wins = [];
    const w = createWindower((x) => wins.push(x));
    const sig = Float32Array.from({ length: 16000 * 3 }, (_, i) => i);
    for (let i = 0; i < sig.length; i += 1000) w.push(sig.subarray(i, i + 1000));
    expect(wins.length).toBe(Math.floor((sig.length - WINDOW_SAMPLES) / HOP_SAMPLES) + 1);
    wins.forEach((win, i) => {
      expect(win.length).toBe(WINDOW_SAMPLES);
      expect(win[0]).toBe(i * HOP_SAMPLES);
    });
  });

  it('pads a short clip to one window', () => {
    expect(frameSignal(new Float32Array(5000))).toHaveLength(1);
  });
});

describe('scoring + trigger rule', () => {
  it('YAMNet-only score = max of Shout / Yell / Screaming', () => {
    const s = new Array(521).fill(0.01);
    s[6] = 0.2;
    s[9] = 0.4;
    s[11] = 0.3;
    s[0] = 0.99; // speech: ignored
    expect(yamnetOnlyScore(s)).toBe(0.4);
  });

  it('head score = sigmoid(w·e + b)', () => {
    const head = validateHead({ weights: new Array(1024).fill(0.5), bias: -1, threshold: 0.6 });
    const e = new Array(1024).fill(0);
    e[0] = 2;
    expect(headScore(head, e)).toBeCloseTo(0.5, 6);
    expect(() => validateHead({ weights: [1], bias: 0, threshold: 0.5 })).toThrow();
  });

  it('fused head score = sqrt(sigmoid(w·e + b) × yamnet score)', () => {
    const head = validateHead({ weights: new Array(1024).fill(0), bias: 0, threshold: 0.3, fusion: 'geomean_yamnet' });
    expect(headScore(head, new Array(1024).fill(1), 0.32)).toBeCloseTo(Math.sqrt(0.5 * 0.32), 9);
    expect(() => validateHead({ ...head, fusion: 'mystery' })).toThrow();
  });

  it('triggers on 2 of the last 3 windows ≥ threshold, then clears', () => {
    const rule = createTriggerRule({ threshold: 0.5 });
    expect(rule.push(0.9).triggered).toBe(false);
    expect(rule.push(0.1).triggered).toBe(false);
    expect(rule.push(0.7).triggered).toBe(true);
    expect(rule.push(0.8).triggered).toBe(false); // history cleared
  });

  it('isolated spikes never trigger', () => {
    const rule = createTriggerRule({ threshold: 0.5 });
    const scores = [0.9, 0.1, 0.1, 0.9, 0.1, 0.2, 0.95, 0.0, 0.3];
    expect(scores.some((s) => rule.push(s).triggered)).toBe(false);
  });
});
