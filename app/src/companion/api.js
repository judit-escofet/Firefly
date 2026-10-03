// Companion API client (P1's endpoints under /api). With mock: true — or when a call fails —
// it answers with canned lines so the walk keeps going with all APIs off (C12).

const CANNED = {
  chat: [
    "That sounds like a lot. What's one good thing that happened today?",
    'I hear you. What are you having for dinner tonight?',
    "Nice! Tell me more, I'm listening.",
    "We're getting closer. What's the plan when you get home?",
  ],
  idle: ['How is the walk going so far?', "What's been on your mind today?", 'Listened to any good music lately?'],
  checkin: ['Hey, just checking in. Everything alright?'],
  calm: ["Tell me about the best part of your day.", 'What are you going to cook tonight?', "What's the next show you want to watch?"],
};

export function createCompanionApi({ mock = false, base = '/api', fetchImpl = globalThis.fetch } = {}) {
  let i = 0;
  const canned = (mode) => {
    const list = CANNED[mode] ?? CANNED.chat;
    return { reply_text: list[i++ % list.length], topic: 'other', memory_saved: false, canned: true };
  };

  async function post(path, body, { timeoutMs = 8000, raw = false } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${base}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return raw ? res : res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    mock,

    // {user_id, walk_id, user_text, mode, context, history, news, name} → {reply_text, topic, memory_saved}
    async turn(body) {
      if (mock) return canned(body.mode);
      try {
        return await post('companion/turn', body);
      } catch (err) {
        console.warn(`[companion] turn failed (${err.message}); using a canned line`);
        return canned(body.mode);
      }
    },

    // → Blob (audio/mpeg) or null (then the voice falls back to a pre-generated line or text only)
    async speak(text) {
      if (mock) return null;
      try {
        const res = await post('companion/speak', { text, voice: 'firefly' }, { raw: true });
        return await res.blob();
      } catch (err) {
        console.warn(`[companion] speak failed (${err.message})`);
        return null;
      }
    },

    // Model classification for unclear check-in answers → true | false | null
    async checkin(text) {
      if (mock) return null;
      try {
        return (await post('companion/checkin', { text }, { timeoutMs: 3500 })).ok ?? null;
      } catch {
        return null;
      }
    },

    async end(body) {
      if (mock) return { facts: [], saved: 0 };
      try {
        return await post('companion/end', body, { timeoutMs: 15000 });
      } catch (err) {
        console.warn(`[companion] memory save failed (${err.message})`);
        return { facts: [], saved: 0 };
      }
    },

    async news(interests) {
      if (mock) return [];
      try {
        const res = await fetchImpl(`${base}/news?interests=${encodeURIComponent(interests.join(','))}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()).items ?? [];
      } catch {
        return [];
      }
    },

    async speechToken() {
      const res = await fetchImpl(`${base}/speech-token`);
      if (!res.ok) throw new Error(`speech-token HTTP ${res.status}`);
      return res.json();
    },
  };
}
