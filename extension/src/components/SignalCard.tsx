import { pct, signedPct } from '../lib/format'
import type { Signal } from '../types'
import SideBadge from './SideBadge'

function Ladder({ label, levels }: { label: string; levels: [number, number][] }) {
  if (!levels.length) return null
  const deepest = Math.max(...levels.map(([, size]) => size))
  return (
    <div className="flex-1">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">{label} bids</div>
      {levels.map(([price, size]) => (
        <div key={price} className="relative flex justify-between px-1 text-[11px] tabular-nums text-slate-300">
          <div className="absolute inset-y-0 left-0 bg-slate-700/40" style={{ width: `${(size / deepest) * 100}%` }} />
          <span className="relative">{pct(price, 0)}</span>
          <span className="relative text-slate-500">{Math.round(size)}</span>
        </div>
      ))}
    </div>
  )
}

/** Live edge for one market: model probability against the price of the better side. */
export default function SignalCard({ signal }: { signal: Signal }) {
  const { market, prediction, decision, quote } = signal
  const edgeTone = decision.actionable ? 'text-emerald-300' : 'text-slate-400'

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm leading-snug">
          {market.title}
          {market.subtitle && <span className="text-slate-400"> · {market.subtitle}</span>}
        </div>
        <SideBadge side={decision.side} />
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2 text-center">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-500">Model</div>
          <div className="text-sm tabular-nums">{pct(decision.p_win)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-500">Ask</div>
          <div className="text-sm tabular-nums">{pct(decision.price)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-500">Edge Δ</div>
          <div className={`text-sm font-semibold tabular-nums ${edgeTone}`}>{signedPct(decision.edge)}</div>
        </div>
      </div>

      {(quote.yes_bids.length > 0 || quote.no_bids.length > 0) && (
        <div className="mt-2 flex gap-3">
          <Ladder label="Yes" levels={quote.yes_bids} />
          <Ladder label="No" levels={quote.no_bids} />
        </div>
      )}

      <p className="mt-2 text-xs text-slate-400">{prediction.rationale}</p>
      <div className="mt-1 text-[11px] text-slate-500">
        Confidence {pct(prediction.confidence, 0)}
        {!decision.actionable && decision.reason && ` · not staged: ${decision.reason}`}
      </div>
    </div>
  )
}
