// Rolling 15 s buffer of 16 kHz mono audio, kept only in memory on the phone.
// capture() keeps the last 5 s and resolves once 5 s more have arrived → a 10 s clip around
// the trigger. Nothing here touches the network; the state machine uploads the clip only
// when an alert (or duress) actually fires.
//
// Why PCM/WAV instead of MediaRecorder: MediaRecorder's 1 s webm/mp4 chunks can't be cut from a
// rolling buffer (only the first chunk has the container header), and iOS Safari and Chrome emit
// different containers. We already have 16 kHz PCM for YAMNet, so a 10 s 16-bit WAV is exact,
// portable, and 320 KB (limit 2 MB).

export function createClipBuffer({ sampleRate = 16000, keepS = 15, beforeS = 5, afterS = 5 } = {}) {
  const cap = sampleRate * keepS;
  const ring = new Float32Array(cap);
  let written = 0; // total samples ever written
  const pending = []; // {startAbs, endAbs, resolve}

  function read(startAbs, endAbs) {
    const out = new Float32Array(endAbs - startAbs);
    for (let a = Math.max(startAbs, written - cap, 0); a < endAbs; a++) out[a - startAbs] = ring[a % cap];
    return out;
  }

  return {
    push(samples) {
      for (let i = 0; i < samples.length; i++) ring[(written + i) % cap] = samples[i];
      written += samples.length;
      for (let i = pending.length - 1; i >= 0; i--) {
        const p = pending[i];
        if (written >= p.endAbs) {
          pending.splice(i, 1);
          p.resolve(read(p.startAbs, p.endAbs));
        }
      }
    },
    // → Promise<Float32Array> of (beforeS + afterS) seconds, zero-padded if we have less history.
    capture() {
      const startAbs = written - beforeS * sampleRate;
      const endAbs = written + afterS * sampleRate;
      return new Promise((resolve) => pending.push({ startAbs, endAbs, resolve }));
    },
    get seconds() {
      return Math.min(written, cap) / sampleRate;
    },
  };
}

export function encodeWav(samples, sampleRate = 16000) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}
