// P3 backend client for the app shell (profile, walks, location, end). Field names follow P3's
// implementation (api/src/functions/*.js). In mock mode, or when a call fails, it falls back to
// local data so the walk keeps going (and the screen never waits on the network).

import { isMockModeEnabled, MOCK_ROUTE, MOCK_HOME } from './mockData.js';
import { progress, routeLength, straightRoute, toPair } from './geo.js';

const BASE = import.meta.env?.VITE_API_URL ?? '';
const PROFILE_KEY = 'firefly_profile';
const WALK_KEY = 'firefly_current_walk';

async function postJson(path, body, { timeoutMs = 8000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/api/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// US numbers only (P3 texts through Twilio with +1 numbers): "(555) 123-4567" → "+15551234567".
export function normalizePhone(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

// The keys the companion (P1) and guardian (P2) read, until they get the profile over the bus.
function mirrorForModules(p) {
  try {
    localStorage.setItem('firefly.user_id', p.user_id);
    localStorage.setItem('firefly.name', p.name);
    localStorage.setItem('firefly.code_phrase', p.code_phrase);
    localStorage.setItem('firefly.interests', (p.news_interests ?? []).join(','));
  } catch {}
}

export function normalizeWalk(w, fallbackDest) {
  const points = (w.route?.points ?? w.route ?? []).map(toPair);
  return {
    walk_id: w.walk_id,
    share_url: w.share_url ?? null,
    route: {
      points,
      distance_m: Math.round(w.route?.distance_m ?? w.distance_m ?? routeLength(points)),
      eta_s: Math.round(w.route?.eta_s ?? w.eta_s ?? routeLength(points) / 1.3),
    },
    destination: w.destination ?? fallbackDest,
    started_at: Date.now(),
    offline: Boolean(w.offline),
  };
}

// A walk that lives only on this phone (demo mode, or the backend unreachable). With mock: the
// demo route near the venue. Otherwise a walking route along the streets from GET /api/route
// (OpenStreetMap), or a straight line if that can't be reached either.
async function localWalk(start, dest, { mock }) {
  let route = { points: MOCK_ROUTE };
  if (!mock) {
    route = { points: straightRoute([start.lat, start.lng], [dest.lat, dest.lng]) };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(`${BASE}/api/route?from=${start.lat},${start.lng}&to=${dest.lat},${dest.lng}`, { signal: ctrl.signal });
      const data = await res.json();
      if (res.ok && Array.isArray(data.points) && data.points.length > 1) route = data;
    } catch {
      // offline: keep the straight line
    } finally {
      clearTimeout(timer);
    }
  }
  return normalizeWalk(
    { walk_id: `w_local_${Math.random().toString(36).slice(2, 10)}`, share_url: null, route, destination: dest, offline: true },
    dest,
  );
}

export const api = {
  getProfile() {
    try {
      return JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null');
    } catch {
      return null;
    }
  },

  // profile: {user_id, name, contacts[{name, phone}], code_phrase, pin_hash, duress_pin_hash,
  //           news_interests[], home{lat, lng, label}} — PINs arrive already hashed.
  async saveProfile(profile) {
    const local = { ...profile, updated_at: Date.now() };
    let synced = false;
    let error = null;
    if (!isMockModeEnabled()) {
      try {
        const r = await postJson('profile', {
          user_id: profile.user_id,
          name: profile.name,
          contacts: profile.contacts.map(({ name, phone }) => ({ name, phone })),
          code_phrase: profile.code_phrase,
          pin_hash: profile.pin_hash,
          duress_pin_hash: profile.duress_pin_hash,
          interests: profile.news_interests ?? [],
          ...(profile.home ? { home: { lat: profile.home.lat, lng: profile.home.lng, label: profile.home.label ?? 'Home' } } : {}),
        });
        if (r.user_id) local.user_id = r.user_id;
        synced = true;
      } catch (err) {
        error = err;
        console.warn(`[app] /api/profile failed (${err.message}); profile kept on this phone`);
      }
    }
    local.synced = synced;
    localStorage.setItem(PROFILE_KEY, JSON.stringify(local));
    mirrorForModules(local);
    return { profile: local, synced, error };
  },

  // Places for "Where are you walking to?" → [{label, detail, lat, lng}] (near her when known).
  async searchPlaces(q, near = null) {
    const params = new URLSearchParams({ q });
    if (near) { params.set('lat', near.lat); params.set('lng', near.lng); }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 7000);
    try {
      const res = await fetch(`${BASE}/api/geocode?${params}`, { signal: ctrl.signal });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data.results ?? [];
    } finally {
      clearTimeout(timer);
    }
  },

  // destination: {lat, lng, label} chosen when the walk starts; defaults to her saved home.
  // → normalized walk {walk_id, share_url, route{points[[lat,lng]], distance_m, eta_s}, destination, started_at}
  async startWalk(profile, start, destination = null) {
    const dest = destination ?? profile.home ?? MOCK_HOME;
    const mock = isMockModeEnabled();
    let walk;
    if (mock) {
      // The demo route near the venue, unless she picked somewhere else.
      walk = await localWalk(start, dest, { mock: !destination });
    } else {
      const body = { user_id: profile.user_id, start, destination: { lat: dest.lat, lng: dest.lng, label: dest.label ?? 'Home' } };
      try {
        walk = normalizeWalk(await postJson('walks', body, { timeoutMs: 10000 }), dest);
      } catch (err) {
        if (err.status === 400 && /Unknown user_id/.test(err.message)) {
          // The profile never reached P3 (e.g. set up offline): sync it, then try once more.
          try {
            await this.saveProfile(profile);
            walk = normalizeWalk(await postJson('walks', body, { timeoutMs: 10000 }), dest);
          } catch {}
        }
        if (!walk) {
          console.warn(`[app] /api/walks failed (${err.message}); walking on a local route`);
          walk = await localWalk(start, dest, { mock: false });
        }
      }
    }
    sessionStorage.setItem(WALK_KEY, JSON.stringify(walk));
    return walk;
  },

  // → {remaining_m, eta_s, on_route, off_route_m, near_destination}
  async postLocation(walk, { lat, lng, accuracy_m = null, ts = new Date().toISOString(), speed }) {
    const local = () =>
      progress({ position: [lat, lng], route: walk.route.points, destination: [walk.destination.lat, walk.destination.lng], speed, accuracyM: accuracy_m ?? 0 });
    if (isMockModeEnabled() || walk.offline) return local();
    try {
      return await postJson(`walks/${encodeURIComponent(walk.walk_id)}/location`, { lat, lng, accuracy_m, ts }, { timeoutMs: 4000 });
    } catch {
      return { ...local(), offline: true };
    }
  },

  async endWalk(walk, reason) {
    sessionStorage.removeItem(WALK_KEY);
    const summary = {
      duration_seconds: Math.max(1, Math.round((Date.now() - walk.started_at) / 1000)),
      distance_meters: walk.route.distance_m,
    };
    if (!isMockModeEnabled() && !walk.offline) {
      try {
        await postJson(`walks/${encodeURIComponent(walk.walk_id)}/end`, { reason });
      } catch (err) {
        console.warn(`[app] /end failed (${err.message})`);
      }
    }
    return summary;
  },
};
