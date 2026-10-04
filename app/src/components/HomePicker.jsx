import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { LocateFixed } from 'lucide-react';
import { MOCK_HOME } from '../services/mockData';

/**
 * "Home address on a map" (P4 spec, setup step 3): tap the map to place home, or use the
 * current location. value = {lat, lng, label}. Arrival is detected within 30 m of this point.
 */
export default function HomePicker({ value, onChange, fill = false }) {
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
    // The map's box grows and shrinks with the screen: keep Leaflet's idea of its size in step.
    const resize = new ResizeObserver(() => map.invalidateSize());
    resize.observe(el.current);
    return () => {
      resize.disconnect();
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
      html: '<svg style="transform:translate(-50%,-100%);overflow:visible" width="30" height="30" viewBox="0 0 30 30"><circle cx="15" cy="18" r="13" fill="#ffd27a" opacity=".22"/><path d="M4 14 L15 4 L26 14Z" fill="#0c1511" stroke="#efe6d0" stroke-width="1.4" stroke-linejoin="round"/><rect x="7" y="13" width="16" height="13" fill="#0c1511" stroke="#efe6d0" stroke-width="1.4"/><rect x="10" y="16" width="4.5" height="4.5" fill="#ffd27a"/></svg>',
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
    <div className={`flex flex-col gap-2.5 ${fill ? 'flex-1 min-h-0' : ''}`}>
      <div ref={el} className={`w-full ${fill ? 'flex-1 min-h-[5rem]' : 'h-52'} rounded-2xl overflow-hidden border border-parchment-100/15`} aria-label="Map: tap to set home" />
      <div className="flex gap-2">
        <input
          type="text"
          value={home.label ?? ''}
          onChange={(e) => onChange({ ...home, label: e.target.value })}
          placeholder="Call it… Home, Dorm"
          aria-label="Home name"
          className="flex-1 min-w-0 px-4 h-12 rounded-xl bg-night-950 border border-parchment-100/15 text-[1rem] text-parchment-50 placeholder:text-lichen-500 focus:outline-none focus:border-lantern-400"
        />
        <button type="button" onClick={useMyLocation} className="btn-quiet h-12 px-4 rounded-xl text-[0.9375rem] flex items-center gap-2 shrink-0">
          <LocateFixed className="w-4 h-4" />
          <span>{locating ? 'Finding you…' : "I'm home now"}</span>
        </button>
      </div>
    </div>
  );
}
