import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Fonts are bundled, not loaded from a font CDN: a privacy tool should not tell a third party who opened it.
import '@fontsource/eczar/400.css'
import '@fontsource/eczar/600.css'
import '@fontsource/eczar/700.css'
import '@fontsource/work-sans/400.css'
import '@fontsource/work-sans/500.css'
import '@fontsource/work-sans/600.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/600.css'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
