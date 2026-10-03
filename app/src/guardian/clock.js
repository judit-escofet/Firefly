// Injectable clock so timing logic can be tested without waiting in real time.

export const realClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

// Manual clock for tests: advance(ms) fires due timers in order.
export function createFakeClock(start = Date.parse('2026-10-03T23:40:00Z')) {
  let now = start;
  let nextId = 1;
  const timers = new Map();

  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: now + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let due = null;
        for (const [id, t] of timers) {
          if (t.at <= end && (!due || t.at < due[1].at || (t.at === due[1].at && id < due[0]))) due = [id, t];
        }
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
    pending: () => timers.size,
  };
}
