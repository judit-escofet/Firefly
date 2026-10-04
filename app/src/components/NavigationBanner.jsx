import React, { useEffect, useState } from 'react';
import { ArrowUp, CornerUpLeft, CornerUpRight, ArrowUpLeft, ArrowUpRight, RotateCcw, MapPin, Navigation, Loader2, RefreshCw } from 'lucide-react';
import { bus } from '../bus';
import { formatDistance } from '../services/units';

// Google Maps-style next-turn banner: arrow, distance to the turn, instruction, and the step after.
// Driven by nav.update events from services/navigation.js.
function TurnIcon({ type, modifier, className }) {
  if (type === 'arrive') return <MapPin className={className} />;
  if (type === 'depart') return <Navigation className={className} />;
  if (type === 'roundabout' || type === 'rotary') return <RefreshCw className={className} />;
  switch (modifier) {
    case 'left':
    case 'sharp left':
      return <CornerUpLeft className={className} />;
    case 'right':
    case 'sharp right':
      return <CornerUpRight className={className} />;
    case 'slight left':
      return <ArrowUpLeft className={className} />;
    case 'slight right':
      return <ArrowUpRight className={className} />;
    case 'uturn':
      return <RotateCcw className={className} />;
    default:
      return <ArrowUp className={className} />;
  }
}

// One floating box: the next turn (when there are directions) on top, and `children` (ETA, distance
// left, listening) as the strip underneath.
export default function NavigationBanner({ children }) {
  const [nav, setNav] = useState(null);
  useEffect(() => bus.on('nav.update', (e) => setNav((prev) => (e.rerouting && !e.distance_m && prev ? { ...prev, rerouting: true } : e))), []);

  const showTurn = nav && !nav.done;
  const dist = showTurn && Number.isFinite(nav.distance_m) ? formatDistance(nav.distance_m) : null;

  return (
    <div className="rounded-2xl overflow-hidden surface" role="status" aria-live="polite" aria-label="Next direction">
      {showTurn && (
        <div className="flex items-center gap-3 px-4 py-3 bg-night-700 text-parchment-50 border-b border-parchment-100/10">
          <div className="w-11 h-11 shrink-0 rounded-xl bg-lantern-400 text-night-950 flex items-center justify-center">
            {nav.rerouting ? <Loader2 className="w-6 h-6 animate-spin" /> : <TurnIcon type={nav.type} modifier={nav.modifier} className="w-7 h-7 stroke-[2.5]" />}
          </div>
          <div className="min-w-0 flex-1">
            {nav.rerouting ? (
              <div className="text-lg font-bold">Finding a new way…</div>
            ) : (
              <>
                <div className="text-[1.0625rem] font-bold leading-snug truncate">{nav.text}</div>
                {dist && <div className="text-[0.875rem] text-lichen-200">in {dist.value} {dist.unit}{nav.then ? <span className="text-lichen-400"> · then {nav.then.replace(/^then\s+/i, '')}</span> : null}</div>}
              </>
            )}
          </div>
        </div>
      )}
      {children && <div className="px-4 py-3">{children}</div>}
    </div>
  );
}
