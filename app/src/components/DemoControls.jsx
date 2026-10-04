import React, { useState, useEffect } from 'react';
import { bus } from '../bus';
import { locationService } from '../services/location';
import { isMockModeEnabled, setMockMode } from '../services/mockData';
import { Terminal, FastForward, ShieldAlert, Sparkles, ChevronUp, ChevronDown, Home, Trees, PauseCircle, Shuffle, Mic, AudioLines } from 'lucide-react';

/**
 * Presenter / checkpoint drawer. Everything here goes through the real modules: "Scream" and
 * "Code phrase" feed the Guardian (P2), which runs the actual countdown; "Stop here" and
 * "Wander off" make the simulated walker trigger real check-ins; "Walk with test audio" plays a
 * recorded voice through the mic pipeline so the companion (P1) and Guardian hear it.
 * Includes the live event-bus inspector (A11).
 */
export default function DemoControls({ activeScreen, canWalk, onWalkWithTestAudio }) {
  const [isOpen, setIsOpen] = useState(false);
  const [isMock] = useState(isMockModeEnabled());
  const [events, setEvents] = useState(() => bus.getHistory().slice(-50).reverse());
  const [showEventLog, setShowEventLog] = useState(false);
  const [sim, setSim] = useState({ mock: false, paused: false, wander: false });

  useEffect(() => {
    const offs = [
      bus.on('*', (event) => {
        if (event.type !== 'guardian.score') setEvents((prev) => [event, ...prev].slice(0, 80));
      }),
      locationService.subscribe(setSim),
    ];
    return () => offs.forEach((o) => o());
  }, []);

  const walking = activeScreen === 'walk';
  const say = (text) => {
    bus.emit('speech.heard', { text, final: false });
    setTimeout(() => bus.emit('speech.heard', { text, final: true }), 200);
  };
  const codePhrase = () => {
    try {
      return localStorage.getItem('firefly.code_phrase') || 'i think i left the oven on';
    } catch {
      return 'i think i left the oven on';
    }
  };

  const Btn = ({ onClick, icon, children, kbd, tone = 'normal', disabled = false, active = false }) => (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`w-full py-2 px-3 rounded-xl flex items-center justify-between font-medium border transition-colors disabled:opacity-40 ${
        tone === 'warn'
          ? 'bg-red-950/40 hover:bg-red-950/60 border-red-500/30 text-red-200'
          : active
            ? 'bg-firefly-400/20 border-firefly-400/50 text-firefly-200'
            : 'bg-grove-800/80 hover:bg-grove-700/80 border-moss-500/20 text-sage-100'
      }`}
    >
      <span className="flex items-center gap-2">
        {icon}
        <span>{children}</span>
      </span>
      {kbd && <kbd className="px-1.5 py-0.5 rounded bg-grove-950 text-[10px] font-mono text-sage-300">{kbd}</kbd>}
    </button>
  );

  if (activeScreen === 'setup' || activeScreen === 'starting') return null;
  // On the walk screen the pill sits under the ETA card instead of over it.
  const pillPos = walking ? 'top-[8.5rem] right-4' : 'top-3 right-3';
  const drawerPos = walking ? 'top-[11rem] right-3' : 'top-12 right-3';

  return (
    <>
      <div className={`fixed ${pillPos} z-40`}>
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-grove-900/90 hover:bg-grove-800 border border-moss-400/40 text-sage-200 text-xs font-medium shadow-grove-glow backdrop-blur-md active:scale-95 transition-all"
          aria-expanded={isOpen}
        >
          <Terminal className="w-3.5 h-3.5 text-lichen-300" />
          <span>Demo{isMock ? ' (mock)' : ''}</span>
          {isOpen ? <ChevronUp className="w-3.5 h-3.5 text-sage-300" /> : <ChevronDown className="w-3.5 h-3.5 text-sage-300" />}
        </button>
      </div>

      {isOpen && (
        <div className={`fixed ${drawerPos} z-40 w-80 max-w-[calc(100vw-24px)] max-h-[80vh] overflow-y-auto rounded-3xl glass-grove p-4 shadow-2xl text-sage-100 space-y-3 animate-fade-in text-xs`}>
          <div className="flex items-center justify-between border-b border-grove-800 pb-2">
            <span className="font-whimsical font-bold uppercase tracking-wider text-firefly-300 flex items-center gap-1.5">
              <Trees className="w-4 h-4 text-moss-400" />
              <span>Presenter tools</span>
            </span>
            <button onClick={() => setShowEventLog(!showEventLog)} className="px-2 py-0.5 rounded-md bg-grove-800 text-sage-200 font-mono hover:bg-grove-700">
              Bus log ({events.length})
            </button>
          </div>

          <div className="flex items-center justify-between p-2 rounded-xl bg-grove-950/70 border border-moss-500/20">
            <span className="font-medium text-sage-200">Mock mode (no network)</span>
            <button
              onClick={() => {
                setMockMode(!isMock);
                window.location.reload();
              }}
              className={`px-3 py-1 rounded-full font-bold text-[11px] transition-all ${isMock ? 'bg-firefly-400 text-grove-950' : 'bg-grove-800 text-sage-300'}`}
            >
              {isMock ? 'On' : 'Off'}
            </button>
          </div>

          <div className="space-y-1.5">
            <div className="text-[10px] text-sage-400 font-semibold uppercase tracking-wider">Start</div>
            <Btn onClick={onWalkWithTestAudio} disabled={!canWalk} icon={<AudioLines className="w-3.5 h-3.5 text-firefly-400" />}>
              Walk with test audio (no mic)
            </Btn>
          </div>

          <div className="space-y-1.5">
            <div className="text-[10px] text-sage-400 font-semibold uppercase tracking-wider">During the walk {sim.mock ? '' : '(simulated walk only)'}</div>
            <Btn onClick={() => locationService.jumpAhead()} disabled={!sim.mock} kbd="J" icon={<FastForward className="w-3.5 h-3.5 text-firefly-400" />}>
              Jump ahead
            </Btn>
            <Btn onClick={() => locationService.jumpToHome()} disabled={!sim.mock} icon={<Home className="w-3.5 h-3.5 text-amber-lantern" />}>
              Arrive home
            </Btn>
            <Btn onClick={() => locationService.togglePause()} disabled={!sim.mock} active={sim.paused} icon={<PauseCircle className="w-3.5 h-3.5 text-firefly-400" />}>
              {sim.paused ? 'Keep walking' : 'Stop here (check-in after 90 s)'}
            </Btn>
            <Btn onClick={() => locationService.toggleWander()} disabled={!sim.mock} active={sim.wander} icon={<Shuffle className="w-3.5 h-3.5 text-firefly-400" />}>
              {sim.wander ? 'Back on route' : 'Wander off (check-in after 30 s)'}
            </Btn>
            <Btn onClick={() => say(codePhrase())} disabled={!walking} icon={<Mic className="w-3.5 h-3.5 text-firefly-400" />}>
              Say the code phrase
            </Btn>
            <Btn
              tone="warn"
              disabled={!walking}
              onClick={() => bus.emit('danger.signal', { source: 'scream', confidence: 0.91, detail: 'demo button' })}
              icon={<ShieldAlert className="w-3.5 h-3.5 text-red-400" />}
            >
              Scream detected
            </Btn>
          </div>
        </div>
      )}

      {showEventLog && (
        <div className="fixed inset-4 z-50 rounded-3xl glass-grove p-5 max-w-lg mx-auto flex flex-col shadow-2xl">
          <div className="flex items-center justify-between pb-3 border-b border-grove-800">
            <div className="flex items-center gap-2 text-firefly-300 font-bold">
              <Terminal className="w-5 h-5 text-moss-400" />
              <span className="text-sm font-whimsical">Event bus</span>
            </div>
            <button onClick={() => setShowEventLog(false)} className="text-xs px-2.5 py-1 rounded-lg bg-grove-800 text-sage-200 hover:text-white">
              Close
            </button>
          </div>
          <div className="flex-1 overflow-y-auto my-3 space-y-2 font-mono text-[11px] pr-1">
            {events.length === 0 ? (
              <p className="text-sage-400 text-center py-6">No events yet.</p>
            ) : (
              events.map((evt, idx) => {
                const { type, ts, trail, ...fields } = evt;
                return (
                  <div key={idx} className="p-2.5 rounded-xl bg-grove-950/90 border border-moss-500/15">
                    <div className="flex items-center justify-between text-firefly-300 font-bold mb-1">
                      <span>{type}</span>
                      <span className="text-sage-400 text-[10px]">{new Date(ts).toLocaleTimeString()}</span>
                    </div>
                    <pre className="text-sage-200 whitespace-pre-wrap overflow-x-auto text-[10px]">
                      {JSON.stringify(trail ? { ...fields, trail: `[${trail.length} points]` } : fields, null, 2)}
                    </pre>
                  </div>
                );
              })
            )}
          </div>
          <div className="pt-2 border-t border-grove-800 flex justify-end text-[11px]">
            <button onClick={() => setEvents([])} className="text-red-300 hover:text-red-200">
              Clear
            </button>
          </div>
        </div>
      )}
    </>
  );
}
