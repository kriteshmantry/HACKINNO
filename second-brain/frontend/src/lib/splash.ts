/** The loading screen lives in index.html so it paints before any JavaScript; this reports progress to it. */
declare global {
  interface Window { __splash?: { step(text: string | null, pct?: number): void; hide(): void } }
}

export const splash = {
  step: (text: string, pct: number) => window.__splash?.step(text, pct),
  hide: () => window.__splash?.hide(),
}
