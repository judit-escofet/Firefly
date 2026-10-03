/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        mythic: ['Cinzel Decorative', 'serif'],
        cinzel: ['Cinzel', 'serif'],
        whimsical: ['Fraunces', 'serif'],
        sans: ['Plus Jakarta Sans', 'sans-serif'],
      },
      colors: {
        // Midnight Blues & Royal Purples (NOT pure black!)
        twilight: {
          950: '#0e122b',
          900: '#151a3d',
          850: '#1d2350',
          800: '#252d63',
          700: '#343e85',
        },
        mystic: {
          950: '#180e2b',
          900: '#241440',
          850: '#321957',
          800: '#431f75',
          700: '#5a2a9c',
          600: '#793bd4',
          500: '#9149e8',
          400: '#a855f7',
        },
        grove: {
          950: '#0a1d18',
          900: '#0f2c24',
          850: '#163d32',
          800: '#1d4f41',
          700: '#245f4e',
          600: '#2c735f',
          400: '#42a386',
        },
        // Soft greens for calm text (countdown, demo drawer) and mossy accents
        sage: {
          50: '#f3f8f4',
          100: '#e3efe6',
          200: '#c9dfcf',
          300: '#a8c9b2',
          400: '#86ae93',
          500: '#678f75',
        },
        moss: {
          300: '#9fd4a8',
          400: '#6fbf85',
          500: '#4c9a64',
        },
        amber: {
          lantern: '#f5b94a',
        },
        crimson: {
          900: '#4c0519',
          300: '#fda4af',
          800: '#881337',
          700: '#9f1239',
          600: '#be123c',
          500: '#e11d48',
          400: '#fb7185',
        },
        // Shimmering Metallic Gold
        gold: {
          100: '#fefce8',
          200: '#fef08a',
          300: '#fde047',
          400: '#facc15',
          500: '#eab308',
          600: '#ca8a04',
          shimmer: '#ffd700',
        },
        // Ethereal Pastels
        pastel: {
          lavender: '#e9d5ff',
          mint: '#a7f3d0',
          rose: '#fbcfe8',
          sky: '#bae6fd',
          amber: '#fde68a',
        },
        firefly: {
          100: '#fef9dc',
          200: '#fcf0ab',
          300: '#fae37c',
          400: '#f2cc57',
          500: '#d9a936',
          glow: '#ffd843',
        },
      },
      boxShadow: {
        'mythic-glow': '0 0 25px rgba(168, 85, 247, 0.35), 0 0 50px rgba(250, 204, 21, 0.2)',
        'firefly': '0 0 22px rgba(250, 204, 21, 0.45), 0 0 45px rgba(250, 204, 21, 0.25)',
        'firefly-lg': '0 0 35px rgba(250, 204, 21, 0.7), 0 0 70px rgba(168, 85, 247, 0.4)',
        'card-shimmer': '0 10px 30px -5px rgba(20, 25, 60, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.15)',
        'grove-glow': '0 0 18px rgba(111, 191, 133, 0.25)',
        'mythic-halo': '0 0 24px rgba(168, 85, 247, 0.25), 0 0 40px rgba(250, 204, 21, 0.15)',
        'portal-glow': '0 0 60px rgba(124, 58, 237, 0.35), inset 0 0 40px rgba(250, 204, 21, 0.2)',
      },
      animation: {
        'pulse-slow': 'pulse 3.5s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'mythic-float': 'mythicFloat 5s ease-in-out infinite',
        'fae-flutter-l': 'faeFlutterL 0.22s ease-in-out infinite alternate',
        'fae-flutter-r': 'faeFlutterR 0.22s ease-in-out infinite alternate',
        'orbit-1': 'orbit1 4s linear infinite',
        'orbit-2': 'orbit2 6s linear infinite',
        'orbit-3': 'orbit3 5s linear infinite reverse',
        'aurora-shift': 'auroraShift 10s ease-in-out infinite alternate',
        'shimmer': 'shimmer 2.5s infinite linear',
        'fade-in': 'fadeIn 0.35s ease-out both',
        'shake': 'shake 0.35s ease-in-out',
        'wisp-drift': 'wispDrift 9s ease-in-out infinite',
      },
      keyframes: {
        mythicFloat: {
          '0%, 100%': { transform: 'translate(0, 0) scale(1) rotate(0deg)' },
          '20%': { transform: 'translate(4px, -8px) scale(1.03) rotate(2deg)' },
          '45%': { transform: 'translate(-5px, -15px) scale(0.97) rotate(-3deg)' },
          '70%': { transform: 'translate(-8px, -7px) scale(1.02) rotate(-1deg)' },
          '85%': { transform: 'translate(3px, -3px) scale(0.99) rotate(1deg)' },
        },
        faeFlutterL: {
          '0%': { transform: 'rotate(-4deg) scaleY(1)' },
          '100%': { transform: 'rotate(-18deg) scaleY(0.85)' },
        },
        faeFlutterR: {
          '0%': { transform: 'rotate(4deg) scaleY(1)' },
          '100%': { transform: 'rotate(18deg) scaleY(0.85)' },
        },
        orbit1: {
          '0%': { transform: 'rotate(0deg) translateX(36px) rotate(0deg)' },
          '100%': { transform: 'rotate(360deg) translateX(36px) rotate(-360deg)' },
        },
        orbit2: {
          '0%': { transform: 'rotate(120deg) translateX(44px) rotate(-120deg)' },
          '100%': { transform: 'rotate(480deg) translateX(44px) rotate(-480deg)' },
        },
        orbit3: {
          '0%': { transform: 'rotate(240deg) translateX(30px) rotate(-240deg)' },
          '100%': { transform: 'rotate(600deg) translateX(30px) rotate(-600deg)' },
        },
        auroraShift: {
          '0%': { filter: 'hue-rotate(0deg) brightness(1)' },
          '50%': { filter: 'hue-rotate(25deg) brightness(1.15)' },
          '100%': { filter: 'hue-rotate(-20deg) brightness(1)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        fadeIn: {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        shake: {
          '0%, 100%': { transform: 'translateX(0)' },
          '25%': { transform: 'translateX(-8px)' },
          '75%': { transform: 'translateX(8px)' },
        },
        wispDrift: {
          '0%, 100%': { transform: 'translate(0, 0)', opacity: '0.4' },
          '50%': { transform: 'translate(18px, -26px)', opacity: '0.9' },
        }
      }
    },
  },
  plugins: [],
};
