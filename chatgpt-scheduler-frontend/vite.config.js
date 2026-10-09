import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const BACKEND_URL = 'http://localhost:3000'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Proxy API calls to the Express backend so requests are same-origin
    // (no CORS needed) and the session cookie is sent along.
    // In production, vercel.json rewrites the same paths to the deployed backend.
    proxy: {
      '/api': BACKEND_URL,
      '/auth': BACKEND_URL, // also covers /auth/status
      '/oauth2callback': BACKEND_URL,
      '/add-event': BACKEND_URL,
      '/import-events': BACKEND_URL,
      '/create-calendar': BACKEND_URL,
    },
  },
})
