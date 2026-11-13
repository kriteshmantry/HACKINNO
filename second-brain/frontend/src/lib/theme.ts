import { useEffect, useState } from 'react'

export type Theme = 'dark' | 'light'
const KEY = 'sb-theme'

function read(): Theme {
  try {
    const t = localStorage.getItem(KEY)
    if (t === 'light' || t === 'dark') return t
  } catch { /* private mode */ }
  return 'light' // the demo runs on a projector
}

export function applyStoredTheme() {
  document.documentElement.dataset.theme = read()
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(read)
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try { localStorage.setItem(KEY, theme) } catch { /* ignore */ }
  }, [theme])
  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))] as const
}
