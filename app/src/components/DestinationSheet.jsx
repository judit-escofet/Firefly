import React, { useEffect, useRef, useState } from 'react';
import { Home, MapPin, Search, X, Loader2 } from 'lucide-react';
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
        className={`w-full text-left px-4 py-3 rounded-xl flex items-start gap-3 border transition-colors ${selected ? 'border-lantern-400/80 bg-lantern-400/10' : 'border-parchment-100/10 bg-night-950/50 hover:border-parchment-100/25'}`}>
        <span className="mt-0.5 shrink-0">{icon}</span>
        <span className="min-w-0">
          <span className="block font-bold text-[16px] text-parchment-50 truncate">{place.label}</span>
          {place.detail && <span className="block text-[13px] text-lichen-300 truncate">{place.detail}</span>}
        </span>
      </button>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-night-950/75 animate-fade-in"
      role="dialog" aria-label="Where are you walking to?">
      <div className="w-full max-w-md max-h-[90dvh] flex flex-col rounded-3xl surface p-5 text-parchment-100">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-display text-2xl font-medium text-parchment-50">Where to?</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="w-10 h-10 -mr-2 rounded-full flex items-center justify-center text-lichen-300 hover:text-parchment-50">
            <X className="w-5 h-5" />
          </button>
        </div>

        <label className="relative block mb-3">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-lichen-400" />
          <input ref={input} value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" enterKeyHint="search"
            placeholder="Search a place or an address"
            className="w-full pl-10 pr-10 h-12 rounded-xl bg-night-950 border border-parchment-100/15 text-[16px] text-parchment-50 placeholder:text-lichen-500 focus:outline-none focus:border-lantern-400" />
          {busy && <Loader2 className="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-lantern-300" />}
        </label>

        <div className="flex-1 overflow-y-auto flex flex-col gap-2 min-h-0">
          {home && option({ ...home, label: home.label || 'Home', detail: 'Saved home' }, <Home className="w-4 h-4 text-lantern-300" />, 'home')}
          {results.map((r, i) => option(r, <MapPin className="w-4 h-4 text-lichen-300" />, `${r.lat},${r.lng},${i}`))}
          {!busy && query.trim().length >= 3 && !results.length && !error && (
            <p className="text-[14px] text-lichen-300 px-1">Nothing by that name. A street address usually works.</p>
          )}
          {error && <p className="text-[14px] text-ember-400 px-1">Search isn't working right now ({error}).</p>}
        </div>

        <button type="button" disabled={!picked} onClick={() => picked && onStart({ lat: picked.lat, lng: picked.lng, label: picked.label || 'Home' })}
          className="btn-lantern mt-4 w-full h-14 rounded-2xl text-[17px] font-bold disabled:opacity-40">
          {picked ? `Walk to ${picked.label || 'Home'}` : 'Pick a place first'}
        </button>
      </div>
    </div>
  );
}
