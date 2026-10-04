// P1 Companion: the firefly's personality, reply shaping, check-in classification, memory.

const { generateJson } = require('./gemini');

const MODES = new Set(['chat', 'checkin', 'calm', 'idle']);

// The fixed system prompt from the P1 spec (Azure OpenAI there; Gemini here).
function systemPrompt({ name, mode, memory = [], news = [], context = {} }) {
  const eta = Number.isFinite(context.eta_s) ? `${Math.max(1, Math.round(context.eta_s / 60))} minutes to home` : 'unknown';
  const miles = context.remaining_m / 1609.344;
  const dist = !Number.isFinite(context.remaining_m) ? 'unknown'
    : miles >= 0.1 ? `${miles.toFixed(1)} miles left` : `about ${Math.round((context.remaining_m * 3.28084) / 10) * 10} feet left`;
  const modeText = {
    chat: 'chat: just talking, like friends on a walk-home call.',
    idle: `chat, but she has been quiet for a while: casually bring up ONE thing, like a friend would (a news item, or something from MEMORY), as a statement more than a question. Do not say she was quiet.`,
    checkin: `checkin: ask gently, in a natural way, if she's okay${context.checkin_reason ? ` (reason: ${context.checkin_reason}, but don't say the reason robotically)` : ''}. E.g. "Hey, you've gone quiet. Everything alright?"`,
    calm: 'calm: sound completely normal and relaxed, keep her talking about light everyday things (her day, food, plans, music). Never say anything that would alert someone nearby, and never use words like safe, safely, careful, worry, scared or hurry.',
  }[mode];
  // Style rules from voice-agent research: say it's spoken, describe audible behaviour (not
  // adjectives), show good and bad examples, ban assistant phrases, and repeat the key rules.
  return [
    `You are Firefly, ${name || 'her'}'s close friend. You're on the phone with her while she walks home at night`,
    'through an enchanted forest. Everything you write is SPOKEN ALOUD by a voice, so write exactly how a friend talks on the phone.',
    '',
    'HOW YOU TALK (spoken, not written):',
    "- Short. Usually one sentence, sometimes two. Most replies are under 20 words. If a person couldn't say it in one breath, it's too long.",
    "- Contractions always (I'm, you're, that's, don't, it's). Everyday words. No lists, no formal words, no emojis.",
    "- Start sentences with And, But, So, Oh, Wait, Ha, Okay when it fits. A small \"hmm\" or \"oh\" now and then is fine; don't overdo it.",
    '- React to the exact thing she said first, in your own words (use her details: names, places, what happened).',
    '- Have opinions and a bit of personality: tease gently, agree, disagree, share a tiny thing about your own night.',
    "- Don't interview her. Most replies are NOT questions. Ask one only now and then, and never two replies in a row.",
    "- Match her energy: low-key when she's tired, playful when she's playful. Calm by default.",
    "- NEVER sound like an assistant. Never say: \"That's great!\", \"That sounds amazing\", \"Absolutely\", \"I understand\",",
    "  \"I'm here for you\", \"How can I help\", \"Great question\", \"It's important to\", \"Remember to\", \"Feel free\". No advice unless she asks.",
    '- Never repeat a line or an opener you already used. Remember what she tells you.',
    '',
    'EXAMPLES (bad → good):',
    "- She: \"long day, my exam was rough\". Bad: \"I'm sorry to hear that! Exams can be really challenging. How do you feel it went?\"",
    '  Good: "Ugh, the stats one? You were dreading that all week."',
    "- She: \"I got pizza after\". Bad: \"That sounds delicious! What kind of pizza did you get?\" Good: \"Okay, that's the correct way to end an exam day.\"",
    "- She: \"lol yeah\". Bad: \"I'm glad you're in good spirits!\" Good: \"Ha. So, any plans for the weekend or just sleep?\"",
    "- She: \"idk I'm just tired\". Bad: \"It's important to get rest. Remember to take care of yourself.\" Good: \"Yeah. Couch, blanket, done. You've earned it.\"",
    '',
    'RULES:',
    '- Do NOT bring up time or distance to home (the app announces it). If she asks, answer from CONTEXT in a few words.',
    '- Only mention news from NEWS below, naming the source. Never invent news.',
    '- Never lecture about safety. Never mention alerts, police, emergencies or danger.',
    '- If she says she is hurt, harmed, bleeding, dying or needs help, never brush it off or tell her to keep walking:',
    "  answer warmly and briefly that you are right here with her and staying with her (e.g. \"I'm right here with you. Stay with me.\"), then keep her talking.",
    `MODE: ${modeText}`,
    `MEMORY: ${memory.length ? memory.map((f) => `- ${f}`).join('\n') : '(nothing yet)'}`,
    `NEWS: ${news.length ? news.slice(0, 3).map((n) => `- ${n.title} (${n.source})`).join('\n') : '(none)'}`,
    context.eta_due
      ? `CONTEXT: ETA due: mention it once, naturally (${eta}, ${dist}).`
      : `CONTEXT: (${eta}, ${dist}; don't mention it unless she asks.)`,
    '',
    'REMEMBER: spoken, short, contractions, react to her words, mostly not questions, never assistant phrases.',
    'Respond as JSON: {"reply_text": string, "topic": one of day|news|eta|memory|checkin|smalltalk|other, "memory_saved": boolean}.',
    'memory_saved is true only if she just told you a lasting personal fact worth remembering next walk.',
  ].join('\n');
}

const REPLY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    reply_text: { type: 'STRING' },
    topic: { type: 'STRING' },
    memory_saved: { type: 'BOOLEAN' },
  },
  required: ['reply_text', 'topic', 'memory_saved'],
};

