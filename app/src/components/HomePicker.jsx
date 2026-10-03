import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { LocateFixed, MapPin } from 'lucide-react';
import { MOCK_HOME } from '../services/mockData';

/**
 * "Home address on a map" (P4 spec, setup step 3): tap the map to place home, or use the
 * current location. value = {lat, lng, label}. Arrival is detected within 30 m of this point.
 */
export default function HomePicker({ value, onChange }) {
  const el = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const [locating, setLocating] = useState(false);
  const home = value ?? MOCK_HOME;
  const latest = useRef(home); // the map's click handler is registered once: read the current value
  latest.current = home;

  useEffect(() => {
    if (!el.current || mapRef.current) return;
    const map = L.map(el.current, { center: [home.lat, home.lng], zoom: 16, zoomControl: false, attributionControl: false });
    // Esri's dark gray canvas: free, no key (CARTO's basemaps now require one).
    L.tileLayer('https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, maxNativeZoom: 16, className: 'tiles-dark' }).addTo(map);
    map.on('click', (e) => onChange({ ...latest.current, lat: Number(e.latlng.lat.toFixed(6)), lng: Number(e.latlng.lng.toFixed(6)) }));
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null; // it belonged to the removed map (StrictMode remounts)
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.invalidateSize();
    const icon = L.divIcon({
      className: '',
      html: '<div style="transform:translate(-50%,-100%);font-size:26px;filter:drop-shadow(0 0 8px #facc15)">🏡</div>',
      iconSize: [0, 0],
    });
    if (markerRef.current) markerRef.current.setLatLng([home.lat, home.lng]);
    else markerRef.current = L.marker([home.lat, home.lng], { icon }).addTo(map);
  }, [home.lat, home.lng]);

  const useMyLocation = () => {
    if (!('geolocation' in navigator)) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setLocating(false);
        const next = { ...home, lat: Number(p.coords.latitude.toFixed(6)), lng: Number(p.coords.longitude.toFixed(6)) };
        onChange(next);
        mapRef.current?.setView([next.lat, next.lng], 17);
      },
      () => setLocating(false),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  return (
    <div className="space-y-2">
      <div ref={el} className="w-full h-48 rounded-2xl overflow-hidden border border-white/15" aria-label="Map: tap to set home" />
      <div className="flex gap-2">
        <input
          type="text"
          value={home.label ?? ''}
          onChange={(e) => onChange({ ...home, label: e.target.value })}
          placeholder="Name it (e.g. Home, Dorm)"
          aria-label="Home name"
          className="flex-1 px-3 py-2.5 rounded-xl bg-twilight-950 border border-white/15 text-xs text-white placeholder-slate-400 focus:outline-none focus:border-gold-400"
        />
        <button type="button" onClick={useMyLocation} className="px-3 py-2.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 bg-mystic-800 text-gold-300 border border-gold-400/30">
          <LocateFixed className="w-3.5 h-3.5" />
          <span>{locating ? 'Locating…' : "I'm home now"}</span>
        </button>
      </div>
      <div className="text-[11px] text-pastel-mint flex items-center gap-1.5">
        <MapPin className="w-3 h-3 text-gold-400" />
        <span>
          Tap the map to move the pin · {home.lat.toFixed(4)}, {home.lng.toFixed(4)} · arrival within 30 m
        </span>
      </div>
    </div>
  );
}
