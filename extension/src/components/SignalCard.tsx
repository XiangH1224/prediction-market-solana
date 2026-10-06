import { eventLabel, pct, signedPct } from '../lib/format'
import type { Signal } from '../types'
import SideBadge from './SideBadge'

/** Live edge for one market from the automatic scan: model probability against the price of the better side. */
export default function SignalCard({ signal }: { signal: Signal }) {
  const { market, prediction, decision } = signal
  return (
    <div className="card mb-2">
      <div className="card-body p-2">
        <SideBadge side={decision.side} /> {eventLabel(market.title, market.subtitle)}
        <div className={decision.actionable ? 'text-success' : 'text-muted'}>
          Model {pct(decision.p_win)} · ask {pct(decision.price)} · edge {signedPct(decision.edge)} · confidence{' '}
          {pct(prediction.confidence, 0)}
          {!decision.actionable && decision.reason && ` · not staged: ${decision.reason}`}
        </div>
        <small className="text-muted">{prediction.rationale}</small>
      </div>
    </div>
  )
}
