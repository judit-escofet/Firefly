// Check-in answer keywords, in the browser so a clear answer is classified instantly
// (checkin.answered within 1 s of her last word). Mirrors classifyCheckinKeywords() in
// api/lib/companion.js — keep the two in sync; unclear answers go to /api/companion/checkin.

const NOT_OK = /\b(no|nope|not (ok|okay|good|fine|great|really)|help|scared|afraid|followed|following me|someone('s| is) (behind|following)|hurt|i'?m not|stop|get away|leave me alone|call|please)\b/i;
const OK = /\b(yes|yeah|yep|yup|ya|i'?m (ok|okay|fine|good|alright|all right|great)|(all )?good|fine|okay|ok|all right|alright|sure|no worries|totally|just (stopped|tying|looking|checking|getting)|tying my shoe)\b/i;

// → true (ok) | false (not ok) | null (silence) | undefined (unclear: ask the model)
export function classifyCheckinKeywords(text) {
  const t = String(text ?? '').toLowerCase().trim();
  if (!t) return null;
  if (/^\s*no\b[ ,.!]*(i'?m|all|it'?s)\s+(fine|good|ok|okay|alright|all right)/.test(t) || /\bno worries\b/.test(t)) return true;
  if (/\b(not|n'?t)\s+(really\s+)?(ok|okay|fine|good|alright|all right|great)\b/.test(t)) return false;
  const notOk = NOT_OK.test(t);
  const ok = OK.test(t);
  if (notOk && !ok) return false;
  if (ok && !notOk) return true;
  return undefined;
}
