import { useCallback, useEffect, useRef, useState } from 'react'
import type { Analysis, PanelMessage, Paper, SearchResults, ServerMessage, Signal, StagedTrade, Status } from '../types'

// Served by the backend at /panel, the page talks to whichever port it came from.
const WS_URL = location.protocol === 'http:' ? `ws://${location.host}/ws` : 'ws://localhost:8000/ws'
const WS_UNAUTHORIZED = 4401
const RECONNECT_MS = 3000

export type Connection = 'connecting' | 'open' | 'closed' | 'unauthorized'

export type Feed = {
  connection: Connection
  status: Status | null
  signals: Record<string, Signal>
  trades: StagedTrade[]
  search: SearchResults | null
  browse: SearchResults | null
  analyses: Record<string, Analysis>
  paper: Paper | null
}

const EMPTY: Feed = {
  connection: 'connecting',
  status: null,
  signals: {},
  trades: [],
  search: null,
  browse: null,
  analyses: {},
  paper: null,
}

export function applyMessage(feed: Feed, message: ServerMessage): Feed {
  switch (message.type) {
    case 'status':
      return { ...feed, status: message.data }
    case 'signal':
      return { ...feed, signals: { ...feed.signals, [message.data.market.ticker]: message.data } }
    case 'staged_trade':
      return { ...feed, trades: [message.data, ...feed.trades.filter((t) => t.id !== message.data.id)] }
    case 'search_results':
      return { ...feed, search: message.data }
    case 'browse':
      return { ...feed, browse: message.data }
    case 'analysis': {
      if (message.data.state === 'cancelled') {
        const { [message.data.ticker]: _, ...rest } = feed.analyses
        return { ...feed, analyses: rest }
      }
      return { ...feed, analyses: { ...feed.analyses, [message.data.ticker]: message.data } }
    }
    case 'paper':
      return { ...feed, paper: message.data }
    case 'unstaged':
      return { ...feed, trades: feed.trades.filter((t) => t.id !== message.data.id) }
    default:
      return feed
  }
}

/** Live feed from the orchestrator. Reconnects on drop. A token is only needed if the backend sets PANEL_TOKEN. */
export function useOrchestrator(token: string, wallet: string | null) {
  const [feed, setFeed] = useState<Feed>(EMPTY)
  const socket = useRef<WebSocket | null>(null)
  const walletRef = useRef(wallet)
  walletRef.current = wallet

  const send = useCallback((message: PanelMessage) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message))
  }, [])

  useEffect(() => {
    let stopped = false
    let retry: ReturnType<typeof setTimeout> | undefined

    const connect = () => {
      setFeed((f) => ({ ...f, connection: 'connecting' }))
      const ws = new WebSocket(token ? `${WS_URL}?token=${encodeURIComponent(token)}` : WS_URL)
      socket.current = ws
      ws.onopen = () => {
        // A fresh socket means a fresh snapshot, so drop anything staged before the drop.
        setFeed({ ...EMPTY, connection: 'open' })
        ws.send(JSON.stringify({ type: 'hello', wallet: walletRef.current }))
        ws.send(JSON.stringify({ type: 'browse' }))
      }
      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as ServerMessage
          setFeed((f) => applyMessage(f, message))
        } catch (e) {
          console.warn('bad orchestrator message', e)
        }
      }
      ws.onclose = (event) => {
        if (stopped) return
        if (event.code === WS_UNAUTHORIZED) {
          setFeed({ ...EMPTY, connection: 'unauthorized' })
          return
        }
        setFeed({ ...EMPTY, connection: 'closed' })
        retry = setTimeout(connect, RECONNECT_MS)
      }
    }
    connect()

    return () => {
      stopped = true
      clearTimeout(retry)
      socket.current?.close()
    }
  }, [token])

  useEffect(() => {
    send({ type: 'hello', wallet })
  }, [wallet, send])

  return { feed, send }
}
