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
          base:    'var(--bg-base)',
          surface: 'var(--bg-surface)',
          elevated:'var(--bg-elevated)',
          border:  'var(--bg-border)',
        },
        cyan: {
          dim:    'var(--cyan-dim)',
          muted:  'var(--cyan-muted)',
          DEFAULT:'var(--cyan-DEFAULT)',
          bright: 'var(--cyan-bright)',
        },
        green: {
          dim:    'var(--green-dim)',
          muted:  'var(--green-muted)',
          DEFAULT:'var(--green-DEFAULT)',
          bright: 'var(--green-bright)',
        },
        amber: {
          dim:    'var(--amber-dim)',
          muted:  'var(--amber-muted)',
          DEFAULT:'var(--amber-DEFAULT)',
          bright: 'var(--amber-bright)',
        },
        red: {
          dim:    'var(--red-dim)',
          muted:  'var(--red-muted)',
          DEFAULT:'var(--red-DEFAULT)',
          bright: 'var(--red-bright)',
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
