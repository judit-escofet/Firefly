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
    <div className="rounded-3xl overflow-hidden shadow-2xl border border-white/15 glass-mythic-card" role="status" aria-live="polite" aria-label="Next direction">
      {showTurn && (
        <div className="flex items-center gap-3 px-4 py-3 bg-emerald-800/95 text-white">
          <div className="w-12 h-12 shrink-0 rounded-2xl bg-emerald-950/40 flex items-center justify-center">
            {nav.rerouting ? <Loader2 className="w-7 h-7 animate-spin" /> : <TurnIcon type={nav.type} modifier={nav.modifier} className="w-8 h-8 stroke-[2.5]" />}
          </div>
          <div className="min-w-0 flex-1">
            {nav.rerouting ? (
              <div className="text-lg font-bold">Rerouting…</div>
            ) : (
              <>
                {dist && (
                  <div className="text-2xl font-extrabold leading-none tracking-tight">
                    {dist.value} <span className="text-base font-semibold">{dist.unit}</span>
                  </div>
                )}
                <div className="text-sm font-semibold leading-snug mt-0.5 truncate">{nav.text}</div>
              </>
            )}
            {nav.then && !nav.rerouting && <div className="text-[11px] text-emerald-100/90 truncate mt-0.5">{nav.then}</div>}
          </div>
        </div>
      )}
      {children && <div className="px-4 py-2.5">{children}</div>}
    </div>
  );
}
