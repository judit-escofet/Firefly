// ElevenLabs text-to-speech for the firefly's voice. Key stays on the server.

// "Voice 1 - firefly" in the team's ElevenLabs library; override with ELEVENLABS_VOICE_ID.
const DEFAULT_VOICE_ID = 'icKXBYNmxkj1YTU4bl0F';
const MODEL = 'eleven_flash_v2_5'; // lowest latency (~0.3 s per sentence)

async function speak(text, { timeoutMs = 8000 } = {}) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY is not set');
  const voice = process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_64`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({
        text,
        model_id: MODEL,
        // Lower stability = more natural emotional range (ElevenLabs suggests ~0.45 for conversational
        // agents); a touch more style so it sounds like a friend, not a narrator.
        voice_settings: { stability: 0.42, similarity_boost: 0.75, style: 0.3, use_speaker_boost: true, speed: 1.0 },
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`ElevenLabs ${res.status}: ${detail.slice(0, 200)}`);
    }
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { speak, DEFAULT_VOICE_ID };
