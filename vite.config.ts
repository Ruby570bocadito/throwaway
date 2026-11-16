import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Preloads the fonts each page shows when it opens, so text does not reflow when they arrive. Lighthouse (16-nov) measured
 * a 0.27 layout shift in the app from Eczar, Work Sans and JetBrains Mono swapping in after the first paint.
 */
function preloadFonts(): Plugin {
  const landing = /^assets\/(eczar-latin-(500|600)|work-sans-latin-400|jetbrains-mono-latin-400)-normal-[\w-]+\.woff2$/
  const app = /^assets\/(eczar-latin-(500|600)|work-sans-latin-(400|600)|jetbrains-mono-latin-400)-normal-[\w-]+\.woff2$/
  return {
    name: 'preload-fonts',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        if (!ctx.bundle) return []
        const wanted = ctx.filename.replace(/\\/g, '/').endsWith('/app/index.html') ? app : landing
        return Object.keys(ctx.bundle)
          .filter((file) => wanted.test(file))
          .map((file) => ({
            tag: 'link',
            attrs: { rel: 'preload', href: `/${file}`, as: 'font', type: 'font/woff2', crossorigin: '' },
            injectTo: 'head' as const,
          }))
      },
    },
  }
}

// Two pages: the landing page (/) and the app (/app/). The landing page loads neither React, nor the app, nor Firebase.
export default defineConfig({
  plugins: [react(), preloadFonts()],
  build: {
    // Never inline assets as data: URLs (Vite inlined the smallest font subsets), so the CSP can keep font-src 'self'.
    assetsInlineLimit: 0,
    rollupOptions: {
      input: { landing: 'index.html', app: 'app/index.html' },
    },
  },
})
