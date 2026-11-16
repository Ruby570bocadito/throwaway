import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Two pages: the landing page (/) and the app (/app/). The landing page loads neither React, nor the app, nor Firebase.
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: { landing: 'index.html', app: 'app/index.html' },
    },
  },
})
