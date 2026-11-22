import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
// First: the language is picked (and <html lang> set) before anything renders.
import './i18n'
// Fonts are bundled, not loaded from a font CDN: a privacy tool should not tell a third party who opened it.
import '@fontsource-variable/inter'
import '@fontsource/eczar/500.css'
import '@fontsource/eczar/600.css'
import '@fontsource/jetbrains-mono/400.css'
import './index.css'
import App from './App.tsx'

// /app/?diag measures Gemini Nano in this browser (its own chunk: visitors of the app never download it).
const Diagnostics = lazy(() => import('./ui/Diagnostics'))
const diag = new URLSearchParams(location.search).has('diag')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {diag ? (
      <Suspense fallback={null}>
        <Diagnostics />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
)

// Installable, and the shell (with the recorded run) opens offline. The manifest is linked a few seconds after load, when the
// browser is idle, off the first paint's critical path; the service worker runs in production only (in development it would
// cache Vite's modules).
const idle = (fn: () => void) => ('requestIdleCallback' in window ? requestIdleCallback(fn, { timeout: 5000 }) : fn())
addEventListener('load', () =>
  setTimeout(
    () =>
      idle(() => {
        const manifest = document.createElement('link')
        manifest.rel = 'manifest'
        manifest.href = '/manifest.webmanifest'
        document.head.append(manifest)
        if (import.meta.env.PROD && 'serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js').catch(() => undefined)
      }),
    3000,
  ),
)
