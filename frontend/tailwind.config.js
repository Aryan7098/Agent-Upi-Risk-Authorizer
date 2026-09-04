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
        // Near-monochrome console. Color is reserved for verdict semantics only.
        ink: '#0B0C0E',    // page ground
        slab: '#141518',   // raised surface (used sparingly)
        slab2: '#191A1E',  // hover / inset
        line: '#232529',   // hairline
        line2: '#2E3036',  // stronger hairline
        paper: '#E7E8EB',  // primary text
        mute: '#9B9DA4',   // secondary text
        faint: '#6B6D75',  // tertiary text
        cleared: '#46B08A', // ALLOW  — muted green
        held: '#CD9A46',    // STEP_UP — muted amber
        denied: '#DB5C62',  // BLOCK  — muted red
      },
      borderRadius: {
        md: '6px',
        lg: '8px',
      },
      keyframes: {
        rise: {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'none' },
        },
      },
      animation: {
        rise: 'rise 0.32s cubic-bezier(0.2, 0.8, 0.3, 1) both',
      },
    },
  },
  plugins: [],
}
