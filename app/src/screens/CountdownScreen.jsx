import React, { useState, useEffect } from 'react';
import { verifyPin } from '../crypto';
import { bus } from '../bus';
import { countdownFeedback } from '../services/audioTone';
import { Delete, CheckCircle2 } from 'lucide-react';

/**
 * Calm countdown screen (P4 spec): dim, no red, no word like "alert" anyone nearby could read,
 * a quiet ring and a vibration pattern. The 10 s countdown itself is the Guardian's
 * (alert.state → secondsLeft); this screen only checks the PIN locally against the saved
 * hash and emits pin.entered {kind}: her PIN → cancel; ANY other code → duress (help is called
 * silently). Both show the identical "All good" screen.
 */
export default function CountdownScreen({ secondsLeft, userId, cancelPinHash, onDone }) {
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
    const kind = await verifyPin(next, userId, cancelPinHash);
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
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center p-6 bg-night-950 text-parchment-100 animate-fade-in select-none">
        <div className="flex flex-col items-center text-center max-w-xs">
          <CheckCircle2 className="w-10 h-10 text-moss-300 mb-5" strokeWidth={1.75} />
          <h2 className="font-display text-[1.9rem] leading-tight font-medium text-parchment-50 [text-wrap:balance]">All good, enjoy your walk</h2>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-between px-6 py-[clamp(0.75rem,3dvh,1.5rem)] bg-night-950 text-parchment-100 select-none">
      <div className="pt-[clamp(0rem,3dvh,1.5rem)] text-center">
        <p className="text-[0.9375rem] tabular-nums text-lichen-400" aria-live="polite">
          {Number.isFinite(secondsLeft) ? `${secondsLeft}s` : ''}
        </p>
      </div>

      <div className="flex flex-col items-center justify-center my-auto w-full max-w-xs mx-auto">
        <h2 className="font-display text-2xl font-medium text-parchment-50 text-center mb-[clamp(0.75rem,3.5dvh,1.75rem)]">Enter your PIN to continue</h2>

        <div className={`flex gap-4 mb-[clamp(0.75rem,4dvh,2rem)] ${shake ? 'animate-shake' : ''}`} aria-label={`${pinDigits.length} of 4 digits entered`}>
          {[0, 1, 2, 3].map((idx) => (
            <div
              key={idx}
              className={`w-3.5 h-3.5 rounded-full transition-all duration-200 ${
                idx < pinDigits.length ? 'bg-parchment-100' : 'border-2 border-parchment-100/25'
              }`}
            />
          ))}
        </div>

        <div className="grid grid-cols-3 gap-[clamp(0.4rem,1.5dvh,0.75rem)] w-full">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((num) => (
            <button
              key={num}
              type="button"
              onClick={() => handleDigit(num)}
              disabled={isVerifying}
              aria-label={`digit ${num}`}
              className="h-[min(4rem,9.5dvh)] rounded-2xl bg-night-850 active:bg-night-700 text-[1.6rem] font-display text-parchment-50 flex items-center justify-center touch-manipulation"
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
            className="h-[min(4rem,9.5dvh)] rounded-2xl bg-night-850 active:bg-night-700 text-[1.6rem] font-display text-parchment-50 flex items-center justify-center touch-manipulation"
          >
            0
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={isVerifying}
            aria-label="delete digit"
            className="h-[min(4rem,9.5dvh)] rounded-2xl active:bg-night-850 text-lichen-400 flex items-center justify-center touch-manipulation"
          >
            <Delete className="w-6 h-6" />
          </button>
        </div>
      </div>

      <div className="pb-[clamp(0rem,3dvh,1.5rem)]" />
    </div>
  );
}
