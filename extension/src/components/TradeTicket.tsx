import { useEffect, useState } from 'react'
import { eventLabel, pct, signedPct, usd } from '../lib/format'
import type { StagedTrade } from '../types'
import SideBadge from './SideBadge'

type Props = {
  trade: StagedTrade
  wallet: string | null
  onSign: (trade: StagedTrade) => Promise<void>
  onReject: (trade: StagedTrade) => void
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
    <div className="card mb-2 border-success">
      <div className="card-body p-2">
        <SideBadge side={decision.side} /> <strong>{eventLabel(market.title, market.subtitle)}</strong>
        <table className="table table-sm mt-2 mb-2">
          <tbody>
            <tr><td>Edge Δ at quoted fill</td><td className="text-right text-success">{signedPct(trade.effective_edge)}</td></tr>
            <tr><td>Model probability</td><td className="text-right">{pct(decision.p_win)}</td></tr>
            <tr><td>Fill price</td><td className="text-right">{pct(trade.effective_price)}</td></tr>
            <tr><td>Spend</td><td className="text-right">{usd(trade.spend_usd)}</td></tr>
            <tr><td>Contracts (min)</td><td className="text-right">{trade.expected_contracts.toFixed(2)} ({trade.min_contracts.toFixed(2)})</td></tr>
            <tr><td>Payout if correct</td><td className="text-right">{usd(trade.est_payout_usd)}</td></tr>
            <tr><td>Dry run: compute units</td><td className="text-right">{simulation.units_consumed?.toLocaleString() ?? '?'} / {simulation.compute_unit_limit?.toLocaleString() ?? '?'}</td></tr>
            <tr><td>Dry run: USDC change</td><td className="text-right">{simulation.usdc_delta === null ? '?' : usd(simulation.usdc_delta)}</td></tr>
            <tr><td>Dry run: contracts received</td><td className="text-right">{simulation.fill_checked ? (simulation.outcome_delta ?? 0).toFixed(2) : 'fills after signing'}</td></tr>
          </tbody>
        </table>
        <small className="text-muted">{prediction.rationale}</small>
        {!walletMatches && <div className="alert alert-warning mt-2">Built for a different wallet. Reconnect to restage.</div>}
        {error && <div className="alert alert-danger mt-2">{error}</div>}
        <div className="mt-2">
          <button className="btn btn-success" onClick={sign} disabled={!canSign}>
            {busy ? 'Waiting for wallet…' : secondsLeft > 0 ? `Sign & Execute (${secondsLeft}s)` : 'Expired'}
          </button>{' '}
          <button className="btn btn-light" onClick={() => onReject(trade)} disabled={busy}>
            Reject
          </button>
        </div>
      </div>
    </div>
  )
}
