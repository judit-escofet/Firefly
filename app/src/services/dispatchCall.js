// Simulated 911 ("dispatch") call from inside the app, over Vonage or Twilio Voice (WebRTC).
//
// Starts on an alert (scream, code phrase or a distress phrase like "I've been stabbed", once the
// countdown runs out without her PIN) or when she taps "Call 911". The app calls the demo dispatch
// number (312-826-2020, never real 911): the dispatcher first hears a report (her name, what
// happened, what she said, where she is), then talks with her through the app's mic and speaker.
//
// It is a REAL call in demo mode too: demo walks exist only on the phone, so the app sends her
// name and position with the call (the server limits those calls to a few per 10 minutes).
// Only ?dispatch=sim simulates the call on screen without dialling.
//
// Fallbacks, so a tap or an alert never silently does nothing:
//   no in-app calling       -> POST /api/walks/{id}/dispatch: Twilio/Vonage calls the dispatcher
//                              with an automated report
//   backend unreachable     -> the panel offers tel: to the demo number (her tap opens the dialer)
//
// Emits dispatch.call {state, mode, reason, display, tel} on the bus. state is one of:
// connecting, ringing, connected, automated, ended, failed.

import { bus } from '../bus';

const BASE = import.meta.env?.VITE_API_URL ?? '';
export const DEMO_DISPATCH_TEL = '+13128262020';
export const DEMO_DISPATCH_DISPLAY = '(312) 826-2020';

let current = null; // { state, mode, reason, call, device, vonage, muted, ... }
let lastPosition = null;
bus.on('position.updated', (e) => {
  if (Number.isFinite(e.lat) && Number.isFinite(e.lng)) lastPosition = { lat: e.lat, lng: e.lng };
});

function emit(patch) {
  current = { ...current, ...patch };
  bus.emit('dispatch.call', {
    state: current.state,
    mode: current.mode,
    reason: current.reason,
    display: current.display ?? DEMO_DISPATCH_DISPLAY,
    tel: current.tel ?? DEMO_DISPATCH_TEL,
    muted: Boolean(current.muted),
    connected_at: current.connectedAt ?? null,
  });
}

const active = () => current && ['connecting', 'ringing', 'connected'].includes(current.state);
const simulated = () => new URLSearchParams(globalThis.window?.location?.search ?? '').get('dispatch') === 'sim';

function storedName() {
  try {
    return localStorage.getItem('firefly.name') || '';
  } catch {
    return '';
  }
}

async function postJson(path, body, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/api/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(t);
  }
}

function simulate(reason) {
  emit({ state: 'connecting', mode: 'mock', reason });
  setTimeout(() => current?.mode === 'mock' && current.state === 'connecting' && emit({ state: 'ringing' }), 1200);
  setTimeout(() => current?.mode === 'mock' && current.state === 'ringing' && emit({ state: 'connected', connectedAt: Date.now() }), 3500);
}

async function automatedFallback(ctx) {
  try {
    const r = await postJson(`walks/${encodeURIComponent(ctx.walk_id)}/dispatch`, ctx);
    if (r.ok && (r.data.called || r.data.duplicate)) return emit({ state: 'automated', mode: 'automated' });
  } catch {}
  emit({ state: 'failed', mode: 'dialer' }); // the panel shows a tap-to-call button
}

