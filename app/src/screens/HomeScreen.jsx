import React, { useState } from 'react';
import { Home, Share2, Check, Clock, Navigation, Heart, Sparkles, Moon, Footprints } from 'lucide-react';

export default function HomeScreen({
  summary = { duration_seconds: 660, distance_meters: 850 },
  contacts = [],
  onReset
}) {
  const [copied, setCopied] = useState(false);

  const minutes = Math.max(1, Math.round((summary?.duration_seconds || 660) / 60));
  const distanceKm = ((summary?.distance_meters || 850) / 1000).toFixed(1);
  const shareText = `Walked home with Firefly: ${distanceKm} km, ${minutes} min 🌙✨`;

  const handleShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Safe Home with Firefly',
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

  return (
    <div className="min-h-screen flex flex-col justify-between p-5 bg-gradient-to-b from-[#1b1e4b] via-[#241744] to-[#142d25] text-slate-100 select-none">
      {/* Top Reassuring Hearth Banner */}
      <div className="pt-6 text-center animate-fade-in">
        <div className="w-20 h-20 mx-auto rounded-full bg-gradient-to-tr from-amber-500 via-gold-400 to-mystic-400 p-1 shadow-firefly-lg mb-3 flex items-center justify-center">
          <div className="w-full h-full rounded-full bg-twilight-950 flex items-center justify-center">
            <Home className="w-9 h-9 text-gold-300 stroke-[2]" />
          </div>
        </div>
        <h1 className="text-3xl font-mythic font-bold text-gold-metallic tracking-wide mb-1.5">
          You're home.
        </h1>
        <p className="text-sm font-cinzel text-pastel-lavender/90 max-w-xs mx-auto">
          Your contacts know you're safe.
        </p>
      </div>

      {/* Walk Summary Card (Dear Future Manager Style) */}
      <div className="my-auto max-w-sm mx-auto w-full space-y-3.5 animate-fade-in">
        {/* Telemetry Stats Grid */}
        <div className="p-5 rounded-3xl glass-mythic-card grid grid-cols-2 gap-4 divide-x divide-white/15 border border-gold-400/30">
          <div className="flex flex-col items-center justify-center text-center">
            <div className="flex items-center gap-1.5 text-[10px] uppercase font-bold text-pastel-lavender mb-1">
              <Clock className="w-3.5 h-3.5 text-gold-400" />
              <span>Walk Time</span>
            </div>
            <div className="text-3xl font-cinzel font-bold text-white tracking-tight">
              {minutes} <span className="text-sm font-sans font-normal text-pastel-lavender">min</span>
            </div>
          </div>

          <div className="flex flex-col items-center justify-center text-center pl-4">
            <div className="flex items-center gap-1.5 text-[10px] uppercase font-bold text-pastel-lavender mb-1">
              <Navigation className="w-3.5 h-3.5 text-gold-400" />
              <span>Distance</span>
            </div>
            <div className="text-3xl font-cinzel font-bold text-white tracking-tight">
              {distanceKm} <span className="text-sm font-sans font-normal text-pastel-lavender">km</span>
            </div>
          </div>
        </div>

        {/* Guardians Safe Arrival Confirmation Widget */}
        <div className="p-4 rounded-2xl glass-mythic flex items-center gap-3.5 border border-emerald-400/30">
          <div className="w-10 h-10 rounded-xl bg-emerald-950/80 border border-emerald-400/40 flex items-center justify-center shrink-0">
            <Heart className="w-5 h-5 text-emerald-300 fill-emerald-400/20" />
          </div>
          <div className="text-left text-xs">
            <p className="font-semibold text-white">
              Home safe
            </p>
            <p className="text-slate-300">
              {contacts.length > 0
                ? `${contacts.map(c => c.name).join(', ')} got your "home safe" text`
                : 'Your contacts got your "home safe" text'}
            </p>
          </div>
        </div>

        {/* Share Card Widget */}
        <div className="p-4 rounded-2xl glass-mythic-card border border-gold-400/25 flex items-center justify-between shadow-sm">
          <div className="text-left">
            <span className="text-[10px] uppercase tracking-wider text-gold-300 font-bold block mb-0.5">
              Firefly Journey Card
            </span>
            <span className="text-xs text-slate-200">
              "{distanceKm} km under the stars in {minutes} min"
            </span>
          </div>
          <button
            onClick={handleShare}
            className="p-2.5 rounded-xl bg-mystic-800 text-gold-300 hover:text-white hover:bg-mystic-700 transition-all flex items-center gap-1.5 text-xs font-semibold border border-gold-400/30"
          >
            {copied ? <Check className="w-4 h-4 text-emerald-300" /> : <Share2 className="w-4 h-4" />}
            <span>{copied ? 'Copied' : 'Share'}</span>
          </button>
        </div>
      </div>

      {/* Done Button in Shimmering Gold */}
      <div className="pb-5 max-w-sm mx-auto w-full">
        <button
          onClick={onReset}
          className="w-full py-4 px-6 rounded-2xl btn-gold-metallic font-extrabold text-sm uppercase tracking-wide flex items-center justify-center gap-2 active:scale-[0.98] transition-all"
        >
          <span>Done</span>
        </button>
      </div>
    </div>
  );
}
