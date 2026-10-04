import React from 'react';

/**
 * The firefly: a small round bug with a lantern tail. It drifts lazily and its tail glows
 * brightly only while it's speaking (A5); otherwise it smoulders. What it says appears in a
 * parchment note above it, so its words look different from the app's own text.
 */
export default function FireflyCompanion({ isSpeaking = false, message = null, size = 'md', onClick = null, friendlyNote = null }) {
  const px = { sm: '2.75rem', md: '4.5rem', lg: '7rem' }[size] ?? '4.5rem';

  return (
    <div className="relative flex flex-col items-end select-none">
      {message && (
        <div className="note relative mb-3 max-w-[17rem] rounded-2xl rounded-br-md px-3.5 py-2.5 text-[0.9375rem] leading-snug animate-rise-in" aria-live="polite">
          <p>{message}</p>
          {friendlyNote && <p className="mt-1 font-display italic text-xs text-night-600">{friendlyNote}</p>}
          <svg className="absolute -bottom-2 right-5" width="14" height="10" viewBox="0 0 14 10" aria-hidden="true">
            <path d="M0 0 H14 L10 9 Q9 10 8 9 Z" fill="#f3ead5" />
          </svg>
        </div>
      )}

      <button
        type="button"
        onClick={onClick ?? undefined}
        tabIndex={onClick ? 0 : -1}
        aria-label={isSpeaking ? 'Firefly (talking)' : 'Firefly'}
        className="relative animate-bob cursor-default"
        style={{ width: px, height: px }}
      >
        {/* the glow belongs to the tail, so it sits low and to the back */}
        <span
          className={`absolute rounded-full transition-all duration-500 ${isSpeaking ? 'opacity-100 animate-breathe' : 'opacity-40'}`}
          style={{
            left: '18%', top: '38%', width: '64%', height: '64%',
            background: 'radial-gradient(circle, rgba(255,214,120,0.75) 0%, rgba(255,214,120,0.25) 40%, rgba(255,214,120,0) 70%)',
            transform: isSpeaking ? 'scale(1.35)' : 'scale(1)',
          }}
        />
        <svg viewBox="0 0 100 100" className="relative w-full h-full overflow-visible" aria-hidden="true">
          {/* wings: two thin, slightly uneven ovals */}
          <g style={{ transformOrigin: '47px 44px' }} className="animate-wing-l">
            <path d="M47 44 C30 26 14 30 18 42 C21 51 38 50 47 44Z" fill="rgba(226,236,222,0.32)" stroke="rgba(239,230,208,0.55)" strokeWidth="1" />
          </g>
          <g style={{ transformOrigin: '53px 44px' }} className="animate-wing-r">
            <path d="M53 44 C71 25 88 31 83 43 C79 52 62 50 53 44Z" fill="rgba(226,236,222,0.28)" stroke="rgba(239,230,208,0.5)" strokeWidth="1" />
          </g>
          {/* tail (the lantern) */}
          <ellipse cx="50" cy="66" rx="13" ry="15" fill={isSpeaking ? '#ffe2a0' : '#e8b862'} />
          <ellipse cx="49" cy="69" rx="7" ry="8" fill={isSpeaking ? '#fffaf0' : '#f6d796'} opacity="0.9" />
          {/* body + head */}
          <path d="M38 52 C38 44 62 44 62 52 C62 57 38 57 38 52Z" fill="#1c2a22" />
          <circle cx="50" cy="40" r="8.5" fill="#22322a" />
          <circle cx="46.5" cy="39" r="1.6" fill="#efe6d0" />
          <circle cx="53.5" cy="39" r="1.6" fill="#efe6d0" />
          {/* antennae: one curls a little more than the other */}
          <path d="M46 33 C42 24 36 21 31 23" stroke="#22322a" strokeWidth="2" strokeLinecap="round" fill="none" />
          <path d="M54 33 C57 25 63 20 69 22" stroke="#22322a" strokeWidth="2" strokeLinecap="round" fill="none" />
          {/* legs */}
          <path d="M42 56 l-4 6 M50 57 l0 6 M58 56 l4 6" stroke="#1c2a22" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
