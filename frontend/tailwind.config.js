/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Archivo', 'system-ui', 'sans-serif'],
        mono: ['"Spline Sans Mono"', 'ui-monospace', 'monospace'],
      },
      colors: {
        ink: '#0E1522',
        slab: '#151E2E',
        line: '#223049',
        paper: '#EAEEF6',
        mute: '#8A97AD',
        cleared: '#35C08A',
        held: '#E4A93C',
        denied: '#F0525A',
      },
      keyframes: {
        stampIn: {
          '0%': { opacity: '0', transform: 'scale(1.04)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
      },
      animation: {
        // One deliberate reveal, used only on the hero verdict.
        stamp: 'stampIn 0.28s cubic-bezier(0.2, 0.9, 0.3, 1) both',
      },
    },
  },
  plugins: [],
}
