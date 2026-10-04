import plugin from 'tailwindcss/plugin';

/** @type {import('tailwindcss').Config} */
// Firefly palette: a grove at night. Moss-dark greens for everything, parchment for text, and one
// warm lantern colour that belongs to the firefly (glow, the main button, the route). No purple,
// no neon, no gradients on text. Older token names (twilight, mystic, gold, pastel) are kept but
// point at the same grove colours so nothing slips back to the old indigo look.
const night = {
  950: '#0c1511',
  900: '#111d18',
  850: '#15231d',
  800: '#1b2c25',
  700: '#253a31',
  600: '#33503f',
};
const lantern = {
  100: '#fff3d6',
  200: '#ffe4a6',
  300: '#ffd27a',
  400: '#f6bd55',
  500: '#e2a23b',
  600: '#bb8128',
};

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        // Fraunces (soft, slightly wonky serif) for headings and the firefly's voice;
        // Atkinson Hyperlegible for everything read at a glance while walking.
        display: ['Fraunces', 'Georgia', 'serif'],
        sans: ['"Atkinson Hyperlegible"', 'system-ui', 'sans-serif'],
        whimsical: ['Fraunces', 'Georgia', 'serif'],
        mythic: ['Fraunces', 'Georgia', 'serif'],
        cinzel: ['Fraunces', 'Georgia', 'serif'],
      },
      colors: {
        night,
        lantern,
        parchment: { 50: '#f7f1e3', 100: '#efe6d0', 200: '#ddd1b4' },
        lichen: { 200: '#c8d2bd', 300: '#a9b8a0', 400: '#869683', 500: '#66756a' },
        ember: { 400: '#e0634f', 500: '#c9432f', 600: '#a8321f' },
        grove: { 950: '#0c1511', 900: '#111d18', 850: '#15231d', 800: '#1b2c25', 700: '#253a31', 600: '#33503f', 400: '#5f8a6c' },
        sage: { 50: '#f3f6ef', 100: '#e3eadb', 200: '#c8d2bd', 300: '#a9b8a0', 400: '#869683', 500: '#66756a' },
        moss: { 300: '#a6cf98', 400: '#86b878', 500: '#5f9455' },
        amber: { lantern: lantern[400] },
        firefly: { 100: lantern[100], 200: lantern[200], 300: lantern[300], 400: lantern[400], 500: lantern[500], glow: '#ffd36b' },
        // Legacy names → grove colours
        twilight: { 950: night[950], 900: night[900], 850: night[850], 800: night[800], 700: night[700] },
        mystic: { 950: night[950], 900: night[900], 850: night[850], 800: night[800], 700: night[700], 600: night[600], 500: night[600], 400: '#5f8a6c' },
        gold: { 100: lantern[100], 200: lantern[200], 300: lantern[300], 400: lantern[400], 500: lantern[500], 600: lantern[600], shimmer: lantern[400] },
        pastel: { lavender: '#c8d2bd', mint: '#a6cf98', rose: '#f0b3a6', sky: '#c8d2bd', amber: lantern[200] },
        crimson: { 900: '#3a1510', 800: '#6e2418', 700: '#8f2c1c', 600: '#a8321f', 500: '#c9432f', 400: '#e0634f', 300: '#f0a596' },
      },
      boxShadow: {
        // Shadows are for lifting things off the map, not for decoration.
        lift: '0 8px 24px -8px rgba(0, 0, 0, 0.55)',
        press: 'inset 0 -3px 0 rgba(0, 0, 0, 0.22)',
        firefly: '0 0 18px rgba(255, 205, 110, 0.45)',
        'firefly-lg': '0 0 32px rgba(255, 205, 110, 0.6)',
        'grove-glow': '0 0 0 1px rgba(134, 184, 120, 0.25)',
        'mythic-glow': '0 8px 24px -8px rgba(0, 0, 0, 0.55)',
        'mythic-halo': '0 8px 24px -8px rgba(0, 0, 0, 0.55)',
        'card-shimmer': '0 8px 24px -8px rgba(0, 0, 0, 0.55)',
      },
      animation: {
        'fade-in': 'fadeIn 0.4s ease-out both',
        'rise-in': 'riseIn 0.6s cubic-bezier(0.2, 0.7, 0.2, 1) both',
        shake: 'shake 0.35s ease-in-out',
        bob: 'bob 6s ease-in-out infinite',
        'wing-l': 'wingL 0.18s ease-in-out infinite alternate',
        'wing-r': 'wingR 0.18s ease-in-out infinite alternate',
        breathe: 'breathe 2.4s ease-in-out infinite',
        'pulse-slow': 'pulse 3.5s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
      keyframes: {
        fadeIn: { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        riseIn: { '0%': { opacity: '0', transform: 'translateY(10px)' }, '100%': { opacity: '1', transform: 'translateY(0)' } },
        shake: { '0%, 100%': { transform: 'translateX(0)' }, '25%': { transform: 'translateX(-7px)' }, '75%': { transform: 'translateX(7px)' } },
        // A firefly doesn't hover in place: a lazy, slightly lopsided drift.
        bob: {
          '0%, 100%': { transform: 'translate(0, 0) rotate(-2deg)' },
          '30%': { transform: 'translate(5px, -7px) rotate(3deg)' },
          '60%': { transform: 'translate(-3px, -11px) rotate(-1deg)' },
          '80%': { transform: 'translate(-6px, -4px) rotate(-4deg)' },
        },
        wingL: { '0%': { transform: 'rotate(4deg)' }, '100%': { transform: 'rotate(-14deg)' } },
        wingR: { '0%': { transform: 'rotate(-4deg)' }, '100%': { transform: 'rotate(14deg)' } },
        breathe: { '0%, 100%': { opacity: '0.75' }, '50%': { opacity: '1' } },
      },
    },
  },
  plugins: [
    // Very short screens (small phones, phones held sideways): tighter layouts instead of scrolling.
    plugin(({ addVariant }) => {
      addVariant('short', '@media (max-height: 640px)');
      addVariant('tiny', '@media (max-height: 520px)');
      addVariant('land', '@media (orientation: landscape) and (max-height: 520px)');
    }),
  ],
};
