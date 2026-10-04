import React, { useCallback, useEffect, useRef, useState } from 'react';
import { bus } from './bus';
import { api } from './services/api';
import { locationService } from './services/location';
import { wakeLockService } from './services/wakeLock';
import { hashPin, getOrCreateUserId } from './crypto';
import { setMockMode, MOCK_PROFILE, MOCK_ROUTE } from './services/mockData';
import { acquireMic } from './audio/micHub.js';
import { startDispatchCall, hangUpDispatchCall, dismissDispatchCall } from './services/dispatchCall';

import WelcomeScreen from './screens/WelcomeScreen';
import SetupScreen from './screens/SetupScreen';
import WalkScreen from './screens/WalkScreen';
import CountdownScreen from './screens/CountdownScreen';
import HomeScreen from './screens/HomeScreen';
import DemoControls from './components/DemoControls';

// The P4 app shell: screens, walk lifecycle and the P4 events of the team contract
// (walk.started, position.updated, pin.entered, walk.ended). The countdown and the "alerted"
// state are owned by the Guardian (alert.state); the app only displays them.

const micDisabled = () => new URLSearchParams(location.search).get('mic') === '0';

async function demoProfile() {
  const user_id = getOrCreateUserId();
  return {
    user_id,
    name: MOCK_PROFILE.name,
    contacts: MOCK_PROFILE.contacts,
    code_phrase: MOCK_PROFILE.code_phrase,
    pin_hash: await hashPin(MOCK_PROFILE.cancel_pin, user_id),
    duress_pin_hash: await hashPin(MOCK_PROFILE.duress_pin, user_id),
    news_interests: MOCK_PROFILE.news_interests,
    home: MOCK_PROFILE.home,
  };
}

