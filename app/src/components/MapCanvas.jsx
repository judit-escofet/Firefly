import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { LocateFixed } from 'lucide-react';

// Google Maps-style following: zoomed in on her as she walks; dragging the map pauses it and
// shows a Recenter button.
const FOLLOW_ZOOM = 17;

// Tiles: Esri's dark gray canvas (free, no key). With no network the route, trail and markers
// still draw on the dark background (mock mode with Wi-Fi off).
const DARK_TILES = 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}';

/**
 * Enchanted Grove Map Component powered by Leaflet
 * Features:
 * - Esri dark gray tile layer with a subdued green tint
 * - Glowing enchanted route polyline
 * - Fading trail points behind the walker
 * - Custom SVG firefly marker that pulses and lights up when speaking
 * - Warm lantern marker at Home destination
 * - Graceful offline fallback for airplane mode demo (A10)
 */
export default function MapCanvas({
  route = [],
  currentPosition = null,
  trail = [],
  destination = null,
  isSpeaking = false
}) {
  const mapContainerRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const fireflyMarkerRef = useRef(null);
  const routePolylineRef = useRef(null);
  const routeGlowRef = useRef(null);
  const trailCirclesRef = useRef([]);
  const homeMarkerRef = useRef(null);
  const [offlineTiles, setOfflineTiles] = useState(false);
  const followingRef = useRef(true);
  const fittedRef = useRef(false); // the whole-route overview is shown once, not after reroutes
  const [showRecenter, setShowRecenter] = useState(false);

  // Initialize Leaflet Map
  useEffect(() => {
    if (!mapContainerRef.current || mapInstanceRef.current) return;

    // Default center (NYC Manhattan / mock route area)
    const initialLat = currentPosition?.lat || (route[0] ? (Array.isArray(route[0]) ? route[0][0] : route[0].lat) : 40.7128);
    const initialLng = currentPosition?.lng || (route[0] ? (Array.isArray(route[0]) ? route[0][1] : route[0].lng) : -74.0060);

    const map = L.map(mapContainerRef.current, {
      center: [initialLat, initialLng],
      zoom: 16,
      zoomControl: false,
      attributionControl: false,
    });

    mapInstanceRef.current = map;
    map.on('dragstart', () => {
      followingRef.current = false;
      setShowRecenter(true);
    });

    const dark = L.tileLayer(DARK_TILES, { maxZoom: 19, maxNativeZoom: 16, className: 'tiles-dark' });
    dark.on('tileerror', () => setOfflineTiles(true)); // offline: route, trail and markers still draw
    dark.addTo(map);

    return () => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }
      // Layers belonged to the removed map (React StrictMode mounts effects twice in dev).
      fireflyMarkerRef.current = null;
      routePolylineRef.current = null;
      routeGlowRef.current = null;
      homeMarkerRef.current = null;
      trailCirclesRef.current = [];
    };
  }, []);

  // Update Route Polyline & Fit Bounds
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map || !route || route.length === 0) return;

    const latLngs = route.map(pt => (Array.isArray(pt) ? [pt[0], pt[1]] : [pt.lat, pt.lng]));

    // Remove previous polylines
    if (routeGlowRef.current) map.removeLayer(routeGlowRef.current);
    if (routePolylineRef.current) map.removeLayer(routePolylineRef.current);

    // Glowing outer aura polyline
    const glow = L.polyline(latLngs, {
      color: '#0c1511',
      weight: 9,
      opacity: 0.7,
      lineCap: 'round',
      lineJoin: 'round',
    }).addTo(map);
    routeGlowRef.current = glow;

    // Core sharp golden route
    const line = L.polyline(latLngs, {
      color: '#ffd27a',
      weight: 5,
      opacity: 0.95,
      lineCap: 'round',
      lineJoin: 'round',
    }).addTo(map);
    routePolylineRef.current = line;

    // Whole-route overview once at the start (not after a reroute: following takes over).
    if (!fittedRef.current) {
      fittedRef.current = true;
      try {
        map.fitBounds(L.latLngBounds(latLngs), { padding: [50, 50], maxZoom: 17 });
      } catch (e) {
        // Ignored
      }
    }
  }, [route]);

  // Update Home / Destination Lantern Marker
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;

    const destCoord = destination || (route && route.length > 0 
      ? (Array.isArray(route[route.length - 1]) 
          ? { lat: route[route.length - 1][0], lng: route[route.length - 1][1] }
          : route[route.length - 1])
      : null);

    if (destCoord && destCoord.lat) {
      if (homeMarkerRef.current) {
        map.removeLayer(homeMarkerRef.current);
      }

      // The destination's name (first part, e.g. "Newark Penn Station"), escaped for the HTML below.
      const name = String(destination?.label || 'Home').split(',')[0].trim().slice(0, 22) || 'Home';
      const label = name.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
      const homeHtml = `
        <div class="flex flex-col items-center select-none" style="transform: translate(-50%, -85%);">
          <svg width="34" height="34" viewBox="0 0 30 30" style="overflow:visible">
            <circle cx="15" cy="18" r="14" fill="#ffd27a" opacity=".25"/>
            <path d="M4 14 L15 4 L26 14Z" fill="#0c1511" stroke="#efe6d0" stroke-width="1.4" stroke-linejoin="round"/>
            <rect x="7" y="13" width="16" height="13" fill="#0c1511" stroke="#efe6d0" stroke-width="1.4"/>
            <rect x="10" y="16" width="4.5" height="4.5" fill="#ffd27a"/>
          </svg>
          <span class="mt-1 px-2 py-0.5 rounded-md bg-night-950/90 text-[12px] font-bold text-parchment-100 whitespace-nowrap">${label}</span>
        </div>
      `;

      const homeIcon = L.divIcon({
        html: homeHtml,
        className: 'custom-home-marker',
        iconSize: [0, 0],
      });

      homeMarkerRef.current = L.marker([destCoord.lat, destCoord.lng], { icon: homeIcon }).addTo(map);
    }
  }, [destination, route]);

  // Update User Firefly Position & Speaking Aura
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;

    const lat = currentPosition?.lat || (route[0] ? (Array.isArray(route[0]) ? route[0][0] : route[0].lat) : 40.7128);
    const lng = currentPosition?.lng || (route[0] ? (Array.isArray(route[0]) ? route[0][1] : route[0].lng) : -74.0060);

    const fireflyHtml = `
      <div class="relative select-none" style="transform: translate(-50%, -50%); width: 44px; height: 44px;">
        <div class="absolute inset-0 rounded-full transition-all duration-500" style="background: radial-gradient(circle, rgba(255,214,120,${isSpeaking ? 0.7 : 0.4}) 0%, rgba(255,214,120,0) 68%); transform: scale(${isSpeaking ? 1.6 : 1});"></div>
        <div class="absolute rounded-full" style="left: 14px; top: 14px; width: 16px; height: 16px; background: #ffe2a0; border: 2.5px solid #0c1511; box-shadow: 0 0 0 2px #ffd27a;"></div>
      </div>
    `;

    const icon = L.divIcon({
      html: fireflyHtml,
      className: 'custom-firefly-marker',
      iconSize: [0, 0],
    });

    if (fireflyMarkerRef.current) {
      fireflyMarkerRef.current.setLatLng([lat, lng]);
      fireflyMarkerRef.current.setIcon(icon);
    } else {
      fireflyMarkerRef.current = L.marker([lat, lng], { icon, zIndexOffset: 1000 }).addTo(map);
    }

    // Follow her, zoomed in like turn-by-turn navigation (unless she dragged the map away).
    if (currentPosition && followingRef.current) {
      map.setView([lat, lng], Math.max(map.getZoom(), FOLLOW_ZOOM), { animate: true, duration: 1.0 });
    }
  }, [currentPosition, isSpeaking, route]);

  const recenter = () => {
    const map = mapInstanceRef.current;
    followingRef.current = true;
    setShowRecenter(false);
    if (map && currentPosition) map.setView([currentPosition.lat, currentPosition.lng], Math.max(map.getZoom(), FOLLOW_ZOOM), { animate: true });
  };

  // Update Fading Trail
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map || !trail || trail.length === 0) return;

    // Clear old trail circles
    for (const c of trailCirclesRef.current) {
      map.removeLayer(c);
    }
    trailCirclesRef.current = [];

    // Render trail points with fading opacity
    const maxTrail = 20;
    const recentTrail = trail.slice(-maxTrail);

    const newCircles = recentTrail.map((pt, idx) => {
      const progress = (idx + 1) / recentTrail.length;
      const opacity = 0.1 + progress * 0.35;
      const circle = L.circleMarker([pt.lat, pt.lng], {
        radius: 2 + progress * 1.5,
        stroke: false,
        fillColor: '#efe6d0',
        fillOpacity: opacity,
      }).addTo(map);
      return circle;
    });

    trailCirclesRef.current = newCircles;
  }, [trail]);

  return (
    <div className="relative w-full h-full overflow-hidden bg-night-950">
      {/* Leaflet Map DOM Container */}
      <div
        ref={mapContainerRef}
        className="w-full h-full block"
        style={{ background: '#0c1511' }}
      />

      {showRecenter && (
        <button type="button" onClick={recenter}
          className="absolute right-3 top-[45%] z-20 flex items-center gap-1.5 px-4 h-11 rounded-full surface text-parchment-100 text-[14px] font-bold active:translate-y-px">
          <LocateFixed className="w-4 h-4" /> Recenter
        </button>
      )}

      {/* darker edges so the floating boxes sit on calmer map */}
      <div className="absolute inset-0 pointer-events-none shadow-[inset_0_0_60px_rgba(8,14,11,0.7)] z-10" />

    </div>
  );
}
