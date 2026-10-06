import { useEffect, useState } from 'react'
import AnalysisCard, { type OutputTab } from './components/AnalysisCard'
import PaperPositions from './components/PaperPositions'
import SearchPanel from './components/SearchPanel'
import SignalCard from './components/SignalCard'
import TradeTicket from './components/TradeTicket'
import { eventLabel, shortAddress } from './lib/format'
import { useOrchestrator, type Connection } from './lib/socket'
import { loadToken, saveToken } from './lib/storage'
import { connectWallet, signAndSend } from './lib/wallet'
import type { StagedTrade, Status } from './types'

const CONNECTION_LABEL: Record<Connection, string> = {
  connecting: 'Connecting…',
  open: 'Connected',
  closed: 'Orchestrator offline, retrying',
  unauthorized: 'Token needed',
}

function banner(connection: Connection, status: Status | null): string | null {
  if (connection === 'closed') return 'Backend is not running. Start it with: .venv/bin/uvicorn app.main:app --port 8000'
  if (connection !== 'open' || !status) return null
  if (status.state === 'missing_keys') return `Backend is missing ${status.missing_keys.join(', ')} in its .env`
  if (status.last_error) return status.last_error
  return null
}

function TokenForm({ onSave }: { onSave: (token: string) => void }) {
  const [draft, setDraft] = useState('')
  return (
    <form
      className="row col-12"
      onSubmit={(e) => {
        e.preventDefault()
        onSave(draft.trim())
      }}
    >
      <div className="col-12">
        <label htmlFor="token">This backend has PANEL_TOKEN set. Paste its value to connect.</label>
        <input id="token" className="col-12" type="text" value={draft} onChange={(e) => setDraft(e.target.value)} autoComplete="off" />
        <button className="col-12 text-center" disabled={!draft.trim()}>
          Save token
        </button>
      </div>
    </form>
  )
}

