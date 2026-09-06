/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: 'rgb(var(--color-bg) / <alpha-value>)',
        surface: 'rgb(var(--color-surface) / <alpha-value>)',
        surface2: 'rgb(var(--color-surface2) / <alpha-value>)',
        border: 'rgb(var(--color-border) / <alpha-value>)',
        txt: 'rgb(var(--color-txt) / <alpha-value>)',
        muted: 'rgb(var(--color-muted) / <alpha-value>)',
        gain: 'rgb(var(--color-gain) / <alpha-value>)',
        loss: 'rgb(var(--color-loss) / <alpha-value>)',
        accent: 'rgb(var(--color-accent) / <alpha-value>)',
        high: 'rgb(var(--color-high) / <alpha-value>)',
        warn: 'rgb(var(--color-warn) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      keyframes: {
        pulseDot: { '0%,100%': { opacity: 1 }, '50%': { opacity: 0.35 } },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        riseIn: { '0%': { opacity: 0, transform: 'translateY(6px)' }, '100%': { opacity: 1, transform: 'none' } },
        flashUp: { '0%': { backgroundColor: 'rgba(63,185,80,0.16)' }, '100%': { backgroundColor: 'transparent' } },
        flashDown: { '0%': { backgroundColor: 'rgba(248,81,73,0.16)' }, '100%': { backgroundColor: 'transparent' } },
      },
      animation: {
        pulseDot: 'pulseDot 2s ease-in-out infinite',
        riseIn: 'riseIn 240ms ease-out both',
        flashUp: 'flashUp 900ms ease-out',
        flashDown: 'flashDown 900ms ease-out',
      },
    },
  },
  plugins: [],
};