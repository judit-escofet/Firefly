import { describe, it, expect } from 'vitest';
import { bus, emit, on } from '../src/bus.js';
import { hashPin, verifyPin } from '../src/crypto.js';
import { normalizePhone, normalizeWalk } from '../src/services/api.js';
import { progress, routeLength, pointAlong, straightRoute, haversine, offsetFromRoute } from '../src/services/geo.js';
import { MOCK_ROUTE, MOCK_HOME } from '../src/services/mockData.js';

describe('event bus (A11)', () => {
  it('events are flat with type + ISO ts; unsubscribe works', () => {
    let got = null;
    const off = on('walk.started', (e) => (got = e));
    emit('walk.started', { walk_id: 'w_1', share_url: 'x', route: { points: [], distance_m: 1, eta_s: 1 } });
    expect(got).toMatchObject({ type: 'walk.started', walk_id: 'w_1' });
    expect(got.ts).toMatch(/^\d{4}-\d\d-\d\dT/);
    off();
    got = null;
    emit('walk.started', { walk_id: 'w_2' });
    expect(got).toBe(null);
  });

  it('keeps a history for the event inspector (quiet debug events excluded)', () => {
    bus.clearHistory();
    bus.emit('position.updated', { lat: 1, lng: 2 });
    bus.emit('guardian.score', { score: 0.1 });
    bus.emit('pin.entered', { kind: 'cancel' });
    expect(bus.getHistory().map((e) => e.type)).toEqual(['position.updated', 'pin.entered']);
  });
});

describe('PINs (A1): hashed in the browser with the user id as salt', () => {
  it('hashes; her PIN cancels, ANY other complete code is duress (help is called silently)', async () => {
    const u = 'u_abc123';
    const c = await hashPin('1234', u);
    expect(c).toMatch(/^[0-9a-f]{64}$/);
    expect(c).not.toContain('1234');
    expect(await hashPin('1234', 'u_other')).not.toBe(c); // salted per user
    expect(await verifyPin('1234', u, c)).toBe('cancel');
    for (const wrong of ['9999', '0000', '1235', '4321']) expect(await verifyPin(wrong, u, c)).toBe('duress');
    expect(await verifyPin('12', u, c)).toBe(null); // still typing
  });
});

describe('P3 contract helpers', () => {
  it('normalizes US phone numbers to +1XXXXXXXXXX (P3 rejects anything else)', () => {
    expect(normalizePhone('(555) 123-4567')).toBe('+15551234567');
    expect(normalizePhone('1 555 123 4567')).toBe('+15551234567');
    expect(normalizePhone('+1 (555) 382-9912')).toBe('+15553829912');
    expect(normalizePhone('12345')).toBe(null);
    expect(normalizePhone('+44 20 7946 0958')).toBe(null);
  });

  it("normalizes P3's walk JSON ({lat,lng} points) into the walk.started route", () => {
    const w = normalizeWalk(
      { walk_id: 'w_abc', share_url: 'https://x/track/t', route: { points: [{ lat: 1, lng: 2 }, { lat: 1.001, lng: 2 }], distance_m: 111.2, eta_s: 85.6 } },
      MOCK_HOME,
    );
    expect(w).toMatchObject({ walk_id: 'w_abc', share_url: 'https://x/track/t', route: { points: [[1, 2], [1.001, 2]], distance_m: 111, eta_s: 86 } });
  });
});

describe('route math (mirror of P3 api/lib/geo.js)', () => {
  const dest = [MOCK_HOME.lat, MOCK_HOME.lng];
  it('mock route is a real walk (~0.5–1 km) ending at home', () => {
    const len = routeLength(MOCK_ROUTE);
    expect(len).toBeGreaterThan(500);
    expect(len).toBeLessThan(1200);
    expect(haversine(MOCK_ROUTE.at(-1), dest)).toBeLessThan(1);
  });

  it('progress: on route at the start, remaining ≈ route length', () => {
    const r = progress({ position: MOCK_ROUTE[0], route: MOCK_ROUTE, destination: dest });
    expect(r.on_route).toBe(true);
    expect(r.off_route_m).toBe(0);
    expect(Math.abs(r.remaining_m - routeLength(MOCK_ROUTE))).toBeLessThan(2);
    expect(r.eta_s).toBe(Math.round(r.remaining_m / 1.3));
  });

  it('"wander off" puts the walker > 75 m from the route everywhere along it (Guardian check-in)', () => {
    for (const d of [20, 150, 300, 450, 600]) {
      const r = progress({ position: offsetFromRoute(MOCK_ROUTE, d, 95), route: MOCK_ROUTE, destination: dest });
      expect(r.on_route).toBe(false);
      expect(r.off_route_m).toBeGreaterThan(75);
      expect(r.off_route_m).toBeLessThan(110);
    }
  });

  it('progress: within 30 m of home → near_destination, 0 m left (A8)', () => {
    const r = progress({ position: [dest[0] + 0.0001, dest[1]], route: MOCK_ROUTE, destination: dest });
    expect(r.near_destination).toBe(true);
    expect(r.remaining_m).toBe(0);
  });

  it('straight-line fallback route', () => {
    const r = straightRoute([0, 0], [0.01, 0], 10);
    expect(r).toHaveLength(11);
    expect(r[5]).toEqual([0.005, 0]);
  });
});
