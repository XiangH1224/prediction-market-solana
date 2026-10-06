import { useEffect, useState } from 'react'
import { pct, signedPct, usd } from '../lib/format'
import type { StagedTrade } from '../types'
import SideBadge from './SideBadge'

type Props = {
  trade: StagedTrade
  wallet: string | null
  onSign: (trade: StagedTrade) => Promise<void>
  onReject: (trade: StagedTrade) => void
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-xs">
      <span className="text-slate-400">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  )
}

function useSecondsLeft(expiresAt: number) {
  const remaining = () => Math.max(0, Math.round(expiresAt - Date.now() / 1000))
  const [left, setLeft] = useState(remaining)
  useEffect(() => {
    const timer = setInterval(() => setLeft(remaining()), 1000)
    return () => clearInterval(timer)
  }, [expiresAt])
  return left
}

/** A trade the orchestrator has already dry-run. Signing sends exactly that transaction. */
export default function TradeTicket({ trade, wallet, onSign, onReject }: Props) {
  const { market, prediction, decision, simulation } = trade
  const secondsLeft = useSecondsLeft(trade.expires_at)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const walletMatches = wallet === trade.wallet
  const canSign = simulation.ok && walletMatches && secondsLeft > 0 && !busy

  const sign = async () => {
    setBusy(true)
    setError(null)
    try {
      await onSign(trade)
    } catch (e: any) {
      setError(String(e?.message ?? e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border border-emerald-700/60 bg-slate-900 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-medium leading-snug">
          {market.title}
          {market.subtitle && <span className="text-slate-400"> · {market.subtitle}</span>}
        </div>
        <SideBadge side={decision.side} />
      </div>

      <div className="mt-2 flex items-baseline justify-between">
        <span className="text-[11px] uppercase tracking-wide text-slate-500">Edge Δ at quoted fill</span>
        <span className="text-lg font-semibold tabular-nums text-emerald-300">{signedPct(trade.effective_edge)}</span>
      </div>

      <div className="mt-2 space-y-1">
        <Row label="Model probability" value={pct(decision.p_win)} />
        <Row label="Fill price" value={pct(trade.effective_price)} />
        <Row label="Spend" value={usd(trade.spend_usd)} />
        <Row label="Contracts (min)" value={`${trade.expected_contracts.toFixed(2)} (${trade.min_contracts.toFixed(2)})`} />
        <Row label="Payout if correct" value={usd(trade.est_payout_usd)} />
      </div>

      <div className="mt-2 space-y-1 rounded border border-slate-800 bg-slate-950/60 p-2">
        <div className="text-[10px] uppercase tracking-wide text-slate-500">Dry run on mainnet</div>
        <Row
          label="Compute units"
          value={`${simulation.units_consumed?.toLocaleString() ?? '?'} / ${simulation.compute_unit_limit?.toLocaleString() ?? '?'}`}
        />
        <Row label="USDC change" value={simulation.usdc_delta === null ? '?' : usd(simulation.usdc_delta)} />
        <Row
          label="Contracts received"
          value={simulation.fill_checked ? (simulation.outcome_delta ?? 0).toFixed(2) : 'fills after signing'}
        />
      </div>

      <p className="mt-2 text-xs text-slate-400">{prediction.rationale}</p>

      {!walletMatches && <p className="mt-2 text-xs text-amber-300">Built for a different wallet. Reconnect to restage.</p>}
      {error && <p className="mt-2 text-xs text-rose-300">{error}</p>}

      <div className="mt-3 flex gap-2">
        <button
          className="flex-1 rounded bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white enabled:hover:bg-emerald-500 disabled:opacity-40"
          onClick={sign}
          disabled={!canSign}
        >
          {busy ? 'Waiting for wallet…' : secondsLeft > 0 ? `Sign & Execute (${secondsLeft}s)` : 'Expired'}
        </button>
        <button
          className="rounded border border-slate-700 px-3 py-1.5 text-sm text-slate-300 enabled:hover:bg-slate-800 disabled:opacity-40"
          onClick={() => onReject(trade)}
          disabled={busy}
        >
          Reject
        </button>
      </div>
    </div>
  )
}