export default function App({ modules }) {
  const [screen, setScreen] = useState('welcome'); // welcome | setup | starting | walk | home
  const [profile, setProfile] = useState(() => api.getProfile());
  const [walk, setWalk] = useState(null);
  const [summary, setSummary] = useState(null);
  const [alert, setAlert] = useState({ state: 'idle', seconds_left: null });
  const [showCountdown, setShowCountdown] = useState(false);
  const [alerted, setAlerted] = useState(false);
  const [startError, setStartError] = useState(null);
  const heldMic = useRef(null);
  const walkRef = useRef(null);

  // Follow the Guardian's escalation state. When the countdown runs out ("alerted"), call the demo
  // dispatcher from the app. (A duress PIN never reaches "alerted" on screen; the backend calls
  // the dispatcher silently for that one.)
  // What started the alert, and (for "I've been stabbed"-style phrases) what she said.
  const lastDanger = useRef({ source: 'scream', said: null });
  useEffect(() => {
    const offs = [
      bus.on('danger.signal', (e) => {
        if (!e.source) return;
        const said = e.source === 'distress' ? /heard "(.*)"/.exec(e.detail ?? '')?.[1] ?? null : null;
        lastDanger.current = { source: e.source, said };
      }),
      bus.on('alert.state', (e) => {
        setAlert({ state: e.state, seconds_left: e.seconds_left });
        if (e.state === 'countdown') setShowCountdown(true);
        if (e.state === 'alerted') {
          setShowCountdown(false);
          setAlerted(true);
          if (walkRef.current) startDispatchCall(walkRef.current, { reason: lastDanger.current.source, said: lastDanger.current.said });
        }
      }),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  const endWalk = useCallback(async (reason) => {
    const w = walkRef.current;
    if (!w) return;
    walkRef.current = null;
    locationService.stop();
    wakeLockService.disable();
    hangUpDispatchCall();
    dismissDispatchCall();
    const s = await api.endWalk(w, reason);
    bus.emit('walk.ended', { reason });
    heldMic.current?.release(); // P1/P2 hold their own references until they're done
    heldMic.current = null;
    setWalk(null);
    setShowCountdown(false);
    if (reason === 'arrived') {
      setSummary(s);
      setScreen('home');
    } else {
      setScreen('welcome');
    }
  }, []);

  // "Walk with me". Must open the mic synchronously inside the tap (iOS): P1 and P2 join this
  // already-open mic when walk.started arrives after the route is planned.
  const startWalk = useCallback(
    (prof, { file = null } = {}) => {
      if (walkRef.current) return;
      setStartError(null);
      if (!micDisabled() || file) heldMic.current = acquireMic(file ? { file } : {});
      wakeLockService.enable();
      setAlerted(false);
      setScreen('starting');
      (async () => {
        // Mock mode (and no GPS fix within 6 s) starts at the demo route's start near the venue.
        const start = await locationService.currentPosition({ lat: MOCK_ROUTE[0][0], lng: MOCK_ROUTE[0][1] });
        const w = await api.startWalk(prof, start);
        walkRef.current = w;
        setWalk(w);
        bus.emit('walk.started', { walk_id: w.walk_id, share_url: w.share_url, route: w.route });
        locationService.start(w, () => endWalk('arrived'));
        setScreen('walk');
        if (file && heldMic.current) {
          // "Walk with test audio": play the recording through the mic pipeline once P1 is listening.
          heldMic.current.ready
            .then(() => new Promise((r) => setTimeout(r, 2500)))
            .then(() => heldMic.current?.startFile())
            .catch((err) => console.warn('[app] test audio failed', err));
        }
      })().catch((err) => {
        console.error('[app] could not start the walk', err);
        setStartError(err.message);
        heldMic.current?.release();
        heldMic.current = null;
        wakeLockService.disable();
        walkRef.current = null;
        setScreen('welcome');
      });
    },
    [endWalk],
  );

  const handleTryDemo = async () => {
    setMockMode(true);
    const p = profile ?? (await api.saveProfile(await demoProfile())).profile;
    setProfile(p);
    // A fresh tap is needed for the mic on iOS: the demo button only prepares; the Walk button walks.
    setScreen('welcome');
  };

  return (
    <div className="relative min-h-screen bg-grove-950 text-sage-100 font-sans antialiased overflow-x-hidden">
      {screen === 'welcome' && (
        <WelcomeScreen
          hasProfile={!!profile}
          name={profile?.name}
          error={startError}
          onStartSetup={() => setScreen('setup')}
          onStartDemo={handleTryDemo}
          onStartWalk={() => startWalk(profile)}
        />
      )}

      {screen === 'setup' && (
        <SetupScreen
          initialProfile={profile}
          onComplete={(p) => {
            setProfile(p);
            setScreen('welcome');
          }}
          onBack={() => setScreen('welcome')}
        />
      )}

      {screen === 'starting' && (
        <div className="min-h-screen flex flex-col items-center justify-center text-firefly-300">
          <div className="w-12 h-12 rounded-full border-2 border-moss-400 border-t-firefly-400 animate-spin mb-4" />
          <p className="text-sm font-whimsical tracking-wider text-sage-200">Lighting your path home…</p>
        </div>
      )}

      {screen === 'walk' && walk && (
        <WalkScreen walk={walk} profile={profile} alerted={alerted} modules={modules} onEndWalk={() => endWalk('stopped')} />
      )}

      {showCountdown && (
        <CountdownScreen
          secondsLeft={alert.state === 'countdown' ? alert.seconds_left : 0}
          userId={profile?.user_id}
          cancelPinHash={profile?.pin_hash}
          duressPinHash={profile?.duress_pin_hash}
          onDone={() => setShowCountdown(false)}
        />
      )}

      {screen === 'home' && <HomeScreen summary={summary} contacts={profile?.contacts || []} onReset={() => setScreen('welcome')} />}

      <DemoControls
        activeScreen={screen}
        canWalk={!!profile && screen === 'welcome'}
        onWalkWithTestAudio={() => profile && startWalk(profile, { file: '/demo/test_walk.wav' })}
      />
    </div>
  );
}
