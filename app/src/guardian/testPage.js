// guardian-test.html: live mic → YAMNet scores, trigger rule, timing (G1), parity check.

import { startScreamDetector } from './audio/detector.js';
import { loadYamnetFastest } from './audio/backend.js';
import { acquireMic } from '../audio/micHub.js';
import { parseWav, embedClip, compareEmbeddings, maxAbsDiff } from './audio/parity.js';
import { loadHead } from './audio/detector.js';

const $ = (id) => document.getElementById(id);
let det = null;
let labels = [];
let startedAt = 0;
let firstMinute = [];
let lastMinute = [];
const history = [];

fetch('/models/yamnet/yamnet_class_map.csv')
  .then((r) => r.text())
  .then((t) => {
    labels = t.trim().split(/\r?\n/).slice(1).map((l) => l.split(',').slice(2).join(',').replace(/"/g, ''));
  });

let fileRun = null; // {startedAt, onset} while the test scream plays

let pageMic = null; // this page's reference to the shared mic hub

// acquireMic() runs synchronously inside the tap, before any await (iOS requirement).
$('start').onclick = () => start(acquireMic());

$('playScream').onclick = async () => {
  const mic = acquireMic({ file: '/parity/scream_test.wav' }); // same path as the mic, file as input
  const meta = await fetch('/parity/scream_test.json').then((r) => r.json());
  await start(mic);
  if (!det) return;
  const { startedAt, duration } = await mic.startFile();
  fileRun = { startedAt, onset: meta.onset_s, triggeredAt: null };
  $('log').textContent = `${new Date().toLocaleTimeString()}  playing test scream (onset at ${meta.onset_s} s): ${meta.scream}\n` + $('log').textContent;
  setTimeout(() => {
    if (fileRun && fileRun.triggeredAt === null) {
      $('log').textContent = `${new Date().toLocaleTimeString()}  ✗ test scream NOT detected\n` + $('log').textContent;
    }
    fileRun = null;
  }, (duration + 1) * 1000);
};

async function start(mic) {
  if (det) await det.stop();
  det = null;
  if (pageMic && pageMic !== mic) pageMic.release();
  pageMic = mic;
  $('start').disabled = true;
  $('status').textContent = 'loading YAMNet + mic…';
  try {
    det = await startScreamDetector({
      useHead: $('useHead').checked,
      onScore,
      onTrigger,
      onStatus: (t) => ($('status').textContent = t),
    });
    startedAt = performance.now();
    firstMinute = [];
    lastMinute = [];
    $('thr').value = det.rule.threshold;
    $('thrVal').textContent = det.rule.threshold.toFixed(2);
    $('status').textContent = `listening · ${det.mode} · threshold ${det.rule.threshold.toFixed(2)} · audio ${det.contextState}\nbackends: ${det.backendNote}`;
    $('stop').disabled = false;
  } catch (err) {
    $('status').textContent = `error: ${err.message}`;
    $('start').disabled = false;
  }
}

$('stop').onclick = async () => {
  await det?.stop();
  det = null;
  pageMic?.release();
  pageMic = null;
  $('start').disabled = false;
  $('stop').disabled = true;
  $('status').textContent = 'stopped';
};

$('thr').oninput = (e) => {
  const t = parseFloat(e.target.value);
  $('thrVal').textContent = t.toFixed(2);
  if (det) det.rule.threshold = t;
  try { localStorage.setItem('firefly.scream_threshold', String(t)); } catch {}
};

function onScore(s) {
  const t = (performance.now() - startedAt) / 1000;
  if (t < 60) firstMinute.push(s.ms);
  lastMinute.push({ t, ms: s.ms });
  while (lastMinute.length && lastMinute[0].t < t - 60) lastMinute.shift();
  history.push(s);
  if (history.length > 120) history.shift();

  const thr = det.rule.threshold;
  $('fill').style.width = `${s.score * 100}%`;
  $('fill').style.background = s.score >= thr ? '#ff9f1a' : '#5cc8ff';
  $('th').style.left = `${thr * 100}%`;
  $('scoreLabel').textContent = s.score.toFixed(2);
  $('yfill').style.width = `${s.yamnetScore * 100}%`;
  $('yLabel').textContent = s.yamnetScore.toFixed(2);

  const st = det.stats;
  $('ms').textContent = `${s.ms.toFixed(0)} / ${st.msAvg.toFixed(0)} / ${st.msMax.toFixed(0)} ms ${st.msAvg < 100 ? '✅' : '⚠️ over 100'}`;
  const avg = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  $('drift').textContent = `${avg(firstMinute).toFixed(0)} → ${avg(lastMinute.map((x) => x.ms)).toFixed(0)} ms`;
  $('win').textContent = `${st.windows} / ${st.dropped}`;
  $('be').textContent = `${det.backend} · ${det.nativeRate} Hz · ${det.numTensors()} · audio ${det.contextState}`;
  $('uptime').textContent = `${Math.floor(t / 60)}m ${Math.floor(t % 60)}s`;
  if (labels.length) {
    const top = Array.from(s.classScores, (v, i) => [v, i]).sort((a, b) => b[0] - a[0]).slice(0, 3);
    $('top').textContent = top.map(([v, i]) => `${labels[i]} ${v.toFixed(2)}`).join(' · ');
  }
  drawSpark(thr);
}

function onTrigger({ confidence, detail }) {
  let latency = '';
  if (fileRun && fileRun.triggeredAt === null) {
    fileRun.triggeredAt = det.audioTime() - fileRun.startedAt;
    latency = `  ✓ ${(fileRun.triggeredAt - fileRun.onset).toFixed(2)} s after scream onset (G6 target < 2 s)`;
  }
  const line = `${new Date().toLocaleTimeString()}  TRIGGER  conf ${confidence}  ${detail}${latency}`;
  $('log').textContent = line + '\n' + $('log').textContent;
  $('trigger').textContent = '🚨 would start countdown';
  navigator.vibrate?.(200);
  setTimeout(() => ($('trigger').textContent = ''), 2500);
}

function drawSpark(thr) {
  const c = $('spark');
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  g.strokeStyle = '#ff4d4d';
  g.beginPath();
  g.moveTo(0, c.height * (1 - thr));
  g.lineTo(c.width, c.height * (1 - thr));
  g.stroke();
  const step = c.width / 120;
  for (const [key, color] of [['yamnetScore', '#9b8cff'], ['score', '#5cc8ff']]) {
    g.strokeStyle = color;
    g.lineWidth = 2;
    g.beginPath();
    history.forEach((h, i) => g[i ? 'lineTo' : 'moveTo'](i * step, c.height * (1 - h[key])));
    g.stroke();
  }
}

$('parity').onclick = async () => {
  const out = $('parityOut');
  out.textContent = 'running…';
  try {
    const [wavRes, pyRes] = await Promise.all([fetch('/parity/clip.wav'), fetch('/parity/python_embeddings.json')]);
    if (!wavRes.ok || !pyRes.ok) throw new Error('missing public/parity files: run `python ml/parity.py` first');
    const { samples, sampleRate } = parseWav(await wavRes.arrayBuffer());
    const py = await pyRes.json();
    const [yamnet, head] = await Promise.all([loadYamnetFastest(), loadHead()]);
    const js = await embedClip(yamnet.infer, samples, sampleRate, head);
    const r = compareEmbeddings(js.embeddings, py.embeddings);
    const dHead = maxAbsDiff(js.headScores, py.head_scores);
    const pass = r.pass && (dHead === null || dHead < 1e-3);
    out.textContent = `${pass ? '✅ PASS' : '❌ FAIL'}  backend ${yamnet.backend}\nwindows js ${r.windowsJs} / py ${r.windowsPy}\nembeddings: min cosine ${r.minCosine.toFixed(6)}, max |diff| ${r.maxAbsDiff.toExponential(2)}\nhead score max |diff| ${dHead === null ? 'n/a' : dHead.toExponential(2)}`;
  } catch (err) {
    out.textContent = `error: ${err.message}`;
  }
};
