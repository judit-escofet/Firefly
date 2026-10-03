// Firefly event bus. The only channel between the app's parts (shell, companion, guardian, map).
// emit(type, payload) adds `type` and `ts` (ISO time) and calls every listener synchronously.
// on("*", fn) receives every event (handy for debug overlays and logging).

const listeners = new Map();

export function emit(type, payload = {}) {
  const event = { ...payload, type, ts: new Date().toISOString() };
  // "*" first, so a log of every event reads in causal order (cause before its effects).
  for (const key of ['*', type]) {
    const fns = listeners.get(key);
    if (!fns) continue;
    for (const fn of [...fns]) {
      try {
        fn(event);
      } catch (err) {
        console.error(`[bus] listener for "${type}" threw`, err);
      }
    }
  }
  return event;
}

export function on(type, fn) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(fn);
  return () => off(type, fn);
}

export function off(type, fn) {
  listeners.get(type)?.delete(fn);
}
