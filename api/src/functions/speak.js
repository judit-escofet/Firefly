// POST /api/companion/speak
// Takes {"text": "...", "voice": "firefly"} and returns an mp3 of the firefly speaking it.
// The ElevenLabs key stays here on the server, never in the browser.

const { app } = require('../../lib/router');
const { json, handle, readJson, requireString, HttpError } = require('../../lib/http');

// Voice names the browser may ask for -> the voice ID kept in settings.
// (Add a second voice here later if the team wants one.)
function voiceIdFor(name) {
  const voices = { firefly: process.env.ELEVENLABS_VOICE_ID };
  return voices[name] || voices.firefly;
}

app.http('speak', {
  methods: ['POST'],
  route: 'companion/speak',
  handler: handle(async (request, context) => {
    const body = await readJson(request);
    const text = requireString(body.text, 'text', { max: 400 });

    const apiKey = process.env.ELEVENLABS_API_KEY;
    const voiceId = voiceIdFor(body.voice);
    if (!apiKey || !voiceId) throw new HttpError(500, 'Voice is not configured on the server');

    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_64`,
      {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, model_id: 'eleven_flash_v2_5' }),
      }
    );

    if (!res.ok) {
      // Log the reason for us, but never send details (or keys) back to the browser.
      context.error('ElevenLabs error', res.status, await res.text());
      throw new HttpError(502, 'Voice service failed');
    }

    const audio = Buffer.from(await res.arrayBuffer());
    return { status: 200, body: audio, headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' } };
  }),
});