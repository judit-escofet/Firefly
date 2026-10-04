import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { bus } from '../src/bus.js';
import { startDispatchCall, hangUpDispatchCall, dismissDispatchCall } from '../src/services/dispatchCall.js';

// A fake Vonage Client SDK: records calls and lets the test fire leg/hangup events.
const fakeVonage = vi.hoisted(() => ({ instances: [] }));
vi.mock('@vonage/client-sdk', () => ({
  VonageClient: class {
    constructor() { this.handlers = {}; this.log = []; fakeVonage.instances.push(this); }
    on(ev, fn) { this.handlers[ev] = fn; }
    async createSession(token) { this.log.push(['createSession', token]); return 'session-1'; }
    async serverCall(ctx) { this.log.push(['serverCall', ctx]); return 'leg-her'; }
    async hangup(id) { this.log.push(['hangup', id]); this.handlers.callHangup?.(id, null, 'LOCAL_HANGUP'); }
    async mute(id) { this.log.push(['mute', id]); }
    async unmute(id) { this.log.push(['unmute', id]); }
    async deleteSession() { this.log.push(['deleteSession']); }
  },
}));

// The demo "911" call: never dials real 911, and always ends up doing something visible.
const WALK = { walk_id: 'w_456', offline: false };

function track() {
  const states = [];
  const off = bus.on('dispatch.call', (e) => states.push(e));
  return { states, off };
}

describe('dispatch call (simulated 911)', () => {
  let t;
  beforeEach(() => {
    t = track();
  });
  afterEach(() => {
    hangUpDispatchCall();
    dismissDispatchCall();
    t.off();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('?dispatch=sim simulates the call on screen and dials nothing', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('window', { location: { search: '?mock=1&dispatch=sim' } });
    await startDispatchCall(WALK, { reason: 'scream' });
    vi.advanceTimersByTime(4000);
    expect(t.states.map((s) => s.state)).toEqual(['connecting', 'ringing', 'connected']);
    expect(t.states[0]).toMatchObject({ mode: 'mock', reason: 'scream', tel: '+13128262020', display: '(312) 826-2020' });
    expect(fetchSpy).not.toHaveBeenCalled();
    hangUpDispatchCall();
    expect(t.states.at(-1).state).toBe('ended');
  });

  it('when in-app calling is not set up (503), asks the server to call the dispatcher', async () => {
    vi.stubGlobal('window', { location: { search: '?mock=0' } });
    const fetchSpy = vi.fn(async (url) => {
      if (String(url).endsWith('/api/voice/token')) return { ok: false, status: 503, json: async () => ({ error: 'In-app calling is not configured' }) };
      return { ok: true, status: 200, json: async () => ({ ok: true, called: true }) };
    });
    vi.stubGlobal('fetch', fetchSpy);
    await startDispatchCall(WALK, { reason: 'button' });
    expect(fetchSpy.mock.calls.map(([u]) => u)).toEqual(['/api/voice/token', '/api/walks/w_456/dispatch']);
    expect(JSON.parse(fetchSpy.mock.calls[1][1].body)).toEqual({ walk_id: 'w_456', reason: 'button' });
    expect(t.states.at(-1)).toMatchObject({ state: 'automated', mode: 'automated' });
  });

  it('demo mode places a REAL call, sending her name, position and what she said', async () => {
    vi.stubGlobal('window', { location: { search: '?mock=1' } });
    vi.stubGlobal('localStorage', { getItem: (k) => (k === 'firefly.name' ? 'Priya' : null) });
    const fetchSpy = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchSpy);
    bus.emit('position.updated', { lat: 40.742, lng: -74.1776 });
    await startDispatchCall({ walk_id: 'w_local_abc', offline: true }, { reason: 'distress', said: "I've been stabbed" });
    const tokenBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/voice/token');
    expect(tokenBody).toEqual({ walk_id: 'w_demo', reason: 'distress', said: "I've been stabbed", name: 'Priya', lat: 40.742, lng: -74.1776 });
  });

  it('with no backend at all, offers tap-to-call instead of doing nothing', async () => {
    vi.stubGlobal('window', { location: { search: '?mock=0' } });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await startDispatchCall({ walk_id: 'w_local_abc', offline: true }, { reason: 'scream' });
    expect(t.states.at(-1)).toMatchObject({ state: 'failed', mode: 'dialer', tel: '+13128262020' });
  });

  it('never starts a second call while one is active', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { location: { search: '?dispatch=sim' } });
    await startDispatchCall(WALK, { reason: 'scream' });
    await startDispatchCall(WALK, { reason: 'button' });
    expect(t.states.filter((s) => s.state === 'connecting')).toHaveLength(1);
  });

  it('Vonage: logs in, places a server call with walk and reason, follows the dispatcher leg', async () => {
    vi.stubGlobal('window', { location: { search: '?mock=0' } });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200,
      json: async () => ({ provider: 'vonage', token: 'jwt-1', dispatch_display: '(312) 826-2020', dispatch_tel: '+13128262020' }) })));
    await startDispatchCall(WALK, { reason: 'scream' });
    const client = fakeVonage.instances.at(-1);
    expect(client.log.slice(0, 2)).toEqual([['createSession', 'jwt-1'], ['serverCall', { walk_id: 'w_456', reason: 'scream' }]]);
    expect(t.states.at(-1).state).toBe('ringing');
    client.handlers.legStatusUpdate('leg-her', 'leg-her', 'ANSWERED'); // her own leg: ignored
    expect(t.states.at(-1).state).toBe('ringing');
    client.handlers.legStatusUpdate('leg-her', 'leg-dispatch', 'ANSWERED');
    expect(t.states.at(-1)).toMatchObject({ state: 'connected', mode: 'app' });
    hangUpDispatchCall();
    await Promise.resolve();
    expect(client.log).toContainEqual(['hangup', 'leg-her']);
    expect(t.states.at(-1).state).toBe('ended');
  });
});
