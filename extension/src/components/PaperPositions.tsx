import { pct, usd } from '../lib/format'
import type { Paper } from '../types'

/** The PORTFOLIO tab: simulated holdings, valued at what selling now would fetch. */
export default function PaperPositions({ paper }: { paper: Paper }) {
  const value = paper.positions.reduce((sum, p) => sum + (p.value_usd ?? p.stake_usd), 0)

  return (
    <div className="row col-12">
      <div className="col-12">
        <label>Simulated portfolio</label>
        <p>
          {usd(paper.cash_usd)} cash · {usd(value)} in positions · started with {usd(paper.bankroll_usd)}
        </p>
        {paper.error && <div className="alert alert-warning">{paper.error}</div>}
        {!paper.positions.length && <p>No simulated trades yet. Analyse an event, then buy from its verdict.</p>}
        {paper.positions.length > 0 && (
          <table>
            <tbody>
              {paper.positions.map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.question}
                    <br />
                    {p.side.toUpperCase()} · {p.contracts.toFixed(2)} at {pct(p.price, 0)} · paid {usd(p.stake_usd)}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap', color: (p.pnl_usd ?? 0) >= 0 ? 'cyan' : '#ffb3b3' }}>
                    {p.pnl_usd === null ? '' : `${p.pnl_usd >= 0 ? '+' : '−'}${usd(Math.abs(p.pnl_usd))}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
