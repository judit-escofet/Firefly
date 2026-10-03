// Simulated 911 ("dispatch") call from inside the app, over Vonage or Twilio Voice (WebRTC).
// The server's token response says which provider is set up.
//
// Starts on a scream/code-phrase alert (alert.state "alerted") or when she taps "Call 911".
// The browser gets a token from POST /api/voice/token and calls our TwiML App, which dials the
// demo dispatch number (312-826-2020, never real 911). The dispatcher hears a short report
// first, then talks with her through the app's mic and speaker.
//
// Fallbacks, so a tap or an alert never silently does nothing:
//   mock mode (?mock=1)        -> a simulated call on screen; nothing is dialed (stage safety)
//   no in-app calling (503)    -> POST /api/walks/{id}/dispatch: Twilio calls the dispatcher with
//                                 an automated report
//   backend unreachable        -> the panel offers tel: to the demo number (her tap opens the dialer)
//
// Emits dispatch.call {state, mode, reason, display, tel} on the bus. state is one of:
// connecting, ringing, connected, automated, ended, failed.

import { bus } from '../bus';
import { isMockModeEnabled } from './mockData';

const BASE = import.meta.env?.VITE_API_URL ?? '';
export const DEMO_DISPATCH_TEL = '+13128262020';
export const DEMO_DISPATCH_DISPLAY = '(312) 826-2020';

let current = null; // { state, mode, reason, call, device, startedAt, muted }

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

async function automatedFallback(walk, reason) {
  try {
    const r = await postJson(`walks/${encodeURIComponent(walk.walk_id)}/dispatch`, { reason });
    if (r.ok && (r.data.called || r.data.duplicate)) return emit({ state: 'automated', mode: 'automated' });
  } catch {}
  emit({ state: 'failed', mode: 'dialer' }); // the panel shows a tap-to-call button
}

// reason: scream | code_phrase | button | no_response | checkin
export async function startDispatchCall(walk, { reason = 'button' } = {}) {
  if (active()) return current;
  current = { reason, muted: false };
  if (isMockModeEnabled()) return simulate(reason);
  if (!walk || walk.offline || String(walk.walk_id).startsWith('w_local_')) return emit({ state: 'failed', mode: 'dialer', reason });

  emit({ state: 'connecting', mode: 'app', reason });
  let token;
  try {
    const r = await postJson('voice/token', { walk_id: walk.walk_id });
    if (!r.ok) {
      console.warn(`[dispatch] in-app calling unavailable (${r.status} ${r.data.error ?? ''}); asking the server to call`);
      return automatedFallback(walk, reason);
    }
    token = r.data.token;
    current.display = r.data.dispatch_display;
    current.tel = r.data.dispatch_tel;
    if (r.data.provider === 'vonage') return startVonage(token, walk, reason);
  } catch (err) {
    console.warn(`[dispatch] token request failed (${err.message})`);
    return automatedFallback(walk, reason);
  }

  try {
    const { Device } = await import('@twilio/voice-sdk'); // loaded only when a call is needed
    const device = new Device(token, { codecPreferences: ['opus', 'pcmu'], logLevel: 'warn' });
    current.device = device;
    const call = await device.connect({ params: { walk_id: walk.walk_id, reason } });
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
    return automatedFallback(walk, reason);
  }
  return current;
}

// Vonage Client SDK: log in, then serverCall() asks our Answer URL to connect the dispatcher.
// Leg updates for the dispatcher's leg (not her own, whose id is the call id) drive the panel.
async function startVonage(token, walk, reason) {
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
    const callId = await client.serverCall({ walk_id: walk.walk_id, reason });
    current.vonage.callId = callId;
    if (current.state === 'connecting') emit({ state: 'ringing' });
  } catch (err) {
    console.error('[dispatch] could not start the in-app call (Vonage)', err);
    current.vonage?.client?.deleteSession?.().catch(() => {});
    current.vonage = null;
    return automatedFallback(walk, reason);
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
