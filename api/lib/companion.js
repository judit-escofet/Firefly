// P1 Companion: the firefly's personality, reply shaping, check-in classification, memory.

const { generateJson } = require('./gemini');

const MODES = new Set(['chat', 'checkin', 'calm', 'idle']);

// The fixed system prompt from the P1 spec (Azure OpenAI there; Gemini here).
function systemPrompt({ name, mode, memory = [], news = [], context = {} }) {
  const eta = Number.isFinite(context.eta_s) ? `${Math.max(1, Math.round(context.eta_s / 60))} minutes to home` : 'unknown';
  const dist = Number.isFinite(context.remaining_m) ? `${Math.round(context.remaining_m)} m left` : 'unknown';
  const modeText = {
    chat: 'chat: normal friendly conversation.',
    idle: 'chat, but she has been quiet for a while: gently offer ONE topic (one news item, her ETA, or something from MEMORY). Do not say she was quiet.',
    checkin: `checkin: ask gently, in a natural way, if she's okay${context.checkin_reason ? ` (reason: ${context.checkin_reason}, but don't say the reason robotically)` : ''}. E.g. "Hey, you've gone quiet. Everything alright?"`,
    calm: 'calm: sound completely normal and relaxed, keep her talking about light everyday things (her day, food, plans, music). Never say anything that would alert someone nearby, and never use words like safe, safely, careful, worry, scared or hurry.',
  }[mode];
  return [
    `You are Firefly, a warm, curious companion walking ${name || 'someone'} home at night`,
    'through an enchanted forest. You talk like a kind friend on the phone.',
    '- Keep every reply to 1-2 short sentences (under 35 words).',
    '- Ask at most one question. Remember what she tells you.',
    '- Mention time to home now and then, using CONTEXT (e.g. "about 6 minutes to go").',
    '- Only mention news from NEWS below, naming the source. Never invent news.',
    '- Never lecture about safety. Never mention alerts, police, emergencies or danger.',
    '- If she says she is hurt, harmed, bleeding, dying or needs help, never brush it off or tell her to keep walking:',
    "  answer warmly and briefly that you are right here with her and staying with her (e.g. \"I'm right here with you. Stay with me.\"), then keep her talking.",
    `MODE: ${modeText}`,
    `MEMORY: ${memory.length ? memory.map((f) => `- ${f}`).join('\n') : '(nothing yet)'}`,
    `NEWS: ${news.length ? news.slice(0, 3).map((n) => `- ${n.title} (${n.source})`).join('\n') : '(none)'}`,
    `CONTEXT: ${eta}, ${dist}.`,
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
    parts: [{ text: said ? `She said: "${said.slice(0, 500)}"` : '(She is quiet. Say your next line.)' }],
  });
  const t0 = Date.now();
  const { model, data } = await generateJson({
    system: systemPrompt({ name, mode, memory, news, context }),
    contents,
    schema: REPLY_SCHEMA,
    temperature: 0.7,
    maxOutputTokens: 120,
    timeoutMs: 2500, // a stalled model falls through to the next one (C2: speak within 3 s)
  });
  let reply = shapeReply(data.reply_text);
  if (mode === 'calm' && (FORBIDDEN.test(reply) || CALM_FORBIDDEN.test(reply))) {
    reply = "Tell me more about your day, what's the best thing that happened?";
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

module.exports = { systemPrompt, shapeReply, companionTurn, classifyCheckinKeywords, classifyCheckin, extractFacts, FORBIDDEN, CALM_FORBIDDEN };
