// Echo filter: when the firefly's voice comes out of a phone speaker, the mic hears it and the
// transcriber writes it down. Those transcripts must not count as her words (C4) — but her own
// words while the firefly talks MUST still get through (the Guardian listens for the code
// phrase in speech.heard). So instead of muting, we drop only text that matches what the
// firefly is saying, and treat anything else as her interrupting.

const words = (s) => String(s).toLowerCase().replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter(Boolean);

// → true if `heard` is (mostly) the firefly's own line coming back through the speaker.
export function isEcho(heard, spokenText) {
  const h = words(heard);
  if (!h.length || !spokenText) return false;
  const spoken = new Set(words(spokenText));
  const overlap = h.filter((w) => spoken.has(w)).length / h.length;
  return h.length >= 2 ? overlap >= 0.6 : overlap === 1;
}
