// Browser ⇄ Python parity check, step 2 (JS side, Node + TF.js CPU). Run `python ml/parity.py` first.
// Uses the exact same resampler / framing / model code as the browser.
import { readFile } from 'node:fs/promises';
import { loadYamnetModelFromDisk } from './loadYamnetNode.mjs';
import { loadYamnet } from '../src/guardian/audio/yamnet.js';
import { parseWav, embedClip, compareEmbeddings, maxAbsDiff } from '../src/guardian/audio/parity.js';

const root = new URL('../public/', import.meta.url);
const wav = await readFile(new URL('parity/clip.wav', root));
const py = JSON.parse(await readFile(new URL('parity/python_embeddings.json', root), 'utf8'));
const yamnet = await loadYamnet({ model: await loadYamnetModelFromDisk(new URL('models/yamnet/model.json', root).pathname) });
const { samples, sampleRate } = parseWav(wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength));
const head = JSON.parse(await readFile(new URL('models/scream_head.json', root), 'utf8').catch(() => 'null'));
const js = await embedClip(yamnet.infer, samples, sampleRate, head);
const r = compareEmbeddings(js.embeddings, py.embeddings);
const dHead = maxAbsDiff(js.headScores, py.head_scores);
const dYam = maxAbsDiff(js.yamnetScores, py.yamnet_only_scores);
const pass = r.pass && (dHead === null || dHead < 1e-3);
console.log(`${pass ? 'PASS' : 'FAIL'}  clip ${py.source} @ ${sampleRate} Hz  windows js ${r.windowsJs} / py ${r.windowsPy}`);
console.log(`  embeddings: min cosine ${r.minCosine.toFixed(6)}, max |diff| ${r.maxAbsDiff.toExponential(2)}`);
console.log(`  yamnet-only score max |diff| ${dYam?.toExponential(2)}, head score max |diff| ${dHead === null ? 'n/a (no head)' : dHead.toExponential(2)}`);
process.exit(pass ? 0 : 1);
