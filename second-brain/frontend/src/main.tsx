import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import './styles/index.css'
import Landing from './pages/Landing'
import { applyStoredTheme } from './lib/theme'

// The console pulls in React Flow, dagre and the simulator; keep the landing page light.
const Console = lazy(() => import('./pages/Console'))

applyStoredTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route
          path="/console"
          element={
            <Suspense fallback={<div className="min-h-screen bg-bg" aria-busy="true" aria-label="Loading the console"><div className="h-14 border-b border-line bg-surface" /><div className="h-11 border-b border-line bg-bg-2" /></div>}>
              <Console />
            </Suspense>
          }
        />
        <Route path="*" element={<Landing />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