export default function App() {
  const [token, setToken] = useState('')
  const [wallet, setWallet] = useState<string | null>(null)
  const [walletError, setWalletError] = useState<string | null>(null)
  const [inputTab, setInputTab] = useState<'search' | 'portfolio'>('search')
  const [outputTab, setOutputTab] = useState<OutputTab>('verdict')
  const [selected, setSelected] = useState<string | null>(null)
  const { feed, send } = useOrchestrator(token, wallet)

  useEffect(() => {
    loadToken().then(setToken)
  }, [])

  const updateToken = (next: string) => {
    saveToken(next)
    setToken(next)
  }

  const connect = async () => {
    setWalletError(null)
    try {
      setWallet((await connectWallet()).address)
    } catch (e: any) {
      setWalletError(String(e?.message ?? e))
    }
  }

  const sign = async (trade: StagedTrade) => {
    send({ type: 'approved', id: trade.id })
    try {
      const signature = await signAndSend(trade.wallet, trade.tx_base64)
      send({ type: 'sent', id: trade.id, signature })
    } catch (e: any) {
      send({ type: 'send_failed', id: trade.id, error: String(e?.message ?? e) })
      throw e
    }
  }

  const titles: Record<string, string> = {}
  for (const hit of [...(feed.browse?.results ?? []), ...(feed.search?.results ?? [])]) {
    titles[hit.ticker] = eventLabel(hit.title, hit.subtitle)
  }

  const analyse = (ticker: string) => {
    setSelected(ticker)
    setOutputTab('verdict')
    // A finished or running analysis is shown again as is; only a new event is sent for analysis.
    if (!feed.analyses[ticker] || feed.analyses[ticker].state === 'error') send({ type: 'analyze', ticker })
    // When the panels are stacked, the results pane is below the event list.
    if (window.innerWidth < 768) document.getElementById('main_panel')?.scrollIntoView({ behavior: 'smooth' })
  }
  const dismiss = (ticker: string) => {
    send({ type: 'cancel_analysis', ticker })
    if (selected === ticker) setSelected(null)
  }
  const buy = (ticker: string) => {
    send({ type: 'paper_buy', ticker })
    setInputTab('portfolio')
  }

  const current = selected ? feed.analyses[selected] : undefined
  const others = Object.values(feed.analyses).filter((a) => a.ticker !== selected && a.state !== 'cancelled')
  const signals = Object.values(feed.signals).sort((a, b) => b.decision.edge - a.decision.edge)
  const notice = banner(feed.connection, feed.status)
  const tradingOn = feed.status ? !feed.status.signals_only : false
  const title =
    current?.state === 'done'
      ? eventLabel(current.market.title, current.market.subtitle)
      : selected
        ? (titles[selected] ?? selected)
        : 'Pick an event'

  return (
    <>
      <nav className="navbar navbar-expand-sm bg-dark navbar-dark">
        <a className="navbar-brand" href="./" style={{ fontSize: '1.5em' }}>
          <i className="fa fa-chart-line fa-lg" /> &nbsp; Prediction Markets
        </a>
        <div className="navbar-status">
          <i className={`fa fa-circle ${feed.connection === 'open' ? 'ok' : ''}`} /> {CONNECTION_LABEL[feed.connection]}
          {tradingOn && (
            <button className="helpbutton btn-link" type="button" onClick={wallet ? () => setWallet(null) : connect}>
              <i className="fa fa-wallet fa-lg" /> {wallet ? shortAddress(wallet) : 'Connect wallet'}
            </button>
          )}
        </div>
      </nav>

      <div className="container-fluid" id="main_row">
        <div className="row">
          <div className="col-md-4 col-sm-12" id="side_panel">
            <p style={{ lineHeight: '100%', display: 'block', paddingTop: 4 }}>
              <a href="https://kalshi.com/" target="_blank" rel="noreferrer">
                Kalshi
              </a>{' '}
              is a regulated <em>prediction market</em>. Pick an event and this page reads the recent news, forecasts the
              outcome, and compares that with the live price. Purchases here use simulated money.
            </p>
            <hr />

            {feed.connection === 'unauthorized' && <TokenForm onSave={updateToken} />}
            {notice && <div className="alert alert-warning">{notice}</div>}
            {walletError && <div className="alert alert-warning">{walletError}</div>}

            {/* INPUT TABS */}
            <div className="row tab col-12">
              <button
                className={`inputTabLinks col-6 ${inputTab === 'search' ? 'active' : ''}`}
                title="SEARCH finds Kalshi events; without search terms it lists the most traded ones."
                onClick={() => setInputTab('search')}
              >
                SEARCH
              </button>
              <button
                className={`inputTabLinks col-6 ${inputTab === 'portfolio' ? 'active' : ''}`}
                title="PORTFOLIO lists your simulated purchases."
                onClick={() => setInputTab('portfolio')}
              >
                PORTFOLIO{feed.paper?.positions.length ? ` (${feed.paper.positions.length})` : ''}
              </button>
            </div>

            {feed.connection === 'open' && inputTab === 'search' && (
              <SearchPanel
                results={feed.search}
                browse={feed.browse}
                selected={selected}
                onSearch={(query) => send({ type: 'search', query })}
                onAnalyze={analyse}
              />
            )}
            {feed.connection === 'open' && inputTab === 'portfolio' && feed.paper && <PaperPositions paper={feed.paper} />}

            <div className="row col-12">
              <hr className="col-12" />
            </div>

            {/* OUTPUT TABS */}
            <div className="row tab col-12">
              <button
                className={`outputTabLinks col-6 ${outputTab === 'verdict' ? 'active' : ''}`}
                title="VERDICT shows whether to invest, and why."
                onClick={() => setOutputTab('verdict')}
              >
                VERDICT
              </button>
              <button
                className={`outputTabLinks col-6 ${outputTab === 'sources' ? 'active' : ''}`}
                title="SOURCES lists the news articles the verdict was based on."
                onClick={() => setOutputTab('sources')}
              >
                SOURCES{current?.state === 'done' ? ` (${current.sources.length})` : ''}
              </button>
            </div>
          </div>

          <div id="main_panel" className="col-md-8 col-sm-12">
            <div id="main_panel_title_row" className="row col-12">
              <h3 style={{ float: 'left', paddingTop: 10, paddingLeft: 10 }}>
                <i className="fa fa-search fa-sm" style={{ float: 'left', padding: 10, paddingLeft: 2, paddingTop: 15 }} />
                <div id="iframe_title">{title}</div>
              </h3>
            </div>

            <div id="iframe_container" className="row col-12">
              {current ? (
                <AnalysisCard analysis={current} view={outputTab} onBuy={buy} onPass={dismiss} onCancel={dismiss} />
              ) : (
                <p className="text-muted">
                  Choose an event from the list on the left, or search for one. Its verdict, the reasoning and the news
                  sources behind it appear here.
                </p>
              )}

              {others.length > 0 && (
                <>
                  <h5>Other analyses</h5>
                  <table className="table table-sm table-hover">
                    <tbody>
                      {others.map((a) => (
                        <tr key={a.ticker} style={{ cursor: 'pointer' }} onClick={() => setSelected(a.ticker)}>
                          <td>{a.state === 'done' ? eventLabel(a.market.title, a.market.subtitle) : (titles[a.ticker] ?? a.ticker)}</td>
                          <td className="text-muted text-right">
                            {a.state === 'running' ? (a.stage ?? 'Starting') : a.state === 'done' ? a.verdict.headline : 'Failed'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}

              {feed.trades.length > 0 && (
                <>
                  <h5>Staged trades</h5>
                  {feed.trades.map((trade) => (
                    <TradeTicket
                      key={trade.id}
                      trade={trade}
                      wallet={wallet}
                      onSign={sign}
                      onReject={(t) => send({ type: 'rejected', id: t.id })}
                    />
                  ))}
                </>
              )}

              {signals.length > 0 && (
                <>
                  <h5>Live edge from the automatic scan</h5>
                  {signals.map((signal) => (
                    <SignalCard key={signal.market.ticker} signal={signal} />
                  ))}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
