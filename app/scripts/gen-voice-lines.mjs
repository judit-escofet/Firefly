// Pre-generates the firefly's fixed lines as mp3s (P1 spec: speed + mock mode) into
// public/voice/, with manifest.json mapping id → {text, file}. Uses ELEVENLABS_API_KEY from
// the environment or api/local.settings.json (never committed). Re-run after changing lines.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const settings = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../../api/local.settings.json', import.meta.url), 'utf8')).Values;
  } catch {
    return {};
  }
})();
const KEY = process.env.ELEVENLABS_API_KEY || settings.ELEVENLABS_API_KEY;
const VOICE = process.env.ELEVENLABS_VOICE_ID || settings.ELEVENLABS_VOICE_ID || 'icKXBYNmxkj1YTU4bl0F';
if (!KEY) throw new Error('ELEVENLABS_API_KEY missing');

const LINES = {
  greeting: "Hey, I'm right here with you. How was your day?",
  // Must match the Guardian's check-in prompts (src/guardian/stateMachine.js) word for word.
  checkin_long_stop: "Looks like you've stopped for a bit. Everything okay?",
  checkin_off_route: "You've wandered off the route. Are you okay?",
  checkin_manual: 'Just checking in. Are you okay?',
  checkin_retry: "I didn't catch that. Are you okay?",
  ack_ok: "Glad to hear it. I'm right here with you.",
  ack_not_ok: "Okay. I'm right here, keep talking to me.",
  home: "You made it home! Your people know you're in. Sleep well.",
  // Canned replies used in mock mode (src/companion/api.js) — so the demo has a voice offline.
  mock_chat_1: "That sounds like a lot. What's one good thing that happened today?",
  mock_chat_2: 'I hear you. What are you having for dinner tonight?',
  mock_chat_3: "Nice! Tell me more, I'm listening.",
  mock_chat_4: "We're getting closer. What's the plan when you get home?",
  mock_idle_1: 'How is the walk going so far?',
  mock_idle_2: "What's been on your mind today?",
  mock_idle_3: 'Listened to any good music lately?',
  mock_checkin_1: 'Hey, just checking in. Everything alright?',
  mock_calm_1: 'Tell me about the best part of your day.',
  mock_calm_2: 'What are you going to cook tonight?',
  mock_calm_3: "What's the next show you want to watch?",
};

const out = new URL('../public/voice/', import.meta.url);
mkdirSync(out, { recursive: true });
const manifest = { voice_id: VOICE, model: 'eleven_flash_v2_5', lines: {} };
for (const [id, text] of Object.entries(LINES)) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}?output_format=mp3_44100_64`, {
    method: 'POST',
    headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: 'eleven_flash_v2_5', voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.2 } }),
  });
  if (!res.ok) throw new Error(`${id}: ${res.status} ${await res.text()}`);
  writeFileSync(new URL(`${id}.mp3`, out), Buffer.from(await res.arrayBuffer()));
  manifest.lines[id] = { text, file: `/voice/${id}.mp3` };
  console.log(`  ${id}.mp3  "${text}"`);
}
writeFileSync(new URL('manifest.json', out), JSON.stringify(manifest, null, 2));
console.log(`wrote ${Object.keys(LINES).length} lines + manifest.json`);
