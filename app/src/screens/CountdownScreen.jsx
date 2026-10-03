import React, { useState, useEffect } from 'react';
import { verifyPin } from '../crypto';
import { bus } from '../bus';
import { countdownFeedback } from '../services/audioTone';
import { Delete, CheckCircle2 } from 'lucide-react';

/**
 * Calm countdown screen (P4 spec): dim, no red, no word like "alert" anyone nearby could read,
 * a quiet ring and a vibration pattern. The 10 s countdown itself is the Guardian's
 * (alert.state → secondsLeft); this screen only checks the PIN locally against the saved
 * hashes and emits pin.entered {kind}. A wrong PIN just clears the pad (A7: cancel and duress
 * both show the identical "All good" screen).
 */
export default function CountdownScreen({ secondsLeft, userId, cancelPinHash, duressPinHash, onDone }) {
  const [pinDigits, setPinDigits] = useState('');
  const [isVerifying, setIsVerifying] = useState(false);
  const [shake, setShake] = useState(false);
  const [allGood, setAllGood] = useState(false);

  useEffect(() => {
    countdownFeedback.start();
    return () => countdownFeedback.stop();
  }, []);

  const handleDigit = async (digit) => {
    if (pinDigits.length >= 4 || isVerifying || allGood) return;
    const next = pinDigits + digit;
    setPinDigits(next);
    if (next.length < 4) return;

    setIsVerifying(true);
    const kind = await verifyPin(next, userId, cancelPinHash, duressPinHash);
    if (kind) {
      countdownFeedback.stop();
      bus.emit('pin.entered', { kind });
      setAllGood(true); // identical for cancel and duress
      setTimeout(onDone, 1800);
    } else {
      setShake(true);
      setTimeout(() => {
        setPinDigits('');
        setShake(false);
        setIsVerifying(false);
      }, 350);
    }
  };

  const handleDelete = () => {
    if (pinDigits.length > 0 && !isVerifying) setPinDigits(pinDigits.slice(0, -1));
  };

  if (allGood) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center p-6 bg-grove-950 text-sage-100 animate-fade-in select-none">
        <div className="p-8 rounded-3xl glass-grove border border-moss-400/30 flex flex-col items-center text-center max-w-sm w-full shadow-2xl">
          <div className="w-16 h-16 rounded-full bg-grove-900 border border-moss-400/40 flex items-center justify-center mb-5 text-moss-300">
            <CheckCircle2 className="w-9 h-9 stroke-[2]" />
          </div>
          <h2 className="text-2xl font-whimsical font-bold text-white mb-2">All good, enjoy your walk</h2>
          <p className="text-xs text-sage-300">Continuing through the grove…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-between p-6 bg-grove-950 text-sage-200 select-none">
      <div className="pt-6 text-center">
        <p className="text-xs font-whimsical tracking-widest text-sage-400" aria-live="polite">
          {Number.isFinite(secondsLeft) ? `${secondsLeft}s` : ''}
        </p>
      </div>

      <div className="flex flex-col items-center justify-center my-auto w-full max-w-xs mx-auto">
        <h2 className="text-xl font-whimsical font-semibold text-sage-100 text-center mb-6">Enter your PIN to continue</h2>

        <div className={`flex gap-4 mb-8 ${shake ? 'animate-shake' : ''}`} aria-label={`${pinDigits.length} of 4 digits entered`}>
          {[0, 1, 2, 3].map((idx) => (
            <div
              key={idx}
              className={`w-3.5 h-3.5 rounded-full transition-all duration-200 ${
                idx < pinDigits.length ? 'bg-sage-200 scale-110 shadow-sm' : 'bg-grove-900 border border-moss-500/30'
              }`}
            />
          ))}
        </div>

        <div className="grid grid-cols-3 gap-3 w-full">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((num) => (
            <button
              key={num}
              type="button"
              onClick={() => handleDigit(num)}
              disabled={isVerifying}
              aria-label={`digit ${num}`}
              className="h-16 rounded-2xl bg-grove-900/90 border border-moss-500/25 active:bg-grove-800 text-2xl font-medium text-sage-100 flex items-center justify-center transition-transform active:scale-95 touch-manipulation shadow-sm"
            >
              {num}
            </button>
          ))}
          <div />
          <button
            type="button"
            onClick={() => handleDigit('0')}
            disabled={isVerifying}
            aria-label="digit 0"
            className="h-16 rounded-2xl bg-grove-900/90 border border-moss-500/25 active:bg-grove-800 text-2xl font-medium text-sage-100 flex items-center justify-center transition-transform active:scale-95 touch-manipulation shadow-sm"
          >
            0
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={isVerifying}
            aria-label="delete digit"
            className="h-16 rounded-2xl bg-grove-900/60 border border-moss-500/20 active:bg-grove-800 text-sage-400 flex items-center justify-center transition-transform active:scale-95 touch-manipulation shadow-sm"
          >
            <Delete className="w-6 h-6" />
          </button>
        </div>
      </div>

      <div className="pb-6" />
    </div>
  );
}
