// Mirrors backend/app/models.py.

export type Side = 'yes' | 'no'

export type Market = {
  ticker: string
  title: string
  subtitle: string
  close_time: string
}

export type Prediction = {
  p_true: number
  confidence: number
  rationale: string
}

export type EdgeDecision = {
  side: Side
  p_win: number
  price: number
  edge: number
  actionable: boolean
  reason: string
  stake_usd: number
  contracts: number
}

export type Quote = {
  yes_bid: number | null
  yes_ask: number | null
  no_bid: number | null
  no_ask: number | null
  yes_bids: [number, number][]
  no_bids: [number, number][]
}

export type Signal = {
  market: Market
  prediction: Prediction
  decision: EdgeDecision
  quote: Quote
}

export type SimulationReport = {
  ok: boolean
  failures: string[]
  units_consumed: number | null
  compute_unit_limit: number | null
  usdc_delta: number | null
  outcome_delta: number | null
  fill_checked: boolean
}

export type StagedTrade = {
  id: string
  market: Market
  prediction: Prediction
  decision: EdgeDecision
  simulation: SimulationReport
  tx_base64: string
  wallet: string
  spend_usd: number
  expected_contracts: number
  min_contracts: number
  effective_price: number
  effective_edge: number
  est_payout_usd: number
  execution_mode: string
  expires_at: number
}

export type Status = {
  state: 'starting' | 'scanning' | 'missing_keys' | 'error'
  missing_keys: string[]
  signals_only: boolean
  markets: number
  wallet: string | null
  edge_hurdle: number
  last_error: string
}

export type SearchHit = {
  ticker: string
  title: string
  subtitle: string
  event_title: string
  yes_ask: string | null
  close_time: string
}

export type SearchResults = { query: string; results: SearchHit[]; error: string }

export type Verdict = { invest: boolean; headline: string; detail: string }

export type Analysis =
  | { ticker: string; state: 'running'; stage?: string; started_at?: number }
  | { ticker: string; state: 'cancelled' }
  | { ticker: string; state: 'error'; error: string }
  | {
      ticker: string
      state: 'done'
      market: Market
      prediction: Prediction
      decision: EdgeDecision | null
      quote: Quote
      verdict: Verdict
      sources: { title: string; url: string; date: string }[]
      paper_stake_usd: number
    }

export type PaperPosition = {
  id: string
  ticker: string
  question: string
  side: Side
  price: number
  contracts: number
  stake_usd: number
  value_usd: number | null
  pnl_usd: number | null
}

export type Paper = { cash_usd: number; bankroll_usd: number; positions: PaperPosition[]; error: string }

export type ServerMessage =
  | { type: 'status'; data: Status }
  | { type: 'search_results'; data: SearchResults }
  | { type: 'browse'; data: SearchResults }
  | { type: 'analysis'; data: Analysis }
  | { type: 'paper'; data: Paper }
  | { type: 'signal'; data: Signal }
  | { type: 'staged_trade'; data: StagedTrade }
  | { type: 'unstaged'; data: { id: string; reason: string } }

export type PanelMessage =
  | { type: 'hello'; wallet: string | null }
  | { type: 'search'; query: string }
  | { type: 'browse' }
  | { type: 'analyze' | 'paper_buy' | 'cancel_analysis'; ticker: string }
  | { type: 'approved' | 'rejected'; id: string }
  | { type: 'sent'; id: string; signature: string }
  | { type: 'send_failed'; id: string; error: string }
