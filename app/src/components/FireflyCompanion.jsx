import React, { useState } from 'react';
import { Sparkles, Heart } from 'lucide-react';

/**
 * Mythical Forest Spirit (Firefly Companion)
 * Features:
 * - 4-winged ethereal fairy flutter with luminous filament veins
 * - Celestial starlight bioluminescent heart that breathes and glows
 * - 3 orbiting stardust fae motes circling in mystical orbits
 * - Radiant starlight shockwaves when speaking (Criterion A5)
 * - Friendly interactive click with whimsical sparkle burst
 */
export default function FireflyCompanion({
  isSpeaking = false,
  message = null,
  size = 'md', // 'sm' | 'md' | 'lg'
  onClick = null,
  friendlyNote = null
}) {
  const [sparkleActive, setSparkleActive] = useState(false);

  const sizeClasses = {
    sm: 'w-12 h-12',
    md: 'w-20 h-20',
    lg: 'w-28 h-28'
  }[size] || 'w-20 h-20';

  const handleClick = (e) => {
    setSparkleActive(true);
    setTimeout(() => setSparkleActive(false), 900);
    if (onClick) onClick(e);
  };

  return (
    <div className="relative flex flex-col items-center select-none">
      {/* Friendly Mythical Speech Bubble */}
      {message && (
        <div className="mb-4 max-w-xs px-4 py-3 rounded-2xl glass-grove text-xs sm:text-sm text-sage-100 font-medium shadow-mythic-halo border border-moss-400/35 animate-fade-in flex items-start gap-2.5 backdrop-blur-md">
          <div className="w-5 h-5 rounded-full bg-firefly-400/20 flex items-center justify-center shrink-0 mt-0.5">
            <Sparkles className="w-3.5 h-3.5 text-firefly-300 animate-pulse" />
          </div>
          <div className="flex-1">
            <p className="leading-snug text-left text-sage-50">{message}</p>
            {friendlyNote && (
              <span className="block mt-1 text-[11px] text-moss-300 font-whimsical italic">
                {friendlyNote}
              </span>
            )}
          </div>
        </div>
      )}

      {/* The Mythical Firefly Entity */}
      <div 
        onClick={handleClick}
        className={`relative ${sizeClasses} cursor-pointer transition-all duration-300 flex items-center justify-center group`}
        title="Tap the forest spirit!"
      >
        {/* Active Speaking Radiant Shockwave Aura */}
        {isSpeaking && (
          <>
            <div className="absolute inset-0 rounded-full bg-firefly-300/35 blur-xl animate-ping opacity-90 scale-150" />
            <div className="absolute -inset-4 rounded-full bg-moss-400/25 blur-2xl animate-pulse scale-125" />
          </>
        )}

        {/* Ambient Bioluminescent Halo (Subdued Green + Golden Core) */}
        <div 
          className={`absolute inset-0 rounded-full transition-all duration-500 ${
            isSpeaking 
              ? 'bg-gradient-to-r from-firefly-300 via-amber-lantern to-moss-400 blur-lg opacity-90 scale-125 shadow-firefly-lg' 
              : 'bg-gradient-to-tr from-moss-500/30 via-firefly-400/25 to-sage-200/20 blur-md opacity-60 scale-100 group-hover:scale-110'
          }`} 
        />

        {/* Orbiting Stardust Fae Motes (Orbit 1) */}
        <div className="absolute w-full h-full pointer-events-none animate-orbit-1 flex items-center justify-center">
          <div className="w-2 h-2 rounded-full bg-gradient-to-r from-white to-firefly-300 shadow-firefly blur-[0.5px]" />
        </div>

        {/* Orbiting Stardust Fae Motes (Orbit 2) */}
        <div className="absolute w-full h-full pointer-events-none animate-orbit-2 flex items-center justify-center">
          <div className="w-1.5 h-1.5 rounded-full bg-gradient-to-r from-sage-100 to-moss-300 shadow-grove-glow blur-[0.5px]" />
        </div>

        {/* Orbiting Stardust Fae Motes (Orbit 3) */}
        <div className="absolute w-full h-full pointer-events-none animate-orbit-3 flex items-center justify-center">
          <div className="w-1.5 h-1.5 rounded-full bg-firefly-200 shadow-firefly blur-[0.5px]" />
        </div>

        {/* Sparkle burst on tap */}
        {sparkleActive && (
          <div className="absolute -inset-6 rounded-full border border-firefly-300/60 animate-ping pointer-events-none" />
        )}

        {/* Mythical Spirit Body & 4 Fairy Wings (SVG) */}
        <div className={`relative z-10 w-full h-full flex items-center justify-center animate-mythic-float ${isSpeaking ? 'scale-110' : ''}`}>
          <svg viewBox="0 0 120 120" className="w-full h-full overflow-visible drop-shadow-lg">
            <defs>
              {/* Ethereal Heart Gradient */}
              <radialGradient id="mythicHeartGrad" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="#ffffff" />
                <stop offset="25%" stopColor="#fff8ce" />
                <stop offset="55%" stopColor="#f5d365" />
                <stop offset="85%" stopColor="#e09f3e" />
                <stop offset="100%" stopColor="#2b5f42" />
              </radialGradient>

              {/* Primary Fairy Wing Gradient */}
              <linearGradient id="fairyWingPrimary" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="rgba(255, 255, 255, 0.9)" />
                <stop offset="40%" stopColor="rgba(223, 235, 227, 0.65)" />
                <stop offset="75%" stopColor="rgba(117, 190, 146, 0.4)" />
                <stop offset="100%" stopColor="rgba(242, 204, 87, 0.2)" />
              </linearGradient>

              {/* Secondary Lower Wing Gradient */}
              <linearGradient id="fairyWingSecondary" x1="100%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor="rgba(255, 255, 255, 0.8)" />
                <stop offset="50%" stopColor="rgba(163, 212, 183, 0.45)" />
                <stop offset="100%" stopColor="rgba(224, 159, 62, 0.15)" />
              </linearGradient>

              {/* Soft Stardust Filter */}
              <filter id="fairyGlow" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="1.5" result="blur" />
                <feComposite in="SourceGraphic" in2="blur" operator="over" />
              </filter>
            </defs>

            {/* --- WINGS GROUP --- */}
            {/* Upper Left Primary Fairy Wing */}
            <g className="origin-[54px_58px] animate-fae-flutter-l">
              <path
                d="M 54 58 C 24 18, 6 32, 28 66 C 38 78, 52 68, 54 58 Z"
                fill="url(#fairyWingPrimary)"
                stroke="rgba(255, 255, 255, 0.65)"
                strokeWidth="0.7"
              />
              {/* Luminous Wing Veins */}
              <path d="M 54 58 Q 36 44 26 38" stroke="rgba(255, 255, 255, 0.55)" strokeWidth="0.6" fill="none" />
              <path d="M 43 50 Q 32 58 29 65" stroke="rgba(242, 204, 87, 0.45)" strokeWidth="0.5" fill="none" />
            </g>

            {/* Upper Right Primary Fairy Wing */}
            <g className="origin-[66px_58px] animate-fae-flutter-r">
              <path
                d="M 66 58 C 96 18, 114 32, 92 66 C 82 78, 68 68, 66 58 Z"
                fill="url(#fairyWingPrimary)"
                stroke="rgba(255, 255, 255, 0.65)"
                strokeWidth="0.7"
              />
              {/* Luminous Wing Veins */}
              <path d="M 66 58 Q 84 44 94 38" stroke="rgba(255, 255, 255, 0.55)" strokeWidth="0.6" fill="none" />
              <path d="M 77 50 Q 88 58 91 65" stroke="rgba(242, 204, 87, 0.45)" strokeWidth="0.5" fill="none" />
            </g>

            {/* Lower Left Secondary Wing */}
            <g className="origin-[56px_66px] animate-fae-flutter-l" style={{ animationDelay: '0.08s' }}>
              <path
                d="M 56 66 C 36 72, 24 88, 38 98 C 48 104, 56 82, 56 66 Z"
                fill="url(#fairyWingSecondary)"
                stroke="rgba(163, 212, 183, 0.5)"
                strokeWidth="0.6"
              />
            </g>

            {/* Lower Right Secondary Wing */}
            <g className="origin-[64px_66px] animate-fae-flutter-r" style={{ animationDelay: '0.08s' }}>
              <path
                d="M 64 66 C 84 72, 96 88, 82 98 C 72 104, 64 82, 64 66 Z"
                fill="url(#fairyWingSecondary)"
                stroke="rgba(163, 212, 183, 0.5)"
                strokeWidth="0.6"
              />
            </g>

            {/* --- FAIRY DUST SPARKS TRAIL --- */}
            <g opacity="0.75">
              <circle cx="60" cy="98" r="1.8" fill="#f5d365" className="animate-pulse" />
              <circle cx="54" cy="106" r="1.3" fill="#a3d4b7" className="animate-pulse" style={{ animationDelay: '0.4s' }} />
              <circle cx="65" cy="112" r="1.0" fill="#ffffff" className="animate-pulse" style={{ animationDelay: '0.8s' }} />
            </g>

            {/* --- MYTHICAL BIOLUMINESCENT ABDOMEN (The Spirit Heart) --- */}
            <ellipse
              cx="60"
              cy="68"
              rx={isSpeaking ? "18" : "15"}
              ry={isSpeaking ? "22" : "19"}
              fill="url(#mythicHeartGrad)"
              className="transition-all duration-300"
              filter="url(#fairyGlow)"
            />

            {/* Inner Radiant Starlight Core */}
            <ellipse
              cx="60"
              cy="67"
              rx="7"
              ry="9"
              fill="#ffffff"
              opacity="0.9"
            />

            {/* Little Forest Sprite Head */}
            <ellipse cx="60" cy="46" rx="7.5" ry="6.5" fill="#123321" stroke="#3c7955" strokeWidth="1" />

            {/* Mythical Crown Antennae with Starlight Gems */}
            <path d="M 57 41 Q 48 27 38 26" stroke="#f5d365" strokeWidth="1.6" strokeLinecap="round" fill="none" opacity="0.9" />
            <path d="M 63 41 Q 72 27 82 26" stroke="#f5d365" strokeWidth="1.6" strokeLinecap="round" fill="none" opacity="0.9" />

            {/* Glowing Celestial Crystals at Antenna Tips */}
            <circle cx="38" cy="26" r="2.2" fill="#ffffff" stroke="#f2cc57" strokeWidth="0.8" />
            <circle cx="82" cy="26" r="2.2" fill="#ffffff" stroke="#f2cc57" strokeWidth="0.8" />
          </svg>
        </div>
      </div>
    </div>
  );
}
