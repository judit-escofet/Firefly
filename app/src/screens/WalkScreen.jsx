import React, { useState, useEffect } from 'react';
import { bus } from '../bus';
import { wakeLockService } from '../services/wakeLock';
import MapCanvas from '../components/MapCanvas';
import FireflyCompanion from '../components/FireflyCompanion';
import DispatchCallPanel from '../components/DispatchCallPanel';
import { startDispatchCall, DEMO_DISPATCH_TEL } from '../services/dispatchCall';
import { PhoneCall, Clock, Navigation, X, Info } from 'lucide-react';

/**
 * Walk screen (P4 spec 2): full-screen map with the glowing route and her trail, the firefly
 * (glows only while speaking, A5), ETA and distance, a small "listening" indicator, a big
 * Call 911 button and End walk. For the demo, "Call 911" places an in-app call to the demo
 * dispatch number (312-826-2020, never real 911): see services/dispatchCall.js. In mock mode the
 * call is simulated on screen. Everything shown comes from the bus: position.updated, companion.speaking.
 */
export default function WalkScreen({ walk, alerted = false, modules, onEndWalk }) {
  const [position, setPosition] = useState(null);
  const [trail, setTrail] = useState([]);
  const [remaining, setRemaining] = useState(walk.route.distance_m);
  const [eta, setEta] = useState(walk.route.eta_s);
  const [speaking, setSpeaking] = useState(false);
  const [caption, setCaption] = useState(null);
  const [heard, setHeard] = useState(null);
  const [wakeLock, setWakeLock] = useState({ active: false, supported: true });
  const [listening, setListening] = useState('starting');

  useEffect(() => {
    const offs = [
      wakeLockService.subscribe(setWakeLock),
      bus.on('position.updated', (e) => {
        setPosition({ lat: e.lat, lng: e.lng });
        if (e.trail) setTrail(e.trail);
        if (Number.isFinite(e.remaining_m)) setRemaining(e.remaining_m);
        if (Number.isFinite(e.eta_s)) setEta(e.eta_s);
      }),
      bus.on('companion.speaking', (e) => {
        setSpeaking(Boolean(e.on));
        if (e.on && e.text) setCaption(e.text);
      }),
      bus.on('speech.heard', (e) => setHeard(e.final ? null : e.text)),
    ];
    // "Listening" reflects the real mic: the companion's transcriber and the guardian's detector.
    const t = setInterval(() => {
      const stt = modules?.companion?.status?.stt ?? '';
      const g = modules?.guardian?.status?.mode ?? '';
      if (/error|denied/i.test(stt) || g === 'error') setListening('mic off');
      else if (stt === 'listening' || /mock/.test(stt) || g === 'classifier' || g === 'yamnet-only') setListening('listening');
      else setListening('starting');
    }, 700);
    return () => {
      offs.forEach((off) => off());
      clearInterval(t);
    };
  }, [modules]);

  // Keep the last caption on screen a little after the firefly stops talking.
  useEffect(() => {
    if (speaking || !caption) return;
    const t = setTimeout(() => setCaption(null), 4000);
    return () => clearTimeout(t);
  }, [speaking, caption]);

  // The href (tel: the demo number) is only the no-JavaScript fallback.
  const handle911Press = (e) => {
    e.preventDefault();
    startDispatchCall(walk, { reason: 'button' });
  };

  const etaMinutes = Math.max(1, Math.ceil(eta / 60));
  const remainingText = remaining >= 1000 ? `${(remaining / 1000).toFixed(1)}` : `${Math.round(remaining)}`;
  const remainingUnit = remaining >= 1000 ? 'km' : 'm';

  return (
    <div className="relative w-full h-[100dvh] overflow-hidden bg-twilight-950 text-white select-none">
      <div className="absolute inset-0 z-0">
        <MapCanvas route={walk.route.points} currentPosition={position} trail={trail} destination={walk.destination} isSpeaking={speaking} />
      </div>

      <div className="absolute top-4 left-4 right-4 z-20 flex flex-col gap-2 max-w-md mx-auto">
        <DispatchCallPanel />

        {alerted && (
          <div className="p-3 rounded-2xl glass-mythic-card flex items-center gap-2.5 text-xs text-gold-200 animate-fade-in shadow-xl">
            <div className="w-2.5 h-2.5 rounded-full bg-gold-400 shrink-0" />
            <span className="font-medium">Your contacts have been told where you are.</span>
          </div>
        )}

        {!wakeLock.supported && (
          <div className="px-3 py-1.5 rounded-xl bg-twilight-900/90 border border-white/15 text-[11px] text-pastel-lavender flex items-center gap-1.5">
            <Info className="w-3.5 h-3.5 text-gold-400 shrink-0" />
            <span>This browser can't keep the screen on: please keep it awake while you walk.</span>
          </div>
        )}

        <div className="p-4 rounded-3xl glass-mythic-card flex items-center justify-between shadow-2xl">
          <div className="flex items-center gap-4">
            <div>
              <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-pastel-lavender font-bold">
                <Clock className="w-3 h-3 text-gold-400" />
                <span>ETA</span>
              </div>
              <div className="text-2xl font-cinzel font-bold text-white tracking-tight">
                {etaMinutes} <span className="text-sm font-sans font-normal text-pastel-lavender">min</span>
              </div>
            </div>
            <div className="h-8 w-px bg-white/15" />
            <div>
              <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-pastel-lavender font-bold">
                <Navigation className="w-3 h-3 text-gold-400" />
                <span>Left</span>
              </div>
              <div className="text-2xl font-cinzel font-bold text-white tracking-tight">
                {remainingText} <span className="text-sm font-sans font-normal text-pastel-lavender">{remainingUnit}</span>
              </div>
            </div>
          </div>

          <div className="flex flex-col items-end">
            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-mystic-900/90 border border-gold-400/40 text-[11px] font-semibold text-gold-200 shadow-sm">
              <span className={`w-2 h-2 rounded-full ${listening === 'listening' ? 'bg-emerald-400 animate-pulse' : listening === 'mic off' ? 'bg-slate-400' : 'bg-gold-400 animate-pulse'}`} />
              <span>{listening === 'listening' ? 'Listening' : listening === 'mic off' ? 'Mic off' : 'Starting…'}</span>
            </div>
            {heard && <span className="text-[10px] text-pastel-mint mt-1 max-w-[9rem] truncate italic">“{heard}”</span>}
          </div>
        </div>
      </div>

      <div className="absolute right-4 bottom-32 z-20 flex flex-col items-end max-w-[85vw]">
        <FireflyCompanion isSpeaking={speaking} message={caption} size="md" />
      </div>

      <div className="absolute bottom-5 left-4 right-4 z-20 max-w-md mx-auto flex flex-col gap-3" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <div className="flex items-center gap-3">
          <a
            href={`tel:${DEMO_DISPATCH_TEL}`}
            onClick={handle911Press}
            className="flex-1 py-4 px-5 rounded-2xl bg-gradient-to-r from-crimson-600 via-rose-700 to-crimson-700 text-white font-extrabold text-base flex items-center justify-center gap-2.5 shadow-xl active:scale-[0.98] transition-transform touch-manipulation border border-crimson-400/50"
          >
            <PhoneCall className="w-5 h-5 fill-white stroke-[2.5]" />
            <span className="tracking-wide">Call 911</span>
          </a>
          <button
            onClick={onEndWalk}
            className="py-4 px-6 rounded-2xl glass-mythic text-slate-100 font-bold text-sm flex items-center justify-center gap-2 active:scale-[0.98] transition-all"
          >
            <X className="w-4 h-4 stroke-[2.5]" />
            <span>End walk</span>
          </button>
        </div>
      </div>

    </div>
  );
}
