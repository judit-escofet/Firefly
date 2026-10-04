// Transcripts that are really background noise: speech-to-text sometimes returns tags like
// "[noise]" or "<music>", filler ("um", "hmm"), or a single stray word caught from someone nearby.
// Those shouldn't make the firefly reply, or cut it off mid-sentence.
//
// cleanTranscript(text) → the text without noise tags/symbols ('' if nothing is left)
// isMeaningful(text, { final }) → worth reacting to?

const TAGS = /\[[^\]]*\]|<[^>]*>|\([^)]*\)|\*[^*]*\*|[♪♫🎵🎶]/g;
const FILLER = new Set(['uh', 'um', 'umm', 'uhm', 'hmm', 'hm', 'mm', 'mmm', 'mhm', 'ah', 'oh', 'eh', 'er', 'erm', 'huh', 'ha', 'haha', 'ooh', 'ow']);
// One-word replies that do mean something (check-in answers, greetings, asking for help).
const SHORT_OK = new Set([
  'yes', 'yeah', 'yep', 'yup', 'no', 'nope', 'nah', 'okay', 'ok', 'fine', 'good', 'great', 'sure', 'thanks',
  'hi', 'hey', 'hello', 'help', 'stop', 'wait', 'what', 'why', 'really', 'cool', 'nice', 'bye', 'safe', 'home',
]);

export function cleanTranscript(text = '') {
  return String(text).replace(TAGS, ' ').replace(/\s+/g, ' ').trim();
}

export function isMeaningful(text, { final = true } = {}) {
  const clean = cleanTranscript(text);
  if (!/[a-z]/i.test(clean)) return false;
  const words = clean.toLowerCase().match(/[a-z']+/g) ?? [];
  const real = words.filter((w) => !FILLER.has(w.replace(/'/g, '')));
  if (real.length === 0) return false;
  // Partials grow word by word; wait for two words before reacting to one in progress.
  if (real.length === 1) return final ? SHORT_OK.has(real[0].replace(/'/g, '')) : false;
  return true;
}
