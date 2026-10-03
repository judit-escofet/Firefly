// Collects per-window scores (numbers only, never audio) and POSTs them every 30 s during a walk.

export function createScoreLog({ post, clock, everyS = 30, max = 2000 }) {
  let pending = [];
  let timer = null;

  async function flush() {
    if (!pending.length) return { saved: 0 };
    const batch = pending;
    pending = [];
    return post(batch);
  }

  function schedule() {
    timer = clock.setTimeout(() => {
      flush();
      schedule();
    }, everyS * 1000);
  }

  return {
    add({ ts, scream_score, triggered }) {
      const v = Number(scream_score.toFixed(4));
      // Both shapes: the team contract's {scream_score, triggered} and P3's implemented
      // {score, label} (api/src/functions/scores.js). The backend ignores fields it doesn't know.
      pending.push({ ts, scream_score: v, triggered: Boolean(triggered), score: v, label: triggered ? 'triggered' : null });
      if (pending.length > max) pending.splice(0, pending.length - max);
    },
    start() {
      if (timer === null) schedule();
    },
    async stop() {
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
      return flush();
    },
    get pendingCount() {
      return pending.length;
    },
  };
}
