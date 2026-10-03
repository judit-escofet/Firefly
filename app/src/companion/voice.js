// The firefly's voice: plays replies one at a time and reports companion.speaking on/off.
//
// Fixed lines (greeting, check-in prompts, "home safe"…) are pre-generated mp3s in
// /voice/manifest.json — instant and they work offline/mock. Everything else goes through
// /api/companion/speak (ElevenLabs). Playback uses the shared mic's AudioContext when there is
// one: it was resumed inside the user's tap, so iOS lets it play without another gesture.
// If audio can't be produced, the line is still "spoken" (event + caption) for a short time.

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

export function createVoice({ api, getContext = () => null, onSpeaking = () => {}, manifestUrl = '/voice/manifest.json' }) {
  let manifest = null; // {byText: Map(norm text → url), byId: {id: {text, file}}}
  const manifestLoad = fetch(manifestUrl)
    .then((r) => (r.ok ? r.json() : { lines: {} }))
    .then((m) => {
      manifest = { byId: m.lines ?? {}, byText: new Map(Object.values(m.lines ?? {}).map((l) => [norm(l.text), l.file])) };
    })
    .catch(() => {
      manifest = { byId: {}, byText: new Map() };
    });

  let speaking = false;
  let current = null; // {stop()}
  let queue = Promise.resolve();

  async function audioFor(text) {
    await manifestLoad;
    const file = manifest.byText.get(norm(text));
    if (file) {
      const r = await fetch(file);
      if (r.ok) return r.blob();
    }
    return api.speak(text);
  }

  function playBlob(blob) {
    const ctx = getContext();
    if (ctx && ctx.state !== 'closed') {
      return blob.arrayBuffer().then(
        (buf) =>
          new Promise((resolve, reject) => {
            ctx.decodeAudioData(
              buf,
              (decoded) => {
                const src = ctx.createBufferSource();
                src.buffer = decoded;
                src.connect(ctx.destination);
                src.onended = () => resolve();
                current = { stop: () => src.stop() };
                src.start();
              },
              reject,
            );
          }),
      );
    }
    return new Promise((resolve, reject) => {
      const el = new Audio(URL.createObjectURL(blob));
      el.onended = () => resolve();
      el.onerror = () => reject(new Error('audio playback failed'));
      current = { stop: () => (el.pause(), resolve()) };
      el.play().catch(reject);
    });
  }

  function setSpeaking(on, text) {
    if (speaking === on) return;
    speaking = on;
    onSpeaking(on, text);
  }

  // → resolves when the line has finished (or failed). `t0` = when the reply was needed, for latency.
  function say(text, { t0 = Date.now(), onStart } = {}) {
    queue = queue.then(async () => {
      if (!text) return;
      let blob = null;
      try {
        blob = await audioFor(text);
      } catch {}
      const latencyMs = Date.now() - t0;
      setSpeaking(true, text);
      onStart?.(latencyMs);
      try {
        if (blob) await playBlob(blob);
        else await new Promise((r) => setTimeout(r, Math.min(6000, 600 + text.length * 55))); // caption-only fallback
      } catch (err) {
        console.warn('[companion] playback failed', err);
      } finally {
        current = null;
        setSpeaking(false, text);
      }
    });
    return queue;
  }

  return {
    say,
    get speaking() {
      return speaking;
    },
    line: async (id) => {
      await manifestLoad;
      return manifest.byId[id]?.text ?? null;
    },
    stop() {
      current?.stop();
    },
  };
}
