// Minimal line-icon set (consistent 1.75 stroke, currentColor). No emoji.
const base = {
  width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round',
}

export const Shield = (p) => (
  <svg {...base} {...p}><path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" /><path d="M9 12l2 2 4-4" /></svg>
)
export const Bolt = (p) => (
  <svg {...base} {...p}><path d="M13 3L5 13h6l-2 8 8-10h-6l2-8z" /></svg>
)
export const Activity = (p) => (
  <svg {...base} {...p}><path d="M3 12h4l3 8 4-16 3 8h4" /></svg>
)
export const Sliders = (p) => (
  <svg {...base} {...p}><path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h6M14 18h6" /><circle cx="16" cy="6" r="2" /><circle cx="8" cy="12" r="2" /><circle cx="12" cy="18" r="2" /></svg>
)
export const Clock = (p) => (
  <svg {...base} {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
)
export const Check = (p) => (
  <svg {...base} {...p}><path d="M5 12l5 5L19 7" /></svg>
)
export const Layers = (p) => (
  <svg {...base} {...p}><path d="M12 3l9 5-9 5-9-5 9-5z" /><path d="M3 13l9 5 9-5" /></svg>
)
export const Cpu = (p) => (
  <svg {...base} {...p}><rect x="7" y="7" width="10" height="10" rx="2" /><path d="M9 3v2M15 3v2M9 19v2M15 19v2M3 9h2M3 15h2M19 9h2M19 15h2" /></svg>
)
