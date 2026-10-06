import type { Side } from '../types'

export default function SideBadge({ side }: { side: Side }) {
  const tone = side === 'yes' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300'
  return (
    <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${tone}`}>
      Buy {side}
    </span>
  )
}
