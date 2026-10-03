import { describe, it, expect } from 'vitest';
import { scorePhrase, createCodePhraseSpotter, DEFAULT_CODE_PHRASE, normalize } from '../src/guardian/codePhrase.js';
import { createFakeClock } from '../src/guardian/clock.js';

const PHRASE = DEFAULT_CODE_PHRASE; // "i think i left the oven on"

// Speech-to-text style variants: casing, punctuation, filler words, merged/split/misheard words.
const POSITIVES = [
  'I think I left the oven on.',
  'oh no i think i left the oven on',
  'I THINK I LEFT THE OVEN ON!!',
  "i think i've left the oven on",
  'i think i left the of in on',
  'i think i left the oven onn',
  'i thing i left the oven on',
  'i think i lift the oven on',
  'i think left the oven on',
  'yeah so anyway i think i left the oven on okay bye',
];

// Similar-sounding everyday sentences that must NOT trigger.
const NEAR_MISSES = [
  'i think i left the door open',
  'i think i left the lights on',
  'i think i left the tv on',
  'i think i left my phone at home',
  'i think the oven is on',
  'did you leave the oven on',
  'i think i need to turn the oven on',
  'i left the keys in the oven',
  'i think i left the window open',
  'i think i left the stove on',
];

describe('code phrase', () => {
  it.each(POSITIVES)('matches STT variant: %s', (text) => {
    const r = scorePhrase(text, PHRASE);
    expect(r.matched, `score ${r.score.toFixed(3)} window "${r.window}"`).toBe(true);
  });

  it.each(NEAR_MISSES)('does not match near-miss: %s', (text) => {
    const r = scorePhrase(text, PHRASE);
    expect(r.matched, `score ${r.score.toFixed(3)} window "${r.window}"`).toBe(false);
  });

  it('matches on a growing partial transcript once the phrase completes', () => {
    expect(scorePhrase('i think i left', PHRASE).matched).toBe(false);
    expect(scorePhrase('i think i left the oven', PHRASE).matched).toBe(true); // 1 word short is still ≥ 0.8
  });

  it('only looks at the last ~12 words', () => {
    const old = 'i think i left the oven on ' + 'and then we walked over to the park near the library again';
    expect(scorePhrase(old, PHRASE).matched).toBe(false);
  });

  it('normalizes punctuation and apostrophes', () => {
    expect(normalize("I've LEFT, the oven—on!")).toEqual(['ive', 'left', 'the', 'oven', 'on']);
  });

  it('spotter fires once, then ignores matches for 30 s', () => {
    const clock = createFakeClock();
    const hits = [];
    const spotter = createCodePhraseSpotter({ getPhrase: () => PHRASE, onMatch: (r) => hits.push(r), clock });
    spotter.heard({ text: 'i think i left the oven', final: false });
    spotter.heard({ text: 'i think i left the oven on', final: true });
    expect(hits).toHaveLength(1);
    clock.advance(29000);
    spotter.heard({ text: 'i think i left the oven on', final: true });
    expect(hits).toHaveLength(1);
    clock.advance(1000);
    spotter.heard({ text: 'i think i left the oven on', final: true });
    expect(hits).toHaveLength(2);
  });
});
