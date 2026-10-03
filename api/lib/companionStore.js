// Memories and the "call record" (conversation_turns) for the companion.
// Uses Tiger Data (tables from P3's api/db/schema.sql) when TIGER_DATABASE_URL is set;
// otherwise a local JSON file (api/.data/companion.json, git-ignored) so the demo works offline.

const fs = require('fs');
const path = require('path');

const MAX_FACTS = 15;
// COMPANION_DATA_DIR: where the local fallback lives (Lambda: /tmp, the package is read-only).
const FILE = path.join(process.env.COMPANION_DATA_DIR || path.join(__dirname, '..', '.data'), 'companion.json');

const useDb = () => Boolean(process.env.TIGER_DATABASE_URL);
const db = () => require('../db');

function readFile() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return { memories: {}, turns: [] };
  }
}

function writeFile(data) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 1));
}

async function loadMemories(userId) {
  if (useDb()) {
    const { rows } = await db().query(
      'SELECT fact FROM memories WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
      [userId, MAX_FACTS],
    );
    return rows.map((r) => r.fact);
  }
  return (readFile().memories[userId] ?? []).slice(0, MAX_FACTS);
}

// Newest first; keeps the latest 15.
async function saveMemories(userId, facts, walkId = null) {
  if (!facts.length) return 0;
  if (useDb()) {
    await db().withTransaction(async (c) => {
      for (const f of facts) await c.query('INSERT INTO memories (user_id, walk_id, fact) VALUES ($1, $2, $3)', [userId, walkId, f]);
      await c.query(
        `DELETE FROM memories WHERE user_id = $1 AND created_at < (
           SELECT created_at FROM memories WHERE user_id = $1 ORDER BY created_at DESC OFFSET $2 LIMIT 1)`,
        [userId, MAX_FACTS - 1],
      );
    });
    return facts.length;
  }
  const data = readFile();
  data.memories[userId] = [...facts, ...(data.memories[userId] ?? []).filter((f) => !facts.includes(f))].slice(0, MAX_FACTS);
  writeFile(data);
  return facts.length;
}

// One row per turn: {ts, walk_id, speaker: 'user'|'firefly', text, mode, latency_ms}.
// P3's table: conversation_turns(ts, walk_id, role 'user'|'assistant', text, data jsonb).
async function logTurns(rows) {
  if (!rows.length) return;
  if (useDb()) {
    for (const r of rows) {
      await db().query(
        'INSERT INTO conversation_turns (ts, walk_id, role, text, data) VALUES ($1, $2, $3, $4, $5)',
        [r.ts ?? new Date(), r.walk_id, r.speaker === 'firefly' ? 'assistant' : 'user', r.text,
          JSON.stringify({ mode: r.mode, latency_ms: r.latency_ms ?? null, model: r.model ?? null })],
      );
    }
    return;
  }
  const data = readFile();
  data.turns.push(...rows.map((r) => ({ ...r, ts: (r.ts ?? new Date()).toISOString?.() ?? r.ts })));
  data.turns = data.turns.slice(-2000);
  writeFile(data);
}

module.exports = { loadMemories, saveMemories, logTurns, MAX_FACTS };
