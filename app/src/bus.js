// Firefly event bus. The only channel between the app's parts (P4 app shell, P1 companion,
// P2 guardian). emit(type, payload) builds the event { ...payload, type, ts } (ts = ISO time,
// per the team contract) and calls every listener synchronously with that event.
// on("*", fn) receives every event (debug overlays, the event inspector, logging).
//
//   import { emit, on, off } from './bus.js';     // or: import { bus } from './bus.js'
//   const unsubscribe = on('alert.state', (e) => e.state);

const listeners = new Map();
const history = [];
const HISTORY_MAX = 200;
const QUIET = new Set(['guardian.score']); // high-frequency debug event: kept out of logs/history

const devLog = () => {
  try {
    return globalThis.__FIREFLY_DEBUG__ ?? (import.meta.env?.DEV && import.meta.env?.MODE !== 'test');
  } catch {
    return false;
  }
};

export function emit(type, payload = {}) {
  const event = { ...payload, type, ts: new Date().toISOString() };
  if (!QUIET.has(type)) {
    history.push(event);
    if (history.length > HISTORY_MAX) history.shift();
    if (devLog()) console.log(`%c[bus] ${type}`, 'color:#e0b400;font-weight:bold', event);
  }
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

export const getHistory = () => history.slice();
export const clearHistory = () => {
  history.length = 0;
};

export const bus = { emit, on, off, getHistory, clearHistory };
export default bus;
