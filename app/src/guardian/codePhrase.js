// Code-phrase spotting over streaming speech-to-text.
//
// For every speech.heard (partial or final): normalise, keep the last ~12 words, slide windows of
// (phrase length ± 2) words over them and score each against the phrase. A window matches when
//   1. the character-level Levenshtein ratio of the joined window vs the phrase is ≥ 0.8, and
//   2. in the cheapest word alignment of window → phrase, every content word of the phrase
//      (e.g. "think", "left", "oven") lines up with a window word, or two merged window words
//      (STT often splits words: "oven" → "of in"), at char ratio ≥ 0.5.
// Rule 2 stops "i think i left the tv on" from matching just because most words are shared.

export const DEFAULT_CODE_PHRASE = 'i think i left the oven on';
export const PHRASE_STORAGE_KEY = 'firefly.code_phrase';

const STOPWORDS = new Set(
  'a an the and or but i im ive me my we you your it its is are was were be been am to of in on at for with from this that these those there here so just then what when have has had do does did not no yes'.split(
    ' ',
  ),
);

export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  let cur = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const sub = prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, sub);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

export function ratio(a, b) {
  const n = Math.max(a.length, b.length);
  return n === 0 ? 1 : 1 - levenshtein(a, b) / n;
}

function isContent(w) {
  return w.length >= 3 && !STOPWORDS.has(w);
}

// Word-level alignment of window → target. Ops: substitute (cost 1 − ratio), merge two window
// words into one target word (cost 1 − ratio), skip a window word or a target word (cost 1).
// Returns the char ratio each target word got in the cheapest alignment (0 if skipped).
export function alignWords(win, target) {
  const n = win.length;
  const m = target.length;
  const cost = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(Infinity));
  const back = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(null));
  cost[0][0] = 0;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const c = cost[i][j];
      if (c === Infinity) continue;
      const relax = (ni, nj, add, op, r) => {
        if (c + add < cost[ni][nj]) {
          cost[ni][nj] = c + add;
          back[ni][nj] = { i, j, op, r };
        }
      };
      if (i < n) relax(i + 1, j, 1, 'skip_win', 0);
      if (j < m) relax(i, j + 1, 1, 'skip_target', 0);
      if (i < n && j < m) {
        const r = ratio(win[i], target[j]);
        relax(i + 1, j + 1, 1 - r, 'sub', r);
      }
      if (i + 1 < n && j < m) {
        const r = ratio(win[i] + win[i + 1], target[j]);
        relax(i + 2, j + 1, 1 - r + 0.01, 'merge', r); // tiny bias: prefer a plain substitution on ties
      }
    }
  }
  const perTarget = new Array(m).fill(0);
  for (let i = n, j = m; i > 0 || j > 0; ) {
    const b = back[i][j];
    if (b.op === 'sub' || b.op === 'merge') perTarget[b.j] = b.r;
    ({ i, j } = b);
  }
  return perTarget;
}

// Returns {score, matched, window} for the best window in `text`.
export function scorePhrase(text, phrase, { threshold = 0.8, maxWords = 12, contentMin = 0.5 } = {}) {
  const words = normalize(text).slice(-maxWords);
  const target = normalize(phrase);
  if (!target.length || !words.length) return { score: 0, matched: false, window: '' };
  const targetStr = target.join(' ');
  const contentIdx = target.map((w, k) => (isContent(w) ? k : -1)).filter((k) => k >= 0);
  let best = { score: 0, matched: false, window: '' };
  for (let len = Math.max(1, target.length - 2); len <= target.length + 2; len++) {
    for (let start = 0; start + len <= words.length || (start === 0 && len > words.length); start++) {
      const win = words.slice(start, start + len);
      const score = ratio(win.join(' '), targetStr);
      let matched = score >= threshold;
      if (matched && contentIdx.length) {
        const aligned = alignWords(win, target);
        matched = contentIdx.every((k) => aligned[k] >= contentMin);
      }
      if (matched > best.matched || (matched === best.matched && score > best.score)) {
        best = { score, matched, window: win.join(' ') };
      }
      if (len > words.length) break;
    }
  }
  return best;
}

// Stateful spotter: feed speech.heard events; calls onMatch at most once per cooldown.
export function createCodePhraseSpotter({ getPhrase, onMatch, clock, cooldownS = 30, threshold = 0.8 }) {
  let lastMatchAt = -Infinity;
  return {
    heard({ text }) {
      if (clock.now() - lastMatchAt < cooldownS * 1000) return null;
      const result = scorePhrase(text, getPhrase(), { threshold });
      if (!result.matched) return null;
      lastMatchAt = clock.now();
      onMatch(result);
      return result;
    },
  };
}

export function loadCodePhrase(storage = globalThis.localStorage) {
  try {
    return storage?.getItem(PHRASE_STORAGE_KEY) || DEFAULT_CODE_PHRASE;
  } catch {
    return DEFAULT_CODE_PHRASE;
  }
}
