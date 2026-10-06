import type { Side } from '../types'

export default function SideBadge({ side }: { side: Side }) {
  return <span className={`badge ${side === 'yes' ? 'badge-success' : 'badge-danger'}`}>BUY {side.toUpperCase()}</span>
}
