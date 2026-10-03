import React, { useState } from 'react';
import FireflyCompanion from '../components/FireflyCompanion';
import ParticleCanvas from '../components/ParticleCanvas';
import { 
  ArrowRight, Sparkles, Compass, Heart, Shield, MessageCircleHeart, 
  Moon, Footprints, Stars, Wand2, MapPin, ChevronRight, ShieldCheck
} from 'lucide-react';

export default function WelcomeScreen({ onStartSetup, onStartDemo, hasProfile = false, onStartWalk, name, error }) {
  const [activeTab, setActiveTab] = useState(0);

  const featurePillars = [
    {
      id: 0,
      icon: <Compass className="w-4 h-4 text-gold-shimmer" />,
      title: "Luminous Route",
      badge: "Real-Time GPS",
      desc: "A glowing golden path that illuminates every crosswalk and turn to your door."
    },
    {
      id: 1,
      icon: <MessageCircleHeart className="w-4 h-4 text-pastel-rose" />,
      title: "Companion Chat",
      badge: "Voice Accompaniment",
      desc: "Cheery conversation on stars, lore, and news so you never walk in silence."
    },
    {
      id: 2,
      icon: <ShieldCheck className="w-4 h-4 text-pastel-mint" />,
      title: "Guardian Hearth",
      badge: "Discreet Safety",
      desc: "Silent duress PIN and acoustic distress detection keeping your people informed."
    }
  ];

  return (
    <div className="relative min-h-screen flex flex-col justify-between p-5 overflow-hidden select-none text-slate-100 bg-gradient-to-b from-[#1b1e4b] via-[#2a1b4e] via-[#1a2b48] to-[#122e28]">
      {/* Interactive 3D Particle Stardust Canvas (Responds to Touch & Mouse) */}
      <ParticleCanvas />

      {/* Luminous Celestial Aurora Glow at the Top (BRIGHT & INVITING - NOT BLACK!) */}
      <div 
        className="absolute top-0 left-0 right-0 h-96 pointer-events-none -z-0 opacity-70"
        style={{
          background: 'radial-gradient(ellipse at 50% -10%, rgba(168, 85, 247, 0.5) 0%, rgba(250, 204, 21, 0.28) 40%, rgba(34, 197, 94, 0.15) 65%, transparent 80%)'
        }}
      />

      {/* Ambient Celestial Glow Orbs in Midground */}
      <div className="absolute top-1/4 -left-12 w-48 h-48 rounded-full bg-mystic-600/25 blur-3xl pointer-events-none" />
      <div className="absolute top-1/2 -right-12 w-52 h-52 rounded-full bg-gold-400/20 blur-3xl pointer-events-none" />
      <div className="absolute bottom-1/4 left-1/3 w-40 h-40 rounded-full bg-emerald-500/20 blur-3xl pointer-events-none" />

      {/* Top Header & Friendly Badges (Dear Future Manager Style) */}
      <div className="pt-3 text-center z-10 animate-fade-in max-w-sm mx-auto w-full">
        {/* Glowing Pill Badge */}
        <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-mystic-900/80 border border-gold-400/35 shadow-card-shimmer text-gold-200 text-xs font-semibold tracking-wide mb-3 backdrop-blur-md">
          <Sparkles className="w-3.5 h-3.5 text-gold-400 animate-pulse" />
          <span>Your Friendly Night Companion</span>
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
        </div>

        {/* Ornate Mythical Display Title */}
        <h1 className="text-4xl md:text-5xl font-mythic font-black tracking-wide text-gold-metallic mb-1 drop-shadow-md">
          Firefly
        </h1>
        
        <p className="text-base font-cinzel tracking-wider text-pastel-lavender/90 font-medium">
          Walk home with a friend.
        </p>
      </div>

      {/* Central Interactive Mythical Spirit & Portal (Dear Future Manager Hero) */}
      <div className="my-auto py-3 flex flex-col items-center justify-center z-10 animate-fade-in max-w-sm mx-auto w-full">
        {/* Floating Luminous Portal */}
        <div className="relative p-6 rounded-full mythic-portal mb-3 flex items-center justify-center">
          {/* Concentric Decorative Rings */}
          <div className="absolute inset-1 rounded-full border border-gold-400/30 border-dashed animate-spin" style={{ animationDuration: '30s' }} />
          <div className="absolute -inset-2 rounded-full border border-mystic-400/20 pointer-events-none" />

          {/* The Mythical Firefly with Fluttering Fairy Wings & Orbiting Fae Motes */}
          <FireflyCompanion 
            isSpeaking={true} 
            size="lg" 
          />
        </div>

        {/* Warm & Friendly Speech Bubble from Firefly */}
        <div className="w-full px-4 py-3 rounded-2xl glass-mythic-card border border-gold-400/40 text-xs text-slate-100 shadow-mythic-glow mb-4">
          <div className="flex items-start gap-2.5">
            <span className="text-base">✨</span>
            <div className="flex-1">
              <p className="font-sans leading-relaxed text-slate-100">
                <strong className="text-gold-300 font-semibold">"Good evening{name ? `, ${name}` : ''}!</strong> Walking home? I'll keep you company, light your path, and quietly watch over you until you're at your door."
              </p>
              <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-pastel-mint font-semibold">
                <Stars className="w-3 h-3 text-gold-300" />
                <span>Tap me anytime for an interactive starlight spark</span>
              </div>
            </div>
          </div>
        </div>

        {/* Dear Future Manager Style Interactive Feature Cards */}
        <div className="w-full space-y-2">
          <div className="flex items-center justify-between px-1 text-[11px] font-semibold text-pastel-lavender">
            <span className="uppercase tracking-wider">How Firefly Guides You</span>
            <span className="text-gold-300 font-normal">3-part protection</span>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {featurePillars.map((pillar) => {
              const isSelected = activeTab === pillar.id;
              return (
                <button
                  key={pillar.id}
                  onClick={() => setActiveTab(pillar.id)}
                  className={`p-2.5 rounded-2xl text-left transition-all duration-200 flex flex-col justify-between border ${
                    isSelected
                      ? 'glass-mythic-card border-gold-400 shadow-firefly scale-[1.02]'
                      : 'glass-mythic-subtle border-white/10 hover:border-gold-400/30'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1.5">
                    {pillar.icon}
                    <span className="text-[9px] font-bold text-gold-300/80 px-1 py-0.5 rounded bg-mystic-900/60">
                      0{pillar.id + 1}
                    </span>
                  </div>
                  <div className="text-[11px] font-bold text-white leading-tight">
                    {pillar.title}
                  </div>
                  <div className="text-[9px] text-pastel-lavender/70 line-clamp-1 mt-0.5">
                    {pillar.badge}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Expanded Selected Feature Card Note */}
          <div className="p-3 rounded-2xl glass-mythic border border-white/15 text-xs text-slate-200 flex items-center justify-between">
            <p className="text-[11px] leading-relaxed text-slate-200">
              {featurePillars[activeTab].desc}
            </p>
          </div>
        </div>
      </div>

      {/* Bottom Shimmering Metallic Action Buttons (Dear Future Manager Style) */}
      <div className="pb-4 pt-2 flex flex-col gap-2.5 z-10 max-w-sm mx-auto w-full">
        {error && (
          <p className="text-xs text-gold-200 text-center" role="alert">
            Couldn't start the walk: {error}
          </p>
        )}
        {hasProfile && name && <p className="text-xs text-pastel-lavender text-center">Ready when you are, {name}.</p>}
        {hasProfile ? (
          <button
            onClick={onStartWalk}
            className="w-full py-4 px-6 rounded-2xl btn-gold-metallic font-bold text-base flex items-center justify-center gap-3 active:scale-[0.98] transition-all"
          >
            <Footprints className="w-5 h-5 stroke-[2.5]" />
            <span className="font-extrabold tracking-wide uppercase text-sm">Walk with me</span>
            <ArrowRight className="w-5 h-5 ml-auto stroke-[2.5]" />
          </button>
        ) : null}

        <button
          onClick={onStartSetup}
          className={`w-full py-4 px-6 rounded-2xl font-bold text-sm flex items-center justify-center gap-3 transition-all active:scale-[0.98] ${
            hasProfile
              ? 'glass-mythic text-slate-100 hover:bg-mystic-800/80 border border-gold-400/30'
              : 'btn-gold-metallic font-extrabold uppercase tracking-wide'
          }`}
        >
          <span>{hasProfile ? 'Edit my setup' : 'Set up (2 minutes)'}</span>
          <ArrowRight className="w-5 h-5 ml-auto stroke-[2.5]" />
        </button>

        <button
          onClick={onStartDemo}
          className="w-full py-3 px-6 rounded-2xl glass-mythic-subtle text-slate-200 font-semibold text-xs hover:text-white hover:bg-twilight-800/60 active:scale-[0.98] transition-all flex items-center justify-center gap-2 border border-gold-400/25"
        >
          <Sparkles className="w-3.5 h-3.5 text-gold-400" />
          <span>{hasProfile ? 'Demo mode (no network)' : 'Try the demo'}</span>
        </button>
      </div>
    </div>
  );
}
