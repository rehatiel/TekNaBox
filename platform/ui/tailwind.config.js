/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        display: ['"Syne"', 'sans-serif'],
        body: ['"DM Sans"', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
      colors: {
        bg: {
          base:    '#0a0c0f',
          surface: '#0f1318',
          elevated:'#151a21',
          border:  '#1e2630',
        },
        cyan: {
          dim:    '#0e3340',
          muted:  '#0d7490',
          DEFAULT:'#06b6d4',
          bright: '#67e8f9',
        },
        green: {
          dim:    '#0a2e1a',
          muted:  '#15803d',
          DEFAULT:'#22c55e',
          bright: '#86efac',
        },
        amber: {
          dim:    '#2d1a00',
          muted:  '#b45309',
          DEFAULT:'#f59e0b',
          bright: '#fcd34d',
        },
        red: {
          dim:    '#2d0a0a',
          muted:  '#b91c1c',
          DEFAULT:'#ef4444',
          bright: '#fca5a5',
        },
        slate: {
          700: '#334155',
          600: '#475569',
          500: '#64748b',
          400: '#94a3b8',
          300: '#cbd5e1',
          200: '#e2e8f0',
        }
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'fade-in': 'fadeIn 0.3s ease-out',
        'slide-up': 'slideUp 0.3s ease-out',
        'blink': 'blink 1.2s step-end infinite',
      },
      keyframes: {
        fadeIn: { from: { opacity: 0 }, to: { opacity: 1 } },
        slideUp: { from: { opacity: 0, transform: 'translateY(8px)' }, to: { opacity: 1, transform: 'translateY(0)' } },
        blink: { '0%, 100%': { opacity: 1 }, '50%': { opacity: 0 } },
      }
    },
  },
  plugins: [],
}
