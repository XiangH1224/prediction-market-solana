import { useEffect, useState } from 'react'
import AnalysisCard from './components/AnalysisCard'
import PaperPositions from './components/PaperPositions'
import SearchPanel from './components/SearchPanel'
import SignalCard from './components/SignalCard'
import TradeTicket from './components/TradeTicket'
import { shortAddress } from './lib/format'
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
      className="space-y-2 rounded-lg border border-slate-800 bg-slate-900 p-3"
      onSubmit={(e) => {
        e.preventDefault()
        onSave(draft.trim())
      }}
    >
      <label className="block text-xs text-slate-400" htmlFor="token">
        This backend has PANEL_TOKEN set. Paste its value to connect.
      </label>
      <input
        id="token"
        className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        autoComplete="off"
      />
      <button className="rounded bg-slate-200 px-3 py-1 text-sm font-medium text-slate-900 disabled:opacity-40" disabled={!draft.trim()}>
        Save token
      </button>
    </form>
  )
}

export default function App() {
  const [token, setToken] = useState('')
  const [wallet, setWallet] = useState<string | null>(null)
  const [walletError, setWalletError] = useState<string | null>(null)
  const [passed, setPassed] = useState<string[]>([])
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

  const analyse = (ticker: string) => {
    setPassed((p) => p.filter((t) => t !== ticker))
    send({ type: 'analyze', ticker })
  }
  const buy = (ticker: string) => {
    send({ type: 'paper_buy', ticker })
    setPassed((p) => [...p, ticker])
  }
  const analyses = Object.values(feed.analyses).filter((a) => !passed.includes(a.ticker))

  const signals = Object.values(feed.signals).sort((a, b) => b.decision.edge - a.decision.edge)
  const notice = banner(feed.connection, feed.status)

  return (
    <div className="mx-auto flex max-w-md flex-col gap-3 p-3">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-sm font-semibold">Prediction terminal</h1>
          <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
            <span className={`h-1.5 w-1.5 rounded-full ${feed.connection === 'open' ? 'bg-emerald-400' : 'bg-amber-400'}`} />
            {CONNECTION_LABEL[feed.connection]}
            {feed.status && feed.connection === 'open' && ` · ${feed.status.markets} markets`}
          </div>
        </div>
        <button
          className="rounded border border-slate-700 px-2 py-1 text-xs hover:bg-slate-800"
          onClick={wallet ? () => setWallet(null) : connect}
          title={wallet ? 'Disconnect' : undefined}
        >
          {wallet ? shortAddress(wallet) : 'Connect wallet'}
        </button>
      </header>

      {feed.connection === 'unauthorized' && <TokenForm onSave={updateToken} />}
      {notice && <div className="rounded border border-amber-700/50 bg-amber-950/40 p-2 text-xs text-amber-200">{notice}</div>}
      {walletError && <div className="rounded border border-rose-700/50 bg-rose-950/40 p-2 text-xs text-rose-200">{walletError}</div>}

      {feed.connection === 'open' && (
        <>
          <SearchPanel results={feed.search} browse={feed.browse} onSearch={(query) => send({ type: 'search', query })} onAnalyze={analyse} />
          {analyses.map((analysis) => (
            <AnalysisCard
              key={analysis.ticker}
              analysis={analysis}
              onBuy={buy}
              onPass={(ticker) => setPassed((p) => [...p, ticker])}
              onCancel={(ticker) => send({ type: 'cancel_analysis', ticker })}
            />
          ))}
          {feed.paper && <PaperPositions paper={feed.paper} />}
        </>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Staged trades</h2>
        {feed.trades.map((trade) => (
          <TradeTicket
            key={trade.id}
            trade={trade}
            wallet={wallet}
            onSign={sign}
            onReject={(t) => send({ type: 'rejected', id: t.id })}
          />
        ))}
        {!feed.trades.length && (
          <p className="text-xs text-slate-500">
            {feed.status?.signals_only
              ? 'On-chain trading is off: the backend has no DFLOW_API_KEY. Use the simulated buy above.'
              : wallet
                ? 'Nothing staged. Trades appear here once they clear the hurdle and pass a dry run.'
                : 'Connect a wallet so trades can be sized and dry-run for it.'}
          </p>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Live edge</h2>
        {signals.map((signal) => (
          <SignalCard key={signal.market.ticker} signal={signal} />
        ))}
        {!signals.length && (
          <p className="text-xs text-slate-500">
            {feed.status?.markets ? 'No markets evaluated yet.' : 'Automatic scanning is off (MAX_MARKETS=0). Pick an event above to analyse it.'}
          </p>
        )}
      </section>
    </div>
  )
}
