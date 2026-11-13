import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useRun } from '@/store/runStore'

export function Toast() {
  const toast = useRun((s) => s.toast)
  const [shown, setShown] = useState(toast)
  useEffect(() => {
    setShown(toast)
    if (!toast) return
    const t = setTimeout(() => setShown(undefined), 5200)
    return () => clearTimeout(t)
  }, [toast])
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-[60] flex justify-center px-4" aria-live="polite">
      <AnimatePresence>
        {shown && (
          <motion.div key={shown.key} initial={{ y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 8, opacity: 0 }}
            className="pointer-events-auto max-w-xl rounded-md border bg-surface px-4 py-2.5 text-[13px] font-medium shadow-[var(--shadow)]"
            style={{ borderColor: `var(--${shown.tone})`, color: `var(--${shown.tone})` }}>
            {shown.text}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

