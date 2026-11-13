const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })

/** ₹5,00,000 */
export const rupees = (n: number) => inr.format(n)

/** ₹5L, ₹3.5L, ₹75k */
export function lakhs(n: number) {
  const a = Math.abs(n)
  const sign = n < 0 ? '−' : ''
  if (a >= 100000) return `${sign}₹${+(a / 100000).toFixed(2)}L`
  if (a >= 1000) return `${sign}₹${+(a / 1000).toFixed(1)}k`
  return `${sign}₹${a}`
}

export const pct = (x: number) => `${Math.round(x * 100)}%`

export function clock(iso: string) {
  const d = new Date(iso)
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function shortDate(iso: string) {
  const d = new Date(iso)
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ', ' +
    d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

export function fmtValue(v: unknown): string {
  if (typeof v === 'number') return v >= 1000 ? rupees(v) : String(v)
  if (Array.isArray(v)) return v.join(', ')
  if (v === null || v === undefined) return 'none'
  return String(v)
}
