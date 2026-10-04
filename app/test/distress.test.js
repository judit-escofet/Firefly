import { describe, it, expect } from 'vitest';
import { detectDistress, createDistressSpotter } from '../src/guardian/distress.js';
import { createFakeClock } from '../src/guardian/clock.js';

describe('distress phrases start the countdown', () => {
  it.each([
    'I was stabbed',
    "I've been stabbed",
    'I died',
    "I'm dying",
    "I've been harmed",
    'I have been hurt',
    "I'm bleeding",
    'I got shot',
    'someone attacked me',
    'he has a knife',
    'help me',
    'somebody help',
    'call the police',
    "I can't breathe",
    'get off me',
    "I think I'm going to die",
  ])('triggers on "%s"', (text) => {
    expect(detectDistress(text)).toBeTruthy();
  });

  it.each([
    "I'm dying to see that movie",
    'I died laughing',
    "I'm dead tired",
    'my phone is dead',
  ])('ignores the figure of speech "%s"', (text) => {
    expect(detectDistress(text)).toBeNull();
  });

  it('ignores ordinary walk chatter', () => {
    for (const t of ['long day, my exam was rough', 'I love this song', 'how far is home', 'I think I left the TV on'])
      expect(detectDistress(t)).toBeNull();
  });

  it('works on partial speech results and fires once per 30 s', () => {
    const clock = createFakeClock();
    const hits = [];
    const s = createDistressSpotter({ clock, onMatch: (m) => hits.push(m.phrase) });
    s.heard({ text: 'I was', final: false });
    s.heard({ text: 'I was stabbed', final: false });
    s.heard({ text: 'I was stabbed please', final: true });
    expect(hits).toEqual(['i was stabbed']);
    clock.advance(31000);
    s.heard({ text: 'help me', final: true });
    expect(hits).toHaveLength(2);
  });
});
