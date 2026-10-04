import React, { useState } from 'react';
import { Share2, Check } from 'lucide-react';
import GroveScene from '../components/GroveScene';
import FireflyCompanion from '../components/FireflyCompanion';
import ParticleCanvas from '../components/ParticleCanvas';
import { formatDistance } from '../services/units';

export default function HomeScreen({
  summary = { duration_seconds: 660, distance_meters: 850 },
  contacts = [],
  onReset
}) {
  const [copied, setCopied] = useState(false);

  const minutes = Math.max(1, Math.round((summary?.duration_seconds || 660) / 60));
  const dist = formatDistance(summary?.distance_meters || 850);
  const shareText = `Walked home with Firefly tonight: ${dist.value} ${dist.unit}, ${minutes} min.`;

  const handleShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Home with Firefly',
          text: shareText,
          url: window.location.origin
        });
        return;
      } catch (e) {}
    }

    try {
      await navigator.clipboard.writeText(shareText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch (e) {}
  };

  const names = contacts.map((c) => c.name).filter(Boolean);
  const who = names.length === 0 ? 'Your people' : names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

  return (
    <div className="relative min-h-[100dvh] flex flex-col night-sky select-none overflow-hidden">
      <ParticleCanvas count={10} />

      <main className="relative z-10 flex-1 px-6 pt-[max(3rem,env(safe-area-inset-top))] max-w-md w-full mx-auto">
        <p className="text-[15px] text-lichen-300 animate-rise-in">{minutes} min · {dist.value} {dist.unit}</p>
        <div className="mt-2 flex items-start justify-between gap-2">
          <h1 className="font-display text-[2.8rem] leading-[1.02] font-medium text-parchment-50 animate-rise-in" style={{ animationDelay: '60ms' }}>
            You're home.
          </h1>
          <div className="-mt-3 shrink-0"><FireflyCompanion size="sm" /></div>
        </div>
        <p className="mt-4 text-[17px] leading-relaxed text-lichen-200 animate-rise-in" style={{ animationDelay: '120ms' }}>
          {who} got a text saying you made it. Thanks for letting me walk with you.
        </p>
      </main>

      <div className="relative mt-8 pointer-events-none">
        <GroveScene litWindow className="h-[clamp(110px,24dvh,210px)] block" />
      </div>
      <footer className="relative z-10 bg-[#0b1510] px-6 pt-1 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <div className="max-w-md mx-auto flex gap-3">
          <button onClick={handleShare} className="btn-quiet h-14 px-5 rounded-2xl text-[15px] font-bold flex items-center gap-2">
            {copied ? <Check className="w-4 h-4" /> : <Share2 className="w-4 h-4" />}
            {copied ? 'Copied' : 'Share'}
          </button>
          <button onClick={onReset} className="btn-lantern flex-1 h-14 rounded-2xl text-[17px] font-bold">
            Goodnight
          </button>
        </div>
      </footer>
    </div>
  );
}
