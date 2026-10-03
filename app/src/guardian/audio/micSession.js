// Opens the audio session synchronously, inside the user's tap.
//
// iOS Safari only lets an AudioContext start (resume) from within a user-gesture handler, and
// anything after an `await` is no longer "inside" the gesture. So the AudioContext and the
// getUserMedia request are created here, synchronously, before the (slow) YAMNet model loads.
// Kept free of TF.js so it can be imported statically by the guardian and the test page.

export function beginMicSession() {
  const Ctx = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  if (!Ctx || !navigator.mediaDevices?.getUserMedia) {
    const why = !globalThis.isSecureContext
      ? 'microphone needs HTTPS (or localhost)'
      : 'this browser has no Web Audio / microphone support';
    return { ctx: null, stream: Promise.reject(new Error(why)) };
  }
  const ctx = new Ctx();
  ctx.resume?.().catch(() => {});
  const stream = navigator.mediaDevices.getUserMedia({
    // Raw-ish audio: noise suppression / AGC would flatten exactly the screams we want to hear.
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
  });
  stream.catch(() => {}); // surfaced by whoever awaits it
  return { ctx, stream };
}

// Test input: plays an audio file into the detector instead of the mic, through the exact same
// live path (AudioContext → worklet → resampler → YAMNet → head → 2-of-3 rule). Call start()
// once the detector is listening; resolves {startedAt} (AudioContext time, seconds).
export function beginFileSession(url) {
  const Ctx = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  const ctx = new Ctx();
  ctx.resume?.().catch(() => {});
  const dest = ctx.createMediaStreamDestination();
  const buffer = fetch(url)
    .then((r) => {
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      return r.arrayBuffer();
    })
    .then((b) => ctx.decodeAudioData(b));
  return {
    ctx,
    stream: Promise.resolve(dest.stream),
    async start() {
      const src = ctx.createBufferSource();
      src.buffer = await buffer;
      src.connect(dest);
      const startedAt = ctx.currentTime + 0.05;
      src.start(startedAt);
      return { startedAt, duration: src.buffer.duration };
    },
  };
}
