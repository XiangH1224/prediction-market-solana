import { useState } from 'react'
import { eventLabel, pct } from '../lib/format'
import type { SearchResults } from '../types'

type Props = {
  results: SearchResults | null
  browse: SearchResults | null
  selected: string | null
  onSearch: (query: string) => void
  onAnalyze: (ticker: string) => void
}

/** The SEARCH tab: the search terms box and the event list under it. */
export default function SearchPanel({ results, browse, selected, onSearch, onAnalyze }: Props) {
  const [query, setQuery] = useState('')
  const [searched, setSearched] = useState(false)
  const showingSearch = searched && query.trim() !== ''
  const shown = showingSearch ? results : browse

  return (
    <div id="tab_search">
      <form
        className="row col-12"
        onSubmit={(e) => {
          e.preventDefault()
          if (!query.trim()) return
          setSearched(true)
          onSearch(query.trim())
        }}
      >
        <div className="col-12">
          <label htmlFor="query">Search terms</label>
          <input
            className="col-12"
            type="text"
            id="query"
            value={query}
            title="Search open Kalshi markets, then press Enter"
            onChange={(e) => {
              setQuery(e.target.value)
              if (!e.target.value.trim()) setSearched(false)
            }}
          />
        </div>
      </form>

      <div className="row col-12">
        <div className="col-12">
          <label>{showingSearch ? `Results for “${results?.query ?? query}”` : 'Popular on Kalshi'}</label>
          {!shown && <p>Loading events…</p>}
          {shown?.error && <div className="alert alert-warning">Could not load events: {shown.error}</div>}
          {shown && !shown.error && shown.results.length === 0 && <p>No open Kalshi markets found.</p>}
          {shown && shown.results.length > 0 && (
            <div className="event-list">
              {shown.results.map((hit) => (
                <div
                  key={hit.ticker}
                  role="button"
                  tabIndex={0}
                  className={`option ${hit.ticker === selected ? 'selected' : ''}`}
                  title="Analyse this event"
                  onClick={() => onAnalyze(hit.ticker)}
                  onKeyDown={(e) => e.key === 'Enter' && onAnalyze(hit.ticker)}
                >
                  {eventLabel(hit.title, hit.subtitle)}
                  <small>
                    {hit.yes_ask ? `Yes ${pct(Number(hit.yes_ask), 0)}` : 'No price'}
                    {hit.close_time && ` · closes ${hit.close_time.slice(0, 10)}`}
                  </small>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
