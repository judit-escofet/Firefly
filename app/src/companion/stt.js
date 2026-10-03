// Live speech-to-text from the shared mic: Gemini Live (gemini-3.5-transcribe-live) over a
// WebSocket, authorised with a single-use token from /api/speech-token (the key never reaches
// the browser). Streams 100 ms chunks of 16 kHz PCM16; the server streams back cumulative
// partial hypotheses ("interim") and a final transcript when she pauses.
//
//   onPartial(text)  — cumulative text of the utterance in progress
//   onFinal(text)    — the finished utterance
//   isMuted()        — optional: send silence instead of the mic while true. The companion
//                      does NOT mute while the firefly speaks (her code phrase must still be
//                      heard); it filters the firefly's own echo instead (echo.js).
//
// A Live session lasts ≤ 10 minutes, so a fresh one is opened every ~8 minutes (handover
// happens while she isn't mid-sentence) and after any drop, with backoff.

const CHUNK = 1600; // 100 ms at 16 kHz
const SESSION_MS = 8 * 60e3;

export function pcm16Base64(float32) {
  const bytes = new Uint8Array(float32.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// Parse one server message → {partial?, final?, setupComplete?, error?}
export function parseServerMessage(msg) {
  const out = {};
  if (msg.setupComplete) out.setupComplete = true;
  const c = msg.serverContent;
  if (c?.interimInputTranscription?.text !== undefined) out.partial = c.interimInputTranscription.text;
  if (c?.inputTranscription?.text !== undefined) out.final = c.inputTranscription.text;
  if (msg.error) out.error = msg.error.message ?? String(msg.error);
  return out;
}

export function createTranscriber({
  mic,
  getToken,
  onPartial,
  onFinal,
  onStatus = () => {},
  isMuted = () => false,
  vocabulary = [],
  WebSocketImpl = globalThis.WebSocket,
}) {
  let ws = null;
  let ready = false;
  let stopped = false;
  let buf = new Float32Array(CHUNK);
  let fill = 0;
  let sessionStart = 0;
  let midUtterance = false;
  let retry = 0;
  let reconnectTimer = null;

  async function connect() {
    if (stopped) return;
    let tok;
    try {
      tok = await getToken();
    } catch (err) {
      onStatus(`speech token failed: ${err.message}`);
      return scheduleReconnect();
    }
    if (stopped) return;
    const sock = new WebSocketImpl(`${tok.url}?access_token=${encodeURIComponent(tok.token)}`);
    let opened = false;
    sock.onopen = () => {
      opened = true;
      sock.send(
        JSON.stringify({
          setup: {
            model: `models/${tok.model}`,
            generationConfig: { responseModalities: ['TEXT'] },
            inputAudioTranscription: { languageCodes: ['en-US'], mode: 'VERBATIM', ...(vocabulary.length ? { customVocabulary: vocabulary } : {}) },
          },
        }),
      );
    };
    sock.onmessage = async (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : await ev.data.text();
      const m = parseServerMessage(JSON.parse(raw));
      if (m.setupComplete) {
        const old = ws;
        ws = sock;
        ready = true;
        retry = 0;
        sessionStart = Date.now();
        onStatus('listening');
        if (old && old !== sock) setTimeout(() => old.close(), 3000); // let it flush its last words
      }
      if (m.partial !== undefined && m.partial.trim()) {
        midUtterance = true;
        onPartial(m.partial.trim());
      }
      if (m.final !== undefined) {
        midUtterance = false;
        if (m.final.trim()) onFinal(m.final.trim());
      }
      if (m.error) onStatus(`transcriber error: ${m.error}`);
    };
    sock.onclose = (e) => {
      if (sock !== ws) return; // an old session after handover
      ready = false;
      ws = null;
      if (!stopped) {
        onStatus(opened ? `transcriber closed (${e.code}); reconnecting` : 'transcriber failed to connect; retrying');
        scheduleReconnect();
      }
    };
    sock.onerror = () => {};
    if (!ws) ws = sock;
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    const delay = Math.min(15000, 500 * 2 ** retry++);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function sendChunk(chunk) {
    if (!ready || ws?.readyState !== 1) return;
    ws.send(JSON.stringify({ realtimeInput: { audio: { data: pcm16Base64(chunk), mimeType: 'audio/pcm;rate=16000' } } }));
    // Rotate before the 10-minute session limit, but not in the middle of a sentence.
    if (Date.now() - sessionStart > SESSION_MS && !midUtterance && !reconnectTimer) {
      sessionStart = Date.now(); // don't re-trigger while the new one connects
      connect();
    }
  }

  const unsubscribe = mic.subscribe((x16) => {
    const muted = isMuted();
    for (let i = 0; i < x16.length; i++) {
      buf[fill++] = muted ? 0 : x16[i];
      if (fill === CHUNK) {
        sendChunk(buf);
        buf = new Float32Array(CHUNK);
        fill = 0;
      }
    }
  });

  connect();

  return {
    get listening() {
      return ready;
    },
    stop() {
      stopped = true;
      unsubscribe();
      clearTimeout(reconnectTimer);
      try {
        ws?.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
      } catch {}
      setTimeout(() => ws?.close(), 300);
    },
  };
}
