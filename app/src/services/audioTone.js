/**
 * Audio and Haptic feedback for the Countdown screen.
 * In accordance with P4 Spec:
 * - "quiet 10-second ring, and a vibration pattern"
 * - "Looks calm on purpose... No red, no words like 'alert' anyone nearby could read"
 * Audio uses a calm, gentle harmonic sine tone rather than an alarming siren.
 */

import { currentMic } from '../audio/micHub.js';

let audioCtx = null;
let oscillatorInterval = null;
let vibrationInterval = null;

function getAudioContext() {
  // Prefer the walk's shared AudioContext: it was resumed inside the "Walk with me" tap, so it
  // can play on iOS without another gesture.
  const shared = currentMic()?.ctx;
  if (shared && shared.state !== 'closed') return shared;
  if (!audioCtx && typeof window !== 'undefined') {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (AudioContext) {
      audioCtx = new AudioContext();
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
}

function playGentleChime(ctx) {
  if (!ctx) return;
  try {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    // Gentle mellow frequency (warm major third tone: 440Hz -> 554Hz)
    osc.type = 'sine';
    osc.frequency.setValueAtTime(440, now);
    osc.frequency.exponentialRampToValueAtTime(554, now + 0.15);

    // Soft envelope with gradual release
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.12, now + 0.05); // Quiet volume
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.65);
  } catch (e) {
    console.warn('Audio playback error:', e);
  }
}

export const countdownFeedback = {
  start() {
    this.stop(); // Clear any ongoing

    // Start gentle ring pulses every 1.2 seconds
    const ctx = getAudioContext();
    if (ctx) {
      playGentleChime(ctx);
      oscillatorInterval = setInterval(() => {
        playGentleChime(ctx);
      }, 1200);
    }

    // Start subtle vibration pattern: 200ms vibrate, 300ms pause
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate([200, 300, 200]);
      vibrationInterval = setInterval(() => {
        navigator.vibrate([200, 300, 200]);
      }, 1200);
    }
  },

  stop() {
    if (oscillatorInterval) {
      clearInterval(oscillatorInterval);
      oscillatorInterval = null;
    }
    if (vibrationInterval) {
      clearInterval(vibrationInterval);
      vibrationInterval = null;
    }
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate(0); // Cancel ongoing vibration
    }
  }
};
