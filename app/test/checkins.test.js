import { describe, it, expect } from 'vitest';
import { createCheckinTriggers } from '../src/guardian/checkins.js';
import { createStateMachine } from '../src/guardian/stateMachine.js';
import { createFakeClock } from '../src/guardian/clock.js';

const M_PER_DEG_LAT = 111195;
const START = { lat: 40.7425, lng: -74.1784 }; // NJIT-ish

// Drives a fake walk: `segments` = [{seconds, speed, offRoute?, jitterM?}], one update per second.
// Walk state persists across calls for the same triggers object.
const walks = new WeakMap();
function drive(triggers, clock, segments, { remaining = 800 } = {}) {
  if (!walks.has(triggers)) walks.set(triggers, { northM: 0, rem: remaining, seed: 1 });
  const w = walks.get(triggers);
  let { northM, rem } = w;
  const rand = () => ((w.seed = (w.seed * 16807) % 2147483647) / 2147483647) - 0.5;
  for (const seg of segments) {
    for (let s = 0; s < seg.seconds; s++) {
      northM += seg.speed;
      rem = Math.max(0, rem - seg.speed);
      const jitter = (seg.jitterM ?? 0) * rand();
      triggers.position({
        lat: START.lat + (northM + jitter) / M_PER_DEG_LAT,
        lng: START.lng,
        remaining_m: rem,
        eta_s: rem / 1.4,
        on_route: !(seg.offRoute > 75),
        off_route_m: seg.offRoute ?? 0,
      });
      clock.advance(1000);
    }
  }
  Object.assign(w, { northM, rem });
}

function setup(opts) {
  const clock = createFakeClock();
  const fired = [];
  const triggers = createCheckinTriggers({ clock, onTrigger: (t) => fired.push(t), ...opts });
  return { clock, fired, triggers };
}

describe('check-in triggers', () => {
  it('walking normally triggers nothing', () => {
    const { clock, fired, triggers } = setup();
    drive(triggers, clock, [{ seconds: 300, speed: 1.4, jitterM: 4 }]);
    expect(fired).toEqual([]);
  });

  it('long_stop fires once after ~90 s stopped (despite GPS jitter)', () => {
    const { clock, fired, triggers } = setup();
    drive(triggers, clock, [
      { seconds: 60, speed: 1.4 },
      { seconds: 80, speed: 0, jitterM: 3 },
    ]);
    expect(fired).toEqual([]);
    drive(triggers, clock, [{ seconds: 40, speed: 0, jitterM: 3 }]);
    expect(fired.map((f) => f.source)).toEqual(['long_stop']);
    drive(triggers, clock, [{ seconds: 200, speed: 0, jitterM: 3 }]);
    expect(fired).toHaveLength(1);
  });

  it('long_stop re-arms after walking again', () => {
    const { clock, fired, triggers } = setup();
    drive(triggers, clock, [
      { seconds: 120, speed: 0 },
      { seconds: 60, speed: 1.4 },
      { seconds: 120, speed: 0 },
    ]);
    expect(fired.map((f) => f.source)).toEqual(['long_stop', 'long_stop']);
  });

  it('long_stop does not fire within 50 m of home', () => {
    const { clock, fired, triggers } = setup();
    drive(triggers, clock, [{ seconds: 200, speed: 0 }], { remaining: 30 });
    expect(fired).toEqual([]);
  });

  it('long_stop fires via tick() even when position updates stop', () => {
    const { clock, fired, triggers } = setup();
    drive(triggers, clock, [{ seconds: 30, speed: 0 }]);
    for (let i = 0; i < 90; i++) {
      clock.advance(1000);
      triggers.tick();
    }
    expect(fired.map((f) => f.source)).toEqual(['long_stop']);
  });

  it('off_route fires once after 30 s beyond 75 m', () => {
    const { clock, fired, triggers } = setup();
    drive(triggers, clock, [
      { seconds: 20, speed: 1.4, offRoute: 10 },
      { seconds: 29, speed: 1.4, offRoute: 90 },
    ]);
    expect(fired).toEqual([]);
    drive(triggers, clock, [{ seconds: 60, speed: 1.4, offRoute: 120 }]);
    expect(fired.map((f) => f.source)).toEqual(['off_route']);
  });

  it('off_route resets when back on route before 30 s', () => {
    const { clock, fired, triggers } = setup();
    drive(triggers, clock, [
      { seconds: 25, speed: 1.4, offRoute: 90 },
      { seconds: 5, speed: 1.4, offRoute: 20 },
      { seconds: 25, speed: 1.4, offRoute: 90 },
    ]);
    expect(fired).toEqual([]);
  });

  it('G8: long stop → one checkin.request; two unanswered → countdown', () => {
    const clock = createFakeClock();
    const emitted = [];
    const sm = createStateMachine({ clock, emit: (type, p) => emitted.push({ type, ...p }) });
    const triggers = createCheckinTriggers({ clock, onTrigger: (sig) => sm.danger(sig) });
    drive(triggers, clock, [{ seconds: 100, speed: 0 }]);
    expect(emitted.filter((e) => e.type === 'checkin.request')).toHaveLength(1);
    sm.answer(null);
    sm.answer(null);
    expect(sm.state).toBe('countdown');
  });
});
