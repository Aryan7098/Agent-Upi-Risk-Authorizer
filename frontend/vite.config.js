import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev: `npm run dev` proxies API calls to the FastAPI backend on :8000.
// Prod: `npm run build` -> dist/, served by FastAPI itself (same origin, no CORS).
const api = 'http://localhost:8000'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/health': api,
      '/authorize': api,
      '/confirm': api,
      '/simulate': api,
      '/policy': api,
      '/keys': api,
      '/profile': api,
      '/audit': api,
      '/pending': api,
    },
  },
  build: { outDir: 'dist' },
})
