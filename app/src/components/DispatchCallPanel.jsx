import React, { useEffect, useState } from 'react';
import { PhoneCall, PhoneOff, Mic, MicOff, X } from 'lucide-react';
import { bus } from '../bus';
import { hangUpDispatchCall, toggleDispatchMute, dismissDispatchCall } from '../services/dispatchCall';

// The in-app emergency call (simulated 911): status, timer, mute, hang up, and a tap-to-call
// fallback. Driven only by dispatch.call events from services/dispatchCall.js.
const STATUS = {
  connecting: 'Connecting…',
  ringing: 'Ringing the dispatcher…',
  automated: 'The dispatcher is being called with your location.',
  ended: 'Call ended.',
  failed: "Couldn't connect in the app.",
};

function mmss(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export default function DispatchCallPanel() {
  const [call, setCall] = useState(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => bus.on('dispatch.call', (e) => setCall(e.state === 'idle' ? null : e)), []);
  useEffect(() => {
    if (call?.state !== 'connected') return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [call?.state]);

  if (!call) return null;
  const live = ['connecting', 'ringing', 'connected'].includes(call.state);
  const status = call.state === 'connected' ? `Connected · ${mmss(now - (call.connected_at ?? now))}` : STATUS[call.state];

  return (
    <div role="dialog" aria-live="assertive" aria-label="Emergency call"
      className="w-full p-4 rounded-2xl surface !border-ember-500/60 text-parchment-50 animate-rise-in">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className={`w-11 h-11 rounded-full flex items-center justify-center shrink-0 ${live ? 'bg-ember-500 animate-pulse' : 'bg-night-700'}`}>
            <PhoneCall className="w-5 h-5" />
          </div>
          <div>
            <div className="font-bold text-base leading-tight">Emergency call</div>
            <div className="text-[0.8125rem] text-lichen-300">Demo 911 · {call.display}</div>
          </div>
        </div>
        {!live && (
          <button onClick={dismissDispatchCall} aria-label="Close" className="w-10 h-10 -mr-2 -mt-2 rounded-full flex items-center justify-center text-lichen-300 hover:text-parchment-50">
            <X className="w-5 h-5" />
          </button>
        )}
      </div>

      <div className="mt-3 text-[0.9375rem] font-bold" data-testid="dispatch-status">
        {call.mode === 'mock' && live ? `${status} (simulated)` : status}
      </div>

      {live && (
        <div className="mt-3 flex gap-3">
          <button onClick={toggleDispatchMute}
            className="btn-quiet flex-1 h-12 rounded-xl font-bold text-[0.9375rem] flex items-center justify-center gap-2">
            {call.muted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            {call.muted ? 'Unmute' : 'Mute'}
          </button>
          <button onClick={hangUpDispatchCall}
            className="flex-1 h-12 rounded-xl bg-ember-500 text-white font-bold text-[0.9375rem] flex items-center justify-center gap-2 shadow-press">
            <PhoneOff className="w-4 h-4" /> Hang up
          </button>
        </div>
      )}

      {(call.state === 'failed' || call.state === 'automated') && (
        <a href={`tel:${call.tel}`}
          className="mt-3 w-full h-12 rounded-xl bg-ember-500 text-white font-bold text-[0.9375rem] flex items-center justify-center gap-2 shadow-press">
          <PhoneCall className="w-4 h-4" /> Call {call.display} from your phone
        </a>
      )}

      <p className="mt-3 text-[0.75rem] leading-snug text-lichen-400">
        <strong className="text-lichen-200">Demo:</strong> this calls a demo number standing in for 911. In the full
        product, a monitoring service would contact dispatch.
      </p>
    </div>
  );
}
