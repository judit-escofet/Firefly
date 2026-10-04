import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';

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
      color: '#f2cc57',
      weight: 10,
      opacity: 0.35,
      lineCap: 'round',
      lineJoin: 'round',
    }).addTo(map);
    routeGlowRef.current = glow;

    // Core sharp golden route
    const line = L.polyline(latLngs, {
      color: '#fff5c0',
      weight: 3.5,
      opacity: 0.9,
      lineCap: 'round',
      lineJoin: 'round',
    }).addTo(map);
    routePolylineRef.current = line;

    // Initial fit bounds
    try {
      const bounds = L.latLngBounds(latLngs);
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 17 });
    } catch (e) {
      // Ignored
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
        <div class="relative flex flex-col items-center select-none" style="transform: translate(-50%, -100%);">
          <div class="relative w-8 h-8 rounded-full bg-grove-900/90 border-2 border-firefly-400 flex items-center justify-center shadow-firefly animate-pulse-slow">
            <svg class="w-4 h-4 text-firefly-300" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 3L2 12h3v8h14v-8h3L12 3zm0 2.84L18 11v7h-3v-5H9v5H6v-7l6-5.16z"/>
            </svg>
            <div class="absolute -inset-1 rounded-full bg-firefly-400/30 blur-sm -z-10"></div>
          </div>
          <span class="mt-1 px-2 py-0.5 rounded-full bg-grove-950/80 border border-firefly-400/40 text-[10px] font-bold text-firefly-300 uppercase tracking-widest whitespace-nowrap">
            ${label}
          </span>
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
      <div class="relative flex items-center justify-center select-none" style="transform: translate(-50%, -50%); width: 44px; height: 44px;">
        <!-- Speaking Shockwave Aura -->
        ${isSpeaking ? '<div class="absolute -inset-3 rounded-full bg-firefly-300/40 blur-md animate-ping"></div>' : ''}
        
        <!-- Ambient Bioluminescent Halo -->
        <div class="absolute -inset-1 rounded-full ${isSpeaking ? 'bg-gradient-to-tr from-firefly-400 to-amber-500 blur-md scale-125' : 'bg-moss-500/35 blur-sm'} transition-all duration-300"></div>

        <!-- Mythical Spirit SVG with Fluttering Wings -->
        <div class="relative z-10 w-10 h-10 flex items-center justify-center ${isSpeaking ? 'scale-110' : ''}">
          <svg viewBox="0 0 100 100" class="w-full h-full overflow-visible drop-shadow-md">
            <!-- Left Fairy Wing -->
            <path d="M 44 48 C 18 16, 6 28, 24 54 C 32 64, 44 56, 44 48 Z" fill="rgba(255,255,255,0.75)" stroke="rgba(242,204,87,0.5)" stroke-width="0.8"/>
            <!-- Right Fairy Wing -->
            <path d="M 56 48 C 82 16, 94 28, 76 54 C 68 64, 56 56, 56 48 Z" fill="rgba(255,255,255,0.75)" stroke="rgba(242,204,87,0.5)" stroke-width="0.8"/>
            <!-- Glowing Mythic Heart -->
            <ellipse cx="50" cy="56" rx="12" ry="15" fill="#f5d365" filter="drop-shadow(0 0 8px #f5d365)"/>
            <ellipse cx="50" cy="55" rx="5" ry="6" fill="#ffffff"/>
            <!-- Sprite Head -->
            <ellipse cx="50" cy="38" rx="5.5" ry="5" fill="#123321"/>
            <!-- Antennae -->
            <path d="M 48 35 Q 40 24 33 24" stroke="#f5d365" stroke-width="1.2" fill="none"/>
            <path d="M 52 35 Q 60 24 67 24" stroke="#f5d365" stroke-width="1.2" fill="none"/>
            <circle cx="33" cy="24" r="1.5" fill="#ffffff"/>
            <circle cx="67" cy="24" r="1.5" fill="#ffffff"/>
          </svg>
        </div>
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

    // Smooth pan to keep user in centered view
    map.panTo([lat, lng], { animate: true, duration: 1.0 });
  }, [currentPosition, isSpeaking, route]);

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
      const opacity = 0.15 + progress * 0.55;
      const circle = L.circleMarker([pt.lat, pt.lng], {
        radius: 3 + progress * 2.5,
        color: '#549c71',
        weight: 1,
        fillColor: '#f2cc57',
        fillOpacity: opacity,
      }).addTo(map);
      return circle;
    });

    trailCirclesRef.current = newCircles;
  }, [trail]);

  return (
    <div className="relative w-full h-full overflow-hidden bg-grove-950">
      {/* Leaflet Map DOM Container */}
      <div
        ref={mapContainerRef}
        className="w-full h-full block"
        style={{ background: '#030a06' }}
      />

      {/* Enchanted Forest Vignette Overlay */}
      <div className="absolute inset-0 pointer-events-none shadow-[inset_0_0_80px_rgba(3,10,6,0.85)] z-10" />

      {/* Floating Whimsical Grove Wisps */}
      <div className="absolute inset-0 pointer-events-none z-10 overflow-hidden">
        <div className="absolute top-1/4 left-1/6 w-2 h-2 rounded-full bg-firefly-300/40 blur-[1px] animate-wisp-drift" />
        <div className="absolute top-1/2 right-1/5 w-1.5 h-1.5 rounded-full bg-sage-300/35 blur-[1px] animate-wisp-drift" style={{ animationDelay: '2.5s' }} />
        <div className="absolute bottom-1/3 left-1/3 w-2 h-2 rounded-full bg-moss-400/30 blur-[2px] animate-wisp-drift" style={{ animationDelay: '4s' }} />
      </div>
    </div>
  );
}
