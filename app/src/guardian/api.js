// Thin fetch wrapper for P3's endpoints. In mock mode (?mock=1), or when a request fails,
// it logs to the console and returns a plausible fake response so the flow keeps going.

export function isMockMode(search = globalThis.location?.search ?? '') {
  return new URLSearchParams(search).get('mock') === '1';
}

export function createApi({ getWalkId, mock = isMockMode(), fetchImpl = globalThis.fetch, base = '/api' } = {}) {
  const url = (path) => `${base}/walks/${encodeURIComponent(getWalkId() ?? 'no-walk')}/${path}`;

  async function call(path, { logBody, ...init }, fake) {
    if (mock || !fetchImpl) {
      console.info(`[guardian:api:mock] POST ${url(path)}`, logBody);
      return fake;
    }
    try {
      const res = await fetchImpl(url(path), init);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      console.warn(`[guardian:api] POST ${url(path)} failed (${err.message}); logged locally`, logBody);
      return fake;
    }
  }

  return {
    // body: {type, source, confidence, clip_url}
    postEvent(body) {
      const payload = { clip_url: null, ...body, ts: body.ts ?? new Date().toISOString() };
      return call(
        'events',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), logBody: payload },
        { ok: true, notified: [], mock: true },
      );
    },

    // The ONLY place audio leaves the phone. Called only when an alert / duress fires.
    async uploadClip(blob) {
      const res = await call(
        'clip',
        { method: 'POST', headers: { 'Content-Type': blob.type || 'audio/wav' }, body: blob, logBody: `<${blob.size} bytes ${blob.type}>` },
        { clip_url: mock ? `mock://clip/${Date.now()}.wav` : null },
      );
      return res?.clip_url ?? null;
    },

    // scores: [{ts, scream_score, triggered}] — numbers only, max 200 per call.
    async postScores(scores) {
      let saved = 0;
      for (let i = 0; i < scores.length; i += 200) {
        const batch = scores.slice(i, i + 200);
        const res = await call(
          'scores',
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scores: batch }), logBody: `${batch.length} scores` },
          { saved: batch.length },
        );
        saved += res?.saved ?? 0;
      }
      return { saved };
    },
  };
}
