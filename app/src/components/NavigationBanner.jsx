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

export default function NavigationBanner() {
  const [nav, setNav] = useState(null);
  useEffect(() => bus.on('nav.update', (e) => setNav((prev) => (e.rerouting && !e.distance_m && prev ? { ...prev, rerouting: true } : e))), []);

  if (!nav || nav.done) return null;
  const dist = Number.isFinite(nav.distance_m) ? formatDistance(nav.distance_m) : null;

  return (
    <div className="rounded-3xl overflow-hidden shadow-2xl border border-emerald-300/30" role="status" aria-live="polite" aria-label="Next direction">
      <div className="flex items-center gap-3 px-4 py-3 bg-emerald-800/95 text-white">
        <div className="w-12 h-12 shrink-0 rounded-2xl bg-emerald-950/40 flex items-center justify-center">
          {nav.rerouting ? <Loader2 className="w-7 h-7 animate-spin" /> : <TurnIcon type={nav.type} modifier={nav.modifier} className="w-8 h-8 stroke-[2.5]" />}
        </div>
        <div className="min-w-0">
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
        </div>
      </div>
      {nav.then && !nav.rerouting && (
        <div className="px-4 py-1.5 bg-emerald-950/90 text-emerald-100 text-xs font-medium truncate">{nav.then}</div>
      )}
    </div>
  );
}
