import { useEffect, useState } from 'react'
import { pct, signedPct, usd } from '../lib/format'
import type { Analysis } from '../types'

export type OutputTab = 'verdict' | 'sources'

type Props = {
  analysis: Analysis
  view: OutputTab
  onBuy: (ticker: string) => void
  onPass: (ticker: string) => void
  onCancel: (ticker: string) => void
}

function Elapsed({ since }: { since?: number }) {
  const [now, setNow] = useState(Date.now() / 1000)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() / 1000), 1000)
    return () => clearInterval(timer)
  }, [])
  return since ? <> · {Math.max(0, Math.round(now - since))}s</> : null
}

/** What the results pane shows for one event: the verdict and reasoning, or its sources. */
export default function AnalysisCard({ analysis, view, onBuy, onPass, onCancel }: Props) {
  if (analysis.state === 'cancelled') return null

  if (analysis.state === 'running') {
    return (
      <div>
        <h4>
          <i className="fa fa-circle-notch fa-spin fa-sm pulse" /> {analysis.stage ?? 'Starting'}…
          <Elapsed since={analysis.started_at} />
        </h4>
        <p className="text-muted">Usually one to two minutes. Other events you pick wait their turn.</p>
        <button className="btn btn-sm btn-secondary" onClick={() => onCancel(analysis.ticker)}>
          Cancel
        </button>
      </div>
    )
  }

  if (analysis.state === 'error') {
    return (
      <div>
        <div className="alert alert-warning">{analysis.error}</div>
        <button className="btn btn-sm btn-secondary" onClick={() => onPass(analysis.ticker)}>
          Dismiss
        </button>
      </div>
    )
  }

  const { prediction, decision, verdict } = analysis

  if (view === 'sources') {
    return (
      <div>
        <h5 style={{ marginTop: 0 }}>
          Based on {analysis.sources.length} news {analysis.sources.length === 1 ? 'source' : 'sources'}
        </h5>
        {analysis.sources.length === 0 ? (
          <p className="text-muted">No recent news was found, so this verdict rests on the rules alone.</p>
        ) : (
          <ul>
            {analysis.sources.map((source) => (
              <li key={source.url}>
                <a href={source.url} target="_blank" rel="noreferrer">
                  {source.title || source.url}
                </a>
                {source.date && <span className="text-muted"> · {source.date.slice(0, 16)}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  return (
    <div>
      <h2 className={verdict.invest ? 'text-success' : ''}>{verdict.headline}</h2>
      <p>{verdict.detail}</p>

      {decision && (
        <table className="figures" style={{ width: '100%' }}>
          <tbody>
            <tr>
              <td>
                <small>Model ({decision.side})</small>
                <big>{pct(decision.p_win)}</big>
              </td>
              <td>
                <small>Price</small>
                <big>{pct(decision.price)}</big>
              </td>
              <td>
                <small>Edge Δ</small>
                <big>{signedPct(decision.edge)}</big>
              </td>
            </tr>
          </tbody>
        </table>
      )}

      <p style={{ marginTop: 14 }}>
        {decision && analysis.paper_stake_usd > 0 && (
          <button className={`btn ${verdict.invest ? 'btn-success' : 'btn-secondary'}`} onClick={() => onBuy(analysis.ticker)}>
            {verdict.invest ? 'Buy' : 'Buy anyway'} {decision.side.toUpperCase()} {usd(analysis.paper_stake_usd)} (simulated)
          </button>
        )}{' '}
        <button className="btn btn-light" onClick={() => onPass(analysis.ticker)}>
          Pass
        </button>
      </p>

      <h5>Reasoning</h5>
      <p>{prediction.rationale}</p>
      <p className="text-muted">
        Based on {analysis.sources.length} news {analysis.sources.length === 1 ? 'source' : 'sources'}; see the SOURCES tab.
      </p>
    </div>
  )
}
