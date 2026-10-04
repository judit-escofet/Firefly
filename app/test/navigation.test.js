import { describe, it, expect } from 'vitest';
import { prepareRoute, nextTurn, promptFor, spokenNavDistance, PREPARE_M, NOW_M } from '../src/services/navigation.js';
import { pointAlong } from '../src/services/geo.js';

// An L-shaped route: ~350 m east, then ~390 m south to the destination.
const A = [40.7425, -74.1781], CORNER = [40.7425, -74.1740], B = [40.7390, -74.1740];
const points = [A, [40.7425, -74.1760], CORNER, [40.7408, -74.1740], B];
const steps = [
  { text: 'Head east on Warren Street', type: 'depart', modifier: null, name: 'Warren Street', location: A },
  { text: 'Turn right onto Summit Street', type: 'turn', modifier: 'right', name: 'Summit Street', location: CORNER },
  { text: 'You have arrived', type: 'arrive', modifier: null, name: '', location: B },
];
const nav = prepareRoute(points, steps);

describe('turn-by-turn navigation', () => {
  it('finds the next turn and how far away it is, along the route', () => {
    const t = nextTurn(A, nav);
    expect(t.step.text).toBe('Turn right onto Summit Street');
    expect(t.distance_m).toBeGreaterThan(330);
    expect(t.distance_m).toBeLessThan(360);
    expect(t.then.type).toBe('arrive');
  });

  it('after the corner, the next step is the arrival', () => {
    const past = pointAlong(points, nav.steps[1].along_m + 20);
    expect(nextTurn(past, nav).step.type).toBe('arrive');
  });

  it('speaks a heads-up ~60 m before the turn, then the turn itself at ~15 m, once each', () => {
    const at = (d) => nextTurn(pointAlong(points, nav.steps[1].along_m - d), nav);
    expect(promptFor(at(100), 0)).toBeNull(); // too early
    expect(promptFor(at(PREPARE_M - 5), 0)).toEqual({ level: 1, text: 'In 200 feet, turn right onto Summit Street.' });
    expect(promptFor(at(PREPARE_M - 20), 1)).toBeNull(); // already said
    expect(promptFor(at(NOW_M - 5), 1)).toEqual({ level: 2, text: 'Turn right onto Summit Street.' });
    expect(promptFor(at(NOW_M - 8), 2)).toBeNull();
  });

  it('announces the destination when it is close', () => {
    const near = nextTurn(pointAlong(points, nav.total - 60), nav);
    expect(promptFor(near, 0).text).toBe('Your destination is 200 feet ahead.');
  });

  it('says distances like a person: rounded feet, then miles', () => {
    expect(spokenNavDistance(55)).toBe('200 feet');
    expect(spokenNavDistance(12)).toBe('50 feet');
    expect(spokenNavDistance(400)).toBe('0.2 miles');
    expect(spokenNavDistance(1609)).toBe('1 mile');
  });
});
