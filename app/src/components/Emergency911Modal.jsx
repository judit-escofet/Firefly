import React from 'react';
import { PhoneCall, ShieldAlert, X, AlertTriangle } from 'lucide-react';

export default function Emergency911Modal({ isOpen, onClose, currentCoords }) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-grove-950/85 backdrop-blur-md animate-fade-in select-none">
      <div className="w-full max-w-sm rounded-3xl glass-grove border border-amber-lantern/40 p-6 shadow-2xl space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5 text-amber-lantern">
            <AlertTriangle className="w-6 h-6 stroke-[2.5]" />
            <h3 className="text-base font-whimsical font-bold text-white">
              Demo: This would call 911
            </h3>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full text-sage-300 hover:text-white hover:bg-grove-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-3.5 rounded-2xl bg-grove-950/80 border border-moss-500/20 text-xs text-sage-200 leading-relaxed space-y-2">
          <p>
            <strong className="text-firefly-300">Safety Intercept:</strong> In demo mode and during the stage presentation, emergency calling is intercepted to prevent accidental emergency service dispatches.
          </p>
          <p>
            In production on your phone, tapping this button opens the phone dialer with <span className="font-mono text-white bg-grove-800 px-1 py-0.5 rounded">911</span>. The app never places calls silently.
          </p>
          {currentCoords && (
            <div className="pt-1 text-[0.6875rem] text-moss-300 font-mono">
              Grove Coordinates: {currentCoords.lat.toFixed(5)}, {currentCoords.lng.toFixed(5)}
            </div>
          )}
        </div>

        <button
          onClick={onClose}
          className="w-full py-3.5 px-4 rounded-xl bg-grove-800 hover:bg-grove-700 text-white font-semibold text-sm transition-all border border-moss-500/25"
        >
          Return to Grove Path
        </button>
      </div>
    </div>
  );
}
