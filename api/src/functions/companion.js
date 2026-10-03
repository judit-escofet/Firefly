// P1 Companion endpoints (team plan + P1 spec), Gemini + ElevenLabs instead of Azure OpenAI/Speech:
//   POST /api/companion/turn     → {reply_text, topic, memory_saved, latency_ms}
//   POST /api/companion/speak    → audio/mpeg (the firefly's ElevenLabs voice)
//   POST /api/companion/checkin  → {ok: true|false|null}   (classify her answer to "are you okay?")
//   POST /api/companion/end      → {facts, saved}           (memory: up to 5 facts per walk)
//   GET  /api/news?interests=…   → {items: [{title, source, url, published, blurb}]} (max 5)
//   GET  /api/speech-token       → {token, expires_at, model, url} for live transcription
// Keys live only in server settings (GEMINI_API_KEY, ELEVENLABS_API_KEY), never in the browser.
const { app } = require('../../lib/router');
const { handle, readJson, json, badRequest } = require('../../lib/http');
const { companionTurn, classifyCheckin, extractFacts } = require('../../lib/companion');
const { speak } = require('../../lib/eleven');
const { getNews } = require('../../lib/news');
const { transcriptionToken } = require('../../lib/gemini');
const store = require('../../lib/companionStore');

const MODES = ['chat', 'checkin', 'calm', 'idle'];
const memoryCache = new Map(); // user_id → {at, facts}

const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const userIdOf = (v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : 'u_demo');
const walkIdOf = (v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(v) ? v : null);

async function memoriesFor(userId) {
  const hit = memoryCache.get(userId);
  if (hit && Date.now() - hit.at < 60e3) return hit.facts;
  const facts = await store.loadMemories(userId).catch(() => []);
  memoryCache.set(userId, { at: Date.now(), facts });
  return facts;
}

app.http('companion-turn', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'companion/turn',
  handler: handle(async (request, context) => {
    const body = await readJson(request);
    const mode = body.mode ?? 'chat';
    if (!MODES.includes(mode)) throw badRequest(`mode must be one of ${MODES.join(', ')}`);
    const userId = userIdOf(body.user_id);
    const walkId = walkIdOf(body.walk_id);
    const ctx = body.context && typeof body.context === 'object' ? body.context : {};
    const news = Array.isArray(body.news)
      ? body.news.slice(0, 5).map((n) => ({ title: str(n?.title, 200), source: str(n?.source, 60) })).filter((n) => n.title)
      : [];
    const history = Array.isArray(body.history)
      ? body.history.slice(-8).map((h) => ({ speaker: h?.speaker === 'firefly' ? 'firefly' : 'user', text: str(h?.text) }))
      : [];
    const result = await companionTurn({
      name: str(body.name, 40) || undefined,
      user_text: str(body.user_text),
      mode,
      context: { eta_s: num(ctx.eta_s), remaining_m: num(ctx.remaining_m), checkin_reason: str(ctx.checkin_reason, 40) || null },
      memory: await memoriesFor(userId),
      news,
      history,
    });
    // Call record: written after the reply is computed; never blocks or fails the turn.
    if (walkId) {
      const now = Date.now();
      store
        .logTurns([
          ...(str(body.user_text) ? [{ ts: new Date(now - 1), walk_id: walkId, speaker: 'user', text: str(body.user_text), mode }] : []),
          { ts: new Date(now), walk_id: walkId, speaker: 'firefly', text: result.reply_text, mode, latency_ms: num(body.client_latency_ms) ?? result.latency_ms, model: result.model },
        ])
        .catch((err) => context.warn(`conversation_turns write failed: ${err.message}`));
    }
    return json(200, {
      reply_text: result.reply_text,
      topic: result.topic,
      memory_saved: result.memory_saved,
      latency_ms: result.latency_ms,
    });
  }),
});

app.http('companion-speak', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'companion/speak',
  handler: handle(async (request) => {
    const body = await readJson(request);
    const text = str(body.text, 400);
    if (!text) throw badRequest('text is required');
    if (body.voice !== undefined && body.voice !== 'firefly') throw badRequest('voice must be "firefly"');
    const mp3 = await speak(text);
    return { status: 200, body: mp3, headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' } };
  }),
});

app.http('companion-checkin', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'companion/checkin',
  handler: handle(async (request) => {
    const body = await readJson(request);
    const { ok, method } = await classifyCheckin(str(body.text, 300));
    return json(200, { ok, method });
  }),
});

app.http('companion-end', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'companion/end',
  handler: handle(async (request, context) => {
    const body = await readJson(request);
    const userId = userIdOf(body.user_id);
    const turns = Array.isArray(body.turns) ? body.turns.slice(-80).map((t) => ({ speaker: t?.speaker === 'firefly' ? 'firefly' : 'user', text: str(t?.text) })) : [];
    if (!turns.some((t) => t.speaker === 'user' && t.text)) return json(200, { facts: [], saved: 0 });
    const facts = await extractFacts(turns);
    const saved = await store.saveMemories(userId, facts, walkIdOf(body.walk_id)).catch((err) => {
      context.warn(`memories write failed: ${err.message}`);
      return 0;
    });
    memoryCache.delete(userId);
    return json(200, { facts, saved });
  }),
});

app.http('news', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'news',
  handler: handle(async (request) => {
    const interests = (request.query.get('interests') || '').split(',').map((s) => s.slice(0, 40)).filter(Boolean);
    return json(200, { items: (await getNews(interests)).map(({ interest, ...n }) => n) });
  }),
});

app.http('speech-token', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'speech-token',
  handler: handle(async () => json(200, await transcriptionToken())),
});
