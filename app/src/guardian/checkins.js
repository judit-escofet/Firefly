// Check-in triggers from position.updated. Pure: positions + injected clock in, onTrigger out.
//
//   long_stop: speed < 0.3 m/s for 90 s while remaining_m > 50
//   off_route: off_route_m > 75 for 30 s
//
// Speed is measured over a ~20 s span (not point to point) so GPS jitter while standing still
// does not look like walking. Each trigger fires once, then re-arms when the condition clears.
// Call tick() periodically too: a phone standing still may stop sending position updates.

const EARTH_R = 6371000;

export function haversineM(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(h));
}

export function createCheckinTriggers({
  onTrigger,
  clock,
  stopSpeedMps = 0.3,
  stopS = 90,
  minRemainingM = 50,
  offRouteM = 75,
  offRouteS = 30,
  speedSpanS = 20,
}) {
  let track = []; // {t, lat, lng}
  let last = null; // last position.updated payload
  let stoppedSince = null;
  let offSince = null;
  let stopFired = false;
  let offFired = false;

  function speedNow(now) {
    if (!track.length) return null;
    // Oldest sample inside the span (or the oldest we have).
    const cutoff = now - speedSpanS * 1000;
    const ref = track.find((p) => p.t >= cutoff) ?? track[0];
    const newest = track[track.length - 1];
    const dt = (now - ref.t) / 1000;
    if (dt < 5) return null; // not enough history yet
    return haversineM(ref, newest) / dt;
  }

  function evaluate(now) {
    if (!last) return;

    // long_stop
    const speed = speedNow(now);
    const stopped = speed !== null && speed < stopSpeedMps && (last.remaining_m ?? Infinity) > minRemainingM;
    if (stopped) {
      stoppedSince ??= now - Math.min(speedSpanS * 1000, now - track[0].t);
      if (!stopFired && now - stoppedSince >= stopS * 1000) {
        stopFired = true;
        onTrigger({
          source: 'long_stop',
          confidence: 0.6,
          detail: `stopped ${Math.round((now - stoppedSince) / 1000)} s, ${Math.round(last.remaining_m)} m from home`,
        });
      }
    } else if (speed !== null) {
      stoppedSince = null;
      stopFired = false;
    }

    // off_route
    const off = (last.off_route_m ?? 0) > offRouteM;
    if (off) {
      offSince ??= now;
      if (!offFired && now - offSince >= offRouteS * 1000) {
        offFired = true;
        onTrigger({
          source: 'off_route',
          confidence: 0.6,
          detail: `${Math.round(last.off_route_m)} m off route for ${Math.round((now - offSince) / 1000)} s`,
        });
      }
    } else {
      offSince = null;
      offFired = false;
    }
  }

  return {
    position(p) {
      const now = clock.now();
      last = p;
      if (Number.isFinite(p.lat) && Number.isFinite(p.lng)) {
        track.push({ t: now, lat: p.lat, lng: p.lng });
        const keep = now - (speedSpanS + 5) * 1000;
        while (track.length > 2 && track[1].t < keep) track.shift();
      }
      evaluate(now);
    },
    tick() {
      evaluate(clock.now());
    },
    reset() {
      track = [];
      last = null;
      stoppedSince = offSince = null;
      stopFired = offFired = false;
    },
  };
}
