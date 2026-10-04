import React, { useState, useEffect } from 'react';
import { bus } from '../bus';
import { wakeLockService } from '../services/wakeLock';
import MapCanvas from '../components/MapCanvas';
import FireflyCompanion from '../components/FireflyCompanion';
import DispatchCallPanel from '../components/DispatchCallPanel';
import NavigationBanner from '../components/NavigationBanner';
import { startDispatchCall, DEMO_DISPATCH_TEL } from '../services/dispatchCall';
import { formatDistance } from '../services/units';
import { currentMic } from '../audio/micHub.js';
import { PhoneCall, Info, Mic, MicOff } from 'lucide-react';

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
  const [level, setLevel] = useState(0); // live mic input, 0..1
  const [diag, setDiag] = useState(null); // tap "Listening" to see what the mic is doing
  const [showDiag, setShowDiag] = useState(false);

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
      const mic = currentMic();
      const st = mic?.stats;
      // Only digital silence for a few seconds = the phone isn't giving us the mic at all.
      const silent = st && st.chunks > 60 && st.zeroChunks === st.chunks;
      if (/denied/i.test(stt)) setListening('mic off');
      else if (mic?.stalled || silent) setListening('stuck');
      else if (/error/i.test(stt) || g === 'error') setListening('mic off');
      else if (stt === 'listening' || /mock/.test(stt) || g === 'classifier' || g === 'yamnet-only') setListening('listening');
      else setListening('starting');
      // Meter: input level in dB, -60 dB (silence) .. -12 dB (talking close to the phone) → 0..1.
      const db = mic?.level > 0 ? 20 * Math.log10(mic.level) : -100;
      setLevel(Math.max(0, Math.min(1, (db + 60) / 48)));
      setDiag(mic ? `${mic.diagnostics?.() ?? ''} · stt ${stt || '—'} · guardian ${g || '—'}` : `no mic · stt ${stt || '—'}`);
    }, 250);
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
  const { value: remainingText, unit: remainingUnit } = formatDistance(remaining);

  return (
    <div className="relative w-full h-[100dvh] overflow-hidden bg-night-950 text-parchment-100 select-none">
      <div className="absolute inset-0 z-0">
        <MapCanvas route={walk.route.points} currentPosition={position} trail={trail} destination={walk.destination} isSpeaking={speaking} />
      </div>

      <div className="absolute top-0 inset-x-0 z-20 px-3 pt-[max(0.75rem,env(safe-area-inset-top))] flex flex-col gap-2 max-w-md mx-auto">
        <DispatchCallPanel />

        {alerted && (
          <div className="px-4 py-3 rounded-2xl surface text-[0.9375rem] text-parchment-50 animate-rise-in">
            Your people know where you are now.
          </div>
        )}

        {!wakeLock.supported && (
          <div className="px-4 py-2 rounded-xl surface text-[0.8125rem] text-lichen-300 flex items-center gap-2">
            <Info className="w-4 h-4 text-lantern-300 shrink-0" />
            <span>Keep your screen on while you walk (this browser can't do it for you).</span>
          </div>
        )}

        {/* One box: next turn on top, then time and distance left, and whether I can hear you. */}
        <NavigationBanner>
          <div className="flex items-end justify-between gap-3">
            <p className="font-display text-parchment-50 leading-none">
              <span className="text-[1.9rem] font-medium">{etaMinutes}</span>
              <span className="text-base text-lichen-300"> min</span>
              <span className="mx-2 text-lichen-500">·</span>
              <span className="text-[1.9rem] font-medium">{remainingText}</span>
              <span className="text-base text-lichen-300"> {remainingUnit}</span>
            </p>
            <div className="flex flex-col items-end min-w-0 pb-0.5">
              <button type="button" aria-label="Microphone status"
                onClick={() => {
                  // Inside a tap iOS lets audio start: wake a stalled mic, and show what it's doing.
                  currentMic()?.revive?.();
                  if (listening !== 'stuck') setShowDiag((v) => !v);
                }}
                className={`flex items-center gap-1.5 text-[0.8125rem] ${listening === 'listening' ? 'text-moss-300' : listening === 'mic off' ? 'text-ember-400' : listening === 'stuck' ? 'text-lantern-300' : 'text-lichen-400'}`}>
                {listening === 'mic off' ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
                {listening === 'listening' ? 'Listening' : listening === 'mic off' ? "Can't hear you" : listening === 'stuck' ? 'Tap to wake the mic' : 'Starting…'}
                {(listening === 'listening' || listening === 'starting') && (
                  // Live level: proof the phone is actually giving us sound.
                  <span className="flex items-end gap-[2px] h-3 ml-0.5" aria-hidden="true">
                    {[0.15, 0.4, 0.65, 0.9].map((th, i) => (
                      <span key={i} className={`w-[3px] rounded-full transition-colors ${level > th ? 'bg-moss-300' : 'bg-parchment-100/20'}`} style={{ height: `${40 + i * 20}%` }} />
                    ))}
                  </span>
                )}
              </button>
              {heard && <span className="text-[0.75rem] text-lichen-300 mt-0.5 max-w-[10rem] truncate italic">“{heard}”</span>}
            </div>
          </div>
          {showDiag && diag && <p className="mt-2 pt-2 border-t border-parchment-100/10 text-[0.6875rem] leading-snug text-lichen-400 break-words select-text">{diag}</p>}
        </NavigationBanner>
      </div>

      <div className="absolute right-3 bottom-[7.5rem] z-20 flex flex-col items-end max-w-[85vw]">
        <FireflyCompanion isSpeaking={speaking} message={caption} size="md" />
      </div>

      <div className="absolute bottom-0 inset-x-0 z-20 px-3 pb-[max(1rem,env(safe-area-inset-bottom))] max-w-md mx-auto">
        <div className="flex items-stretch gap-2">
          <a
            href={`tel:${DEMO_DISPATCH_TEL}`}
            onClick={handle911Press}
            className="flex-1 h-14 rounded-2xl bg-ember-500 hover:bg-ember-400 text-white font-bold text-[1.0625rem] flex items-center justify-center gap-2 shadow-press active:translate-y-px touch-manipulation"
          >
            <PhoneCall className="w-5 h-5" />
            Call 911
          </a>
          <button
            onClick={onEndWalk}
            className="h-14 px-5 rounded-2xl surface text-parchment-100 font-bold text-[0.9375rem] active:translate-y-px"
          >
            End walk
          </button>
        </div>
      </div>
    </div>
  );
}