// reason: scream | code_phrase | distress | button | no_response | checkin
// said: what she said, when a phrase triggered it ("I've been stabbed").
export async function startDispatchCall(walk, { reason = 'button', said = null } = {}) {
  if (active()) return current;
  current = { reason, muted: false };
  if (simulated()) return simulate(reason);

  // Walks the backend knows use their id; demo/offline walks are sent as w_demo with her name and
  // position, so the dispatcher still hears who and where.
  const known = walk && !walk.offline && walk.walk_id && !String(walk.walk_id).startsWith('w_local_');
  const ctx = {
    walk_id: known ? walk.walk_id : 'w_demo',
    reason,
    ...(said ? { said: String(said).slice(0, 80) } : {}),
    ...(known ? {} : { name: storedName(), ...(lastPosition ?? {}) }),
  };

  emit({ state: 'connecting', mode: 'app', reason });
  let token;
  try {
    const r = await postJson('voice/token', ctx);
    if (!r.ok) {
      console.warn(`[dispatch] in-app calling unavailable (${r.status} ${r.data.error ?? ''}); asking the server to call`);
      return automatedFallback(ctx);
    }
    token = r.data.token;
    current.display = r.data.dispatch_display;
    current.tel = r.data.dispatch_tel;
    if (r.data.provider === 'vonage') return startVonage(token, ctx);
  } catch (err) {
    console.warn(`[dispatch] token request failed (${err.message})`);
    return automatedFallback(ctx);
  }

  try {
    const { Device } = await import('@twilio/voice-sdk'); // loaded only when a call is needed
    const device = new Device(token, { codecPreferences: ['opus', 'pcmu'], logLevel: 'warn' });
    current.device = device;
    const call = await device.connect({ params: Object.fromEntries(Object.entries(ctx).map(([k, v]) => [k, String(v)])) });
    current.call = call;
    const end = (state) => () => {
      if (current?.call !== call) return;
      emit({ state, call: null });
      device.destroy();
    };
    call.on('ringing', () => current?.call === call && current.state === 'connecting' && emit({ state: 'ringing' }));
    call.on('accept', () => current?.call === call && emit({ state: 'connected', connectedAt: Date.now() }));
    call.on('disconnect', end('ended'));
    call.on('cancel', end('ended'));
    call.on('reject', end('ended'));
    call.on('error', (err) => {
      console.error('[dispatch] call error', err);
      end('failed')();
    });
    if (current.state === 'connecting') emit({ state: 'ringing' });
  } catch (err) {
    console.error('[dispatch] could not start the in-app call', err);
    current.device?.destroy();
    return automatedFallback(ctx);
  }
  return current;
}

// Vonage Client SDK: log in, then serverCall() asks our Answer URL to connect the dispatcher.
// Leg updates for the dispatcher's leg (not her own, whose id is the call id) drive the panel.
async function startVonage(token, ctx) {
  try {
    const { VonageClient } = await import('@vonage/client-sdk'); // loaded only when a call is needed
    const client = new VonageClient();
    await client.createSession(token);
    current.vonage = { client, callId: null };
    client.on('legStatusUpdate', (callId, legId, status) => {
      if (callId !== current?.vonage?.callId || legId === callId) return;
      if (status === 'RINGING' && current.state === 'connecting') emit({ state: 'ringing' });
      if (status === 'ANSWERED') emit({ state: 'connected', connectedAt: Date.now() });
    });
    client.on('callHangup', (callId) => {
      if (callId !== current?.vonage?.callId) return;
      emit({ state: 'ended' });
      client.deleteSession().catch(() => {});
      current.vonage = null;
    });
    const callId = await client.serverCall(ctx);
    current.vonage.callId = callId;
    if (current.state === 'connecting') emit({ state: 'ringing' });
  } catch (err) {
    console.error('[dispatch] could not start the in-app call (Vonage)', err);
    current.vonage?.client?.deleteSession?.().catch(() => {});
    current.vonage = null;
    return automatedFallback(ctx);
  }
  return current;
}

export function hangUpDispatchCall() {
  if (!current) return;
  if (current.vonage?.callId) current.vonage.client.hangup(current.vonage.callId).catch(() => {});
  if (current.call) current.call.disconnect();
  else if (current.device) current.device.destroy();
  if (current.state !== 'ended') emit({ state: 'ended', call: null });
}

export function toggleDispatchMute() {
  if (current?.vonage?.callId) {
    const next = !current.muted;
    const { client, callId } = current.vonage;
    (next ? client.mute(callId) : client.unmute(callId)).catch((err) => console.warn('[dispatch] mute failed', err));
    return emit({ muted: next });
  }
  if (!current?.call) return emit({ muted: !current?.muted });
  const next = !current.call.isMuted();
  current.call.mute(next);
  emit({ muted: next });
}

export function dismissDispatchCall() {
  if (active()) return;
  current = null;
  bus.emit('dispatch.call', { state: 'idle' });
}
