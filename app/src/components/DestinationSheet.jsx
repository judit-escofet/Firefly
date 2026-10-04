import React, { useEffect, useRef, useState } from 'react';
import { Home, MapPin, Search, X, Loader2, Footprints } from 'lucide-react';
import { api } from '../services/api';

// "Where are you walking to?" — shown when she taps "Walk with me". One tap for her saved home,
// or search any place or address (OpenStreetMap, biased to where she is). The walk starts from
// this sheet's "Start walk" button, a fresh tap, so the mic can open on iOS.
export default function DestinationSheet({ isOpen, home, onClose, onStart }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [picked, setPicked] = useState(null);
  const near = useRef(null);
  const input = useRef(null);

  // Reset each time it opens, preselect home, and get a rough position to bias the search.
  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    setResults([]);
    setError(null);
    setPicked(home ?? null);
    navigator.geolocation?.getCurrentPosition(
      (p) => (near.current = { lat: p.coords.latitude, lng: p.coords.longitude }),
      () => {},
      { maximumAge: 60000, timeout: 5000 },
    );
  }, [isOpen, home]);

  // Search as she types (debounced: the place search allows about one request a second).
  useEffect(() => {
    const q = query.trim();
    if (q.length < 3) {
      setResults([]);
      setBusy(false);
      return undefined;
    }
    setBusy(true);
    const t = setTimeout(async () => {
      try {
        setResults(await api.searchPlaces(q, near.current));
        setError(null);
      } catch (err) {
        setResults([]);
        setError(err.message);
      } finally {
        setBusy(false);
      }
    }, 700);
    return () => clearTimeout(t);
  }, [query]);

  if (!isOpen) return null;

  const option = (place, icon, key) => {
    const selected = picked && picked.lat === place.lat && picked.lng === place.lng;
    return (
      <button key={key} type="button" onClick={() => setPicked(place)}
        className={`w-full text-left p-3 rounded-2xl flex items-start gap-3 border transition-colors ${selected ? 'border-gold-400 bg-gold-400/10' : 'border-white/10 bg-twilight-900/60 hover:border-white/25'}`}>
        <span className="mt-0.5 shrink-0">{icon}</span>
        <span className="min-w-0">
          <span className="block font-semibold text-sm text-white truncate">{place.label}</span>
          {place.detail && <span className="block text-[11px] text-pastel-lavender truncate">{place.detail}</span>}
        </span>
      </button>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-twilight-950/80 backdrop-blur-md animate-fade-in"
      role="dialog" aria-label="Where are you walking to?">
      <div className="w-full max-w-md max-h-[90dvh] flex flex-col rounded-3xl glass-mythic-card p-5 shadow-2xl text-white">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-cinzel font-bold">Where are you walking to?</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1.5 rounded-full text-pastel-lavender hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        <label className="relative block mb-3">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-pastel-lavender" />
          <input ref={input} value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" enterKeyHint="search"
            placeholder="Search a place or address"
            className="w-full pl-9 pr-9 py-3 rounded-2xl bg-twilight-900/80 border border-white/15 text-sm text-white placeholder:text-pastel-lavender/70 focus:outline-none focus:border-gold-400" />
          {busy && <Loader2 className="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-gold-400" />}
        </label>

        <div className="flex-1 overflow-y-auto flex flex-col gap-2 min-h-0">
          {home && option({ ...home, label: home.label || 'Home', detail: 'Saved home' }, <Home className="w-4 h-4 text-gold-400" />, 'home')}
          {results.map((r, i) => option(r, <MapPin className="w-4 h-4 text-pastel-mint" />, `${r.lat},${r.lng},${i}`))}
          {!busy && query.trim().length >= 3 && !results.length && !error && (
            <p className="text-xs text-pastel-lavender px-1">No places found. Try a street address.</p>
          )}
          {error && <p className="text-xs text-pastel-rose px-1">Search isn't available right now ({error}).</p>}
        </div>

        <button type="button" disabled={!picked} onClick={() => picked && onStart({ lat: picked.lat, lng: picked.lng, label: picked.label || 'Home' })}
          className="mt-4 w-full py-4 rounded-2xl bg-gradient-to-r from-gold-400 to-amber-500 text-twilight-950 font-extrabold text-sm uppercase tracking-wide flex items-center justify-center gap-2 disabled:opacity-40 active:scale-[0.98]">
          <Footprints className="w-4 h-4" />
          {picked ? `Start walk to ${picked.label || 'Home'}` : 'Pick where you are going'}
        </button>
      </div>
    </div>
  );
}
