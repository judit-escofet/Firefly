import React from 'react';
import FireflyCompanion from '../components/FireflyCompanion';
import ParticleCanvas from '../components/ParticleCanvas';
import GroveScene from '../components/GroveScene';

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Still up';
  if (h < 12) return 'Morning';
  if (h < 18) return 'Afternoon';
  return 'Evening';
}

// The wordmark: lowercase, with the dot of the i as a small glowing firefly.
export function Wordmark({ className = '' }) {
  return (
    <span className={`font-display font-semibold tracking-tight text-parchment-100 ${className}`}>
      f<span className="relative inline-block ml-[0.06em]">ı<span className="absolute left-1/2 -translate-x-1/2 top-[0.3em] w-[0.19em] h-[0.19em] rounded-full bg-lantern-300 shadow-firefly" /></span>refly
    </span>
  );
}

export default function WelcomeScreen({ onStartSetup, onStartDemo, hasProfile = false, onStartWalk, name, contacts = [], error }) {
  const people = contacts.map((c) => c.name).filter(Boolean);
  return (
    <div className="relative h-[100dvh] flex flex-col overflow-hidden night-sky select-none">
      <ParticleCanvas />

      <header className="relative z-10 shrink-0 px-6 pt-[max(1.25rem,env(safe-area-inset-top))] flex items-center justify-between max-w-md w-full mx-auto">
        <Wordmark className="text-2xl" />
      </header>

      <main className="relative z-10 shrink-0 flex flex-col px-6 max-w-md w-full mx-auto">
        <div className="mt-[clamp(0.75rem,6dvh,4rem)] flex items-start justify-between gap-2">
          <h1 className="font-display text-[2.6rem] short:text-[2.3rem] leading-[1.02] font-medium text-parchment-50 animate-rise-in">
            {hasProfile && name ? (
              <>{greeting()},<br />{name}.</>
            ) : (
              <>Walking home<br /><em className="font-light">tonight?</em></>
            )}
          </h1>
          <div className="-mt-2 mr-1 shrink-0">
            <FireflyCompanion size="md" isSpeaking={false} />
          </div>
        </div>

        <p className="mt-[clamp(0.5rem,2.5dvh,1.5rem)] text-[1.0625rem] leading-relaxed text-lichen-200 max-w-[22rem] animate-rise-in" style={{ animationDelay: '80ms' }}>
          {hasProfile
            ? "Tell me where you're headed and I'll walk with you. We can chat, or not. I'm listening either way."
            : "I'll keep you company on the way: a bit of chat, the way home lit up, and help that comes quietly if you ever need it."}
        </p>

        {hasProfile && people.length > 0 && (
          <p className="mt-[clamp(0.75rem,3dvh,2rem)] flex gap-3 text-[0.9375rem] text-lichen-300 animate-rise-in" style={{ animationDelay: '160ms' }}>
            <Dot />
            <span>{people.length === 1 ? people[0] : `${people.slice(0, -1).join(', ')} and ${people[people.length - 1]}`} will know if you need help.</span>
          </p>
        )}

        {!hasProfile && (
          <ul className="mt-[clamp(0.75rem,3dvh,2rem)] space-y-[clamp(0.25rem,1dvh,0.75rem)] tiny:hidden text-[0.9375rem] text-lichen-300 animate-rise-in" style={{ animationDelay: '160ms' }}>
            <li className="flex gap-3"><Dot />Say your code phrase and I'll start a quiet countdown.</li>
            <li className="flex gap-3"><Dot />If you don't stop it, your people get your location.</li>
            <li className="flex gap-3"><Dot />Your PIN stops it. Any other code still sends help, quietly.</li>
          </ul>
        )}
      </main>

      {/* The trees, then the buttons standing on the ground below them. */}
      {/* The trees take whatever height is left (none at all on a very short screen), then the
          buttons stand on the ground below them. */}
      <div className="relative flex-1 min-h-0 mt-2 flex items-end pointer-events-none tiny:invisible">
        <GroveScene className="w-full h-full max-h-[14rem]" />
      </div>
      <footer className="relative z-10 shrink-0 bg-[#0b1510] tiny:bg-transparent px-6 pt-1 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
        <div className="max-w-md mx-auto">
        {error && (
          <p className="mb-3 text-sm text-ember-400" role="alert">
            Couldn't start the walk: {error}
          </p>
        )}
        {hasProfile ? (
          <>
            <button onClick={onStartWalk} className="btn-lantern w-full h-14 rounded-2xl text-[1.0625rem] font-bold">
              Walk with me
            </button>
            <div className="mt-3 flex items-center justify-between text-[0.9375rem]">
              <button onClick={onStartSetup} className="py-2 text-parchment-100 underline decoration-parchment-100/30 underline-offset-4 hover:decoration-parchment-100">
                Edit my setup
              </button>
              <button onClick={onStartDemo} className="py-2 text-lichen-300 hover:text-parchment-100">
                Demo mode
              </button>
            </div>
          </>
        ) : (
          <>
            <button onClick={onStartSetup} className="btn-lantern w-full h-14 rounded-2xl text-[1.0625rem] font-bold">
              Set me up <span className="font-normal opacity-70">· 2 min</span>
            </button>
            <button onClick={onStartDemo} className="mt-2 w-full py-3 text-[0.9375rem] text-parchment-100 underline decoration-parchment-100/30 underline-offset-4 hover:decoration-parchment-100">
              Just show me how it works
            </button>
          </>
        )}
        </div>
      </footer>
    </div>
  );
}

function Dot() {
  return <span aria-hidden="true" className="mt-[0.55em] w-1.5 h-1.5 shrink-0 rounded-full bg-lantern-400 shadow-firefly" />;
}
