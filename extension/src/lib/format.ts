export const pct = (p: number, digits = 1) => `${(p * 100).toFixed(digits)}%`

export const signedPct = (p: number) => `${p >= 0 ? '+' : '−'}${Math.abs(p * 100).toFixed(1)} pts`

export const usd = (n: number) => `$${n.toFixed(2)}`

/** Event title with its outcome label, unless the title already says it. */
export const eventLabel = (title: string, subtitle: string) =>
  subtitle && !title.toLowerCase().includes(subtitle.toLowerCase()) ? `${title} · ${subtitle}` : title

export const shortAddress = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`
