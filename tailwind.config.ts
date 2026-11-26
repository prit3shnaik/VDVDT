import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        shell: 'var(--shell)',
        canvas: 'var(--bg)',
        elevated: 'var(--bg-elevated)',
        muted: 'var(--bg-muted)',
        sunken: 'var(--bg-sunken)',
        ink: {
          DEFAULT: 'var(--ink)',
          secondary: 'var(--ink-secondary)',
          tertiary: 'var(--ink-tertiary)',
        },
        line: {
          DEFAULT: 'var(--line)',
          strong: 'var(--line-strong)',
        },
        brand: {
          50: 'var(--brand-50)',
          100: 'var(--brand-100)',
          200: 'var(--brand-200)',
          500: 'var(--brand-500)',
          600: 'var(--brand-600)',
          700: 'var(--brand-700)',
        },
      },
      fontFamily: {
        sans: ['Inter', 'Segoe UI', 'sans-serif'],
        display: ['Space Grotesk', 'Inter', 'sans-serif'],
      },
      boxShadow: {
        soft: '0 1px 2px rgba(15, 23, 42, 0.04), 0 10px 24px -16px rgba(37, 56, 110, 0.18)',
        lift: '0 1px 2px rgba(15, 23, 42, 0.05), 0 16px 32px -18px rgba(37, 56, 110, 0.28)',
        header: '0 1px 0 rgba(79, 70, 229, 0.06), 0 8px 20px -16px rgba(15, 23, 42, 0.18)',
        popover: '0 12px 32px rgba(15, 23, 42, 0.14), 0 2px 6px rgba(15, 23, 42, 0.06)',
        inset: 'inset 0 1px 0 rgba(255, 255, 255, 0.72)',
      },
      letterSpacing: {
        label: '0.08em',
      },
    },
  },
  plugins: [],
} satisfies Config
