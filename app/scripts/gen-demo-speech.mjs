// Builds public/demo/test_walk.wav: "her" side of a short walk (a different ElevenLabs voice),
// with pauses for the firefly to answer. Played into the shared mic hub by the demo shell's
// "Walk with test audio" button, it exercises transcription → reply → code phrase → countdown
// without a microphone.
import { readFileSync, writeFileSync } from 'node:fs';

const KEY = process.env.ELEVENLABS_API_KEY || JSON.parse(readFileSync(new URL('../../api/local.settings.json', import.meta.url), 'utf8')).Values.ELEVENLABS_API_KEY;
const HER_VOICE = 'cgSgspJ2msm6clMCkdW9'; // "Jessica" from the ElevenLabs library
const SCRIPT = [
  { text: 'Hey! Long day today. My exam was kind of rough.', pauseAfter: 9 },
  { text: 'Oh no, I think I left the oven on.', pauseAfter: 4 },
];

async function pcm(text) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${HER_VOICE}?output_format=pcm_16000`, {
    method: 'POST',
    headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: 'eleven_flash_v2_5' }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

const parts = [Buffer.alloc(16000 * 2 * 1.5)]; // 1.5 s lead-in
const cues = [];
let t = 1.5;
for (const s of SCRIPT) {
  const p = await pcm(s.text);
  cues.push({ at_s: Number(t.toFixed(2)), text: s.text });
  parts.push(p, Buffer.alloc(16000 * 2 * s.pauseAfter));
  t += p.length / 32000 + s.pauseAfter;
}
const data = Buffer.concat(parts);
const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + data.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(16000, 24);
header.writeUInt32LE(32000, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(data.length, 40);
writeFileSync(new URL('../public/demo/test_walk.wav', import.meta.url), Buffer.concat([header, data]));
writeFileSync(new URL('../public/demo/test_walk.json', import.meta.url), JSON.stringify({ duration_s: Number(t.toFixed(2)), cues, voice: 'ElevenLabs "Jessica" (library voice)' }, null, 2));
console.log(`test_walk.wav: ${t.toFixed(1)} s`, cues);
