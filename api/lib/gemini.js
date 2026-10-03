// Gemini (Google AI) helpers for the companion: JSON chat replies and live-transcription tokens.
// The API key stays on the server (GEMINI_API_KEY); browsers only ever get short-lived tokens.

const BASE = 'https://generativelanguage.googleapis.com';
// Fast models first; on overload (429/503) or timeout the next one is tried.
const DEFAULT_MODELS = ['gemini-3.5-flash', 'gemini-3.5-flash-lite'];
const TRANSCRIBE_MODEL = 'gemini-3.5-transcribe-live';

function key() {
  const k = process.env.GEMINI_API_KEY;
  if (!k) throw new Error('GEMINI_API_KEY is not set');
  return k;
}

function models() {
  return process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL, ...DEFAULT_MODELS] : DEFAULT_MODELS;
}

// → parsed JSON object from the model. `schema` is an OpenAPI-style responseSchema.
async function generateJson({ system, contents, schema, temperature = 0.7, maxOutputTokens = 160, timeoutMs = 6000 }) {
  let lastErr;
  for (const model of models()) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${BASE}/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'x-goog-api-key': key(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents,
          generationConfig: {
            temperature,
            maxOutputTokens,
            responseMimeType: 'application/json',
            ...(schema ? { responseSchema: schema } : {}),
            thinkingConfig: { thinkingLevel: 'minimal' },
          },
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        lastErr = new Error(`${model}: ${res.status} ${body.error?.message ?? ''}`.trim());
        if (res.status === 429 || res.status >= 500) continue; // try the next model
        throw lastErr;
      }
      const text = (body.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
      return { model, data: JSON.parse(text) };
    } catch (err) {
      lastErr = err.name === 'AbortError' ? new Error(`${model}: timed out after ${timeoutMs} ms`) : err;
      if (err instanceof SyntaxError) continue; // malformed JSON: try the next model
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

// Single-use token for the browser's live-transcription WebSocket (expires in 30 min; the
// session must start within 2 min). The real key never reaches the browser.
async function transcriptionToken() {
  const now = Date.now();
  const expireTime = new Date(now + 30 * 60e3).toISOString();
  const res = await fetch(`${BASE}/v1alpha/auth_tokens`, {
    method: 'POST',
    headers: { 'x-goog-api-key': key(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ uses: 1, expireTime, newSessionExpireTime: new Date(now + 2 * 60e3).toISOString() }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.name) throw new Error(`token request failed: ${res.status} ${body.error?.message ?? ''}`);
  return {
    token: body.name,
    expires_at: expireTime,
    model: TRANSCRIBE_MODEL,
    url: 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained',
  };
}

module.exports = { generateJson, transcriptionToken, TRANSCRIBE_MODEL };