// C3: 1-2 sentences, < 35 words, at most one question — enforced even if the model slips.
// Drops whole sentences rather than cutting one mid-way (it is spoken aloud).
function shapeReply(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return "I'm here with you.";
  const sentences = t.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [t];
  const out = [];
  let questions = 0;
  let words = 0;
  for (const s of sentences) {
    const n = s.split(' ').length;
    if (out.length === 2 || (out.length && words + n > 34)) break;
    if (s.endsWith('?')) {
      if (questions === 1) break;
      questions += 1;
    }
    out.push(s);
    words += n;
  }
  let reply = out.join(' ');
  if (words > 34) {
    // A single very long sentence: cut at the last comma/dash inside the limit.
    const head = reply.split(' ').slice(0, 34).join(' ');
    const cut = Math.max(head.lastIndexOf(','), head.lastIndexOf(' —'), head.lastIndexOf(' -'));
    reply = `${(cut > 20 ? head.slice(0, cut) : head).replace(/[,;:\s]+$/, '')}.`;
  }
  return reply;
}

// ---- sounding human ----
// Assistant-speak openers the model sometimes slips into ("That's great!", "Absolutely!").
const ASSISTANT_OPENER = /^(?:(?:oh,?\s+)?(?:that's|that is|that sounds|sounds|what an?)\s+(?:so\s+|really\s+)?(?:great|amazing|awesome|wonderful|fantastic|lovely|interesting|exciting|delicious|fun)[!.,]?\s+|absolutely[!.,]?\s+|i understand[!.,]?\s+|great question[!.,]?\s+|certainly[!.,]?\s+|of course[!.,]?\s+)/i;
// Contract only when a word follows: "it is fine" → "it's fine", but "I know what it is." stays.
const CONTRACTIONS = [
  ['I am', "I'm"], ['I will', "I'll"], ['you are', "you're"], ['it is', "it's"], ['that is', "that's"],
  ['do not', "don't"], ['does not', "doesn't"], ['did not', "didn't"], ['cannot', "can't"], ['will not', "won't"],
  ['we are', "we're"], ['they are', "they're"], ['let us', "let's"], ['is not', "isn't"], ['are not', "aren't"],
  ['would not', "wouldn't"], ['could not', "couldn't"], ['should not', "shouldn't"], ['there is', "there's"],
];

// Makes a reply sound spoken: no assistant openers, no emojis, contractions, at most one "!".
function humanize(text) {
  let t = String(text ?? '').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '').replace(/\s+/g, ' ').trim();
  const stripped = t.replace(ASSISTANT_OPENER, '');
  if (stripped !== t && stripped.length >= 8) t = stripped[0].toUpperCase() + stripped.slice(1);
  for (const [long, short] of CONTRACTIONS) {
    t = t.replace(new RegExp(`\\b${long}\\b(?=\\s+[A-Za-z])`, 'gi'), (m) => (m[0] !== m[0].toLowerCase() && short[0] !== 'I' ? short[0].toUpperCase() + short.slice(1) : short));
  }
  let bangs = 0;
  t = t.replace(/!+/g, () => (bangs++ ? '.' : '!')); // friends on the phone at night aren't that loud
  return t;
}

// Never let calm mode (or any mode) say the forbidden words out loud.
const FORBIDDEN = /\b(alert|alerts|alerted|police|911|emergency|danger|dangerous|countdown|sos|unsafe|help is on)\b/i;
// Extra words that would give the situation away to someone nearby while an alert is running.
const CALM_FORBIDDEN = /\b(safe|safely|safety|careful|worried|worry|scared|afraid|hurry|run|someone|behind you|following)\b/i;

async function companionTurn({ name, user_text, mode = 'chat', context = {}, memory = [], news = [], history = [] }) {
  if (!MODES.has(mode)) mode = 'chat';
  const contents = [];
  for (const h of history.slice(-8)) {
    if (!h?.text) continue;
    contents.push({ role: h.speaker === 'firefly' ? 'model' : 'user', parts: [{ text: String(h.text).slice(0, 500) }] });
  }
  const said = String(user_text ?? '').trim();
  contents.push({
    role: 'user',
    // Her words as she said them (a "She said: …" frame nudges the model into narrator voice).
    parts: [{ text: said ? said.slice(0, 500) : '(She is quiet. Say your next line.)' }],
  });
  const t0 = Date.now();
  const { model, data } = await generateJson({
    system: systemPrompt({ name, mode, memory, news, context }),
    contents,
    schema: REPLY_SCHEMA,
    temperature: 0.9, // more varied, less templated replies
    maxOutputTokens: 120,
    timeoutMs: 2500, // a stalled model falls through to the next one (C2: speak within 3 s)
  });
  let reply = shapeReply(humanize(data.reply_text));
  if (mode === 'calm' && (FORBIDDEN.test(reply) || CALM_FORBIDDEN.test(reply))) {
    reply = "So what was the best part of today?";
  } else if (FORBIDDEN.test(reply)) {
    reply = shapeReply(reply.replace(new RegExp(FORBIDDEN.source, 'gi'), '').replace(/\s{2,}/g, ' '));
  }
  return {
    reply_text: reply,
    topic: typeof data.topic === 'string' ? data.topic : 'other',
    memory_saved: Boolean(data.memory_saved),
    model,
    latency_ms: Date.now() - t0,
  };
}

// ---- check-in answers: keyword rules first, Gemini only for unclear answers (spec) ----

const NOT_OK = /\b(no|nope|not (ok|okay|good|fine|great|really)|help|scared|afraid|followed|following me|someone('s| is) (behind|following)|hurt|i'?m not|stop|get away|leave me alone|call|please)\b/i;
const OK = /\b(yes|yeah|yep|yup|ya|i'?m (ok|okay|fine|good|alright|all right|great)|(all )?good|fine|okay|ok|all right|alright|sure|no worries|totally|just (stopped|tying|looking|checking|getting)|tying my shoe)\b/i;

function classifyCheckinKeywords(text) {
  const t = String(text ?? '').toLowerCase().trim();
  if (!t) return null;
  const notOk = NOT_OK.test(t);
  const ok = OK.test(t);
  // "no, I'm fine" / "no worries" → ok; plain "no" or "help" → not ok
  if (/^\s*no\b[ ,.!]*(i'?m|all|it'?s)\s+(fine|good|ok|okay|alright|all right)/.test(t) || /\bno worries\b/.test(t)) return true;
  if (/\b(not|n'?t)\s+(really\s+)?(ok|okay|fine|good|alright|all right|great)\b/.test(t)) return false; // "not okay", "I'm not really fine"
  if (notOk && !ok) return false;
  if (ok && !notOk) return true;
  return undefined; // unclear → ask the model
}

async function classifyCheckin(text) {
  const kw = classifyCheckinKeywords(text);
  if (kw !== undefined) return { ok: kw, method: 'keywords' };
  try {
    const { data } = await generateJson({
      system:
        'You classify a woman\'s spoken answer to "Are you okay?" during a walk home. ' +
        'Return {"ok": true} if she is fine, {"ok": false} if she is not okay, scared, being followed or asking for help, ' +
        'and {"ok": null} if the answer is unrelated or unclear. When in doubt between fine and not fine, choose false.',
      contents: [{ role: 'user', parts: [{ text: String(text).slice(0, 300) }] }],
      schema: { type: 'OBJECT', properties: { ok: { type: 'BOOLEAN', nullable: true } }, required: ['ok'] },
      temperature: 0,
      maxOutputTokens: 64,
      timeoutMs: 3000,
    });
    return { ok: data.ok === true ? true : data.ok === false ? false : null, method: 'model' };
  } catch {
    return { ok: null, method: 'error' };
  }
}

// ---- memory: up to 5 short facts per walk, latest 15 kept ----

async function extractFacts(turns) {
  const transcript = turns
    .filter((t) => t?.text)
    .slice(-60)
    .map((t) => `${t.speaker === 'firefly' ? 'Firefly' : 'Her'}: ${String(t.text).slice(0, 300)}`)
    .join('\n');
  if (!transcript.trim()) return [];
  const { data } = await generateJson({
    system:
      'From this walk-home conversation, extract up to 5 short lasting facts about HER worth remembering next walk ' +
      '(e.g. "Has a data structures exam Friday", "Loves the Knicks"). Only things she said about herself. ' +
      'No safety incidents, no locations, no contact details. Return {"facts": [string]}.',
    contents: [{ role: 'user', parts: [{ text: transcript }] }],
    schema: { type: 'OBJECT', properties: { facts: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['facts'] },
    temperature: 0.2,
    maxOutputTokens: 200,
  });
  return (data.facts ?? []).filter((f) => typeof f === 'string' && f.trim()).map((f) => f.trim().slice(0, 120)).slice(0, 5);
}

module.exports = { systemPrompt, shapeReply, humanize, companionTurn, classifyCheckinKeywords, classifyCheckin, extractFacts, FORBIDDEN, CALM_FORBIDDEN };
