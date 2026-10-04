// Distress-phrase spotting over streaming speech-to-text: "I've been stabbed", "I'm bleeding",
// "I'm dying", "help me", "call the police"... Each match emits danger.signal {source: 'distress'},
// which starts the same 10-second countdown as a scream. If she doesn't enter her PIN, the alert
// goes out and the demo dispatcher is called.
//
// Tuned to over-trigger (golden rule: a missed cry for help is worse than a false alarm, and every
// alarm can be cancelled with the PIN during the countdown). Obvious figures of speech are skipped.

import { normalize } from './codePhrase.js';

// Normalised text: lowercase, apostrophes removed ("I'm" → "im"), punctuation → spaces.
const HARM = '(stabbed|shot|hurt|harmed|injured|attacked|assaulted|raped|kidnapped|robbed|mugged|grabbed|beaten|beat up|choked|strangled|bleeding|dying|dead|unconscious|drugged|abducted|cut)';
const SUBJECT = '(i|im|i am|ive|i have|ive been|i have been|i was|i got|i been|i just got|i just been|she|shes|she was|she got|he|hes)';

const PATTERNS = [
  new RegExp(`\\b${SUBJECT} (been |being |just )?${HARM}\\b`),
  /\b(stabbed|shot|attacked|raped|kidnapped|choking|strangling) me\b/,
  /\b(he|she|they|someone|somebody|a man|a guy) (stabbed|shot|attacked|hit|grabbed|hurt|choked|cut|is following|is attacking|is hurting|has a (knife|gun))\b/,
  /\bi died\b/,
  /\b(im|i am) (gonna|going to) die\b/,
  /\b(cant|can not|cannot) breathe\b/,
  /\bcall (the )?(police|cops|911|nine one one|an ambulance|ambulance|for help)\b/,
  /\b(help me|somebody help|someone help|please help|help help)\b/,
  /\b(get off me|let me go|leave me alone|dont touch me|stop hurting me)\b/,
  /\b(knife|gun|weapon)\b.*\b(me|him|her)\b/,
];

// Common figures of speech that contain the words above but aren't distress.
const NOT_DISTRESS = [
  /\bdying (to|for|of laughter|laughing)\b/,
  /\bdied (laughing|of laughter|of embarrassment|inside)\b/,
  /\b(dead|died) (tired|serious|set|end|line|lines)\b/,
  /\b(my|the) (phone|battery|car|laptop) (is |was |just )?(dead|dying|died)\b/,
  /\bkilling it\b/,
  /\bhurt (my|your|his|her) feelings\b/,
  /\bshot (a|the) (photo|picture|video|movie|film)\b/,
];

// Returns the matched snippet, or null.
export function detectDistress(text) {
  const t = normalize(text).join(' ');
  if (!t) return null;
  if (NOT_DISTRESS.some((re) => re.test(t))) return null;
  for (const re of PATTERNS) {
    const m = re.exec(t);
    if (m) return m[0];
  }
  return null;
}

// Watches speech.heard (partial and final) and calls onMatch at most once per cooldown.
export function createDistressSpotter({ onMatch, clock, cooldownS = 30 }) {
  let lastMatchAt = -Infinity;
  return {
    heard({ text }) {
      if (clock.now() - lastMatchAt < cooldownS * 1000) return null;
      const hit = detectDistress(text);
      if (!hit) return null;
      lastMatchAt = clock.now();
      onMatch({ phrase: hit, text });
      return hit;
    },
  };
}
