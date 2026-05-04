import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        'industrial-black': '#0D0D0D',
        'industrial-panel': '#161616',
        'industrial-border': '#262626',
        'amber-accent': '#F59E0B',
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      keyframes: {
        bounceUp: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%':       { transform: 'translateY(-4px)' },
        },
        shimmer: {
          '0%':   { left: '-60%' },
          '100%': { left: '140%' },
        },
      },
      animation: {
        bounceUp: 'bounceUp 1.4s ease-in-out infinite',
        shimmer:  'shimmer 0.45s linear forwards',
      },
    },
  },
  plugins: [],
};

export default config;