export const pct = (p: number, digits = 1) => `${(p * 100).toFixed(digits)}%`

export const signedPct = (p: number) => `${p >= 0 ? '+' : '−'}${Math.abs(p * 100).toFixed(1)} pts`

export const usd = (n: number) => `$${n.toFixed(2)}`

export const shortAddress = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`
