import time

import httpx

from ..config import Settings
from ..models import Market
from .metadata import get_with_backoff
from .orderbook import OrderBookMirror
from .select import closes_soon_enough, in_price_band

MAX_MARKET_PAGES = 6
POPULAR_TTL_S = 600
MARKETS_PER_PAGE = 1000
TICKERS_PER_REQUEST = 50


def _volume(raw: dict) -> float:
    try:
        return float(raw.get("volume_24h_fp") or 0)
    except (TypeError, ValueError):
        return 0.0


def _apply_quote(mirror: OrderBookMirror, raw: dict) -> None:
    mirror.update_prices(
        raw["ticker"],
        raw.get("yes_bid_dollars"),
        raw.get("yes_ask_dollars"),
        raw.get("no_bid_dollars"),
        raw.get("no_ask_dollars"),
    )


def parse_market(raw: dict) -> Market | None:
    """Plain binary markets only; multivariate combo markets have no usable question."""
    if raw.get("status") != "active" or raw.get("market_type") != "binary" or raw.get("mve_collection_ticker"):
        return None
    return Market(
        ticker=raw["ticker"],
        event_ticker=raw.get("event_ticker", ""),
        title=raw.get("title", ""),
        subtitle=raw.get("yes_sub_title") or "",
        rules=" ".join(filter(None, [raw.get("rules_primary"), raw.get("rules_secondary")])),
        open_time=raw.get("open_time") or "",
        close_time=raw.get("close_time") or "",
        early_close=raw.get("early_close_condition") or "",
    )


class KalshiClient:
    """Keyless market data straight from Kalshi, used when there is no DFlow API key.

    It carries the same tickers and prices DFlow tokenizes, but not the Solana outcome
    mints, so markets from here can be forecast and scored but not traded.
    """

    tradable = False

    def __init__(self, settings: Settings, http: httpx.AsyncClient):
        self.settings = settings
        self.http = http
        self._ranked_at = 0.0
        self._ranked: list[tuple[Market, dict]] = []

    async def _rank(self, mirror: OrderBookMirror) -> list[tuple[Market, dict]]:
        """Open markets inside the price band and close window, most traded first, a few per event."""
        if self._ranked and time.time() - self._ranked_at < POPULAR_TTL_S:
            return self._ranked
        candidates: list[dict] = []
        for series in self.settings.series_tickers or [None]:
            candidates.extend(await self._open_markets(series))

        ranked: list[tuple[Market, dict]] = []
        per_event: dict[str, int] = {}
        for raw in sorted(candidates, key=_volume, reverse=True):
            market = parse_market(raw)
            if market is None or not closes_soon_enough(market.close_time, self.settings):
                continue
            if per_event.get(market.event_ticker, 0) >= self.settings.max_per_event:
                continue
            _apply_quote(mirror, raw)
            if not in_price_band(mirror.get(market.ticker), self.settings):
                continue
            per_event[market.event_ticker] = per_event.get(market.event_ticker, 0) + 1
            ranked.append((market, raw))
            if len(ranked) >= 100:
                break
        self._ranked, self._ranked_at = ranked, time.time()
        return ranked

    async def list_active_markets(self, mirror: OrderBookMirror) -> list[Market]:
        """The most traded open markets over the last 24 hours."""
        return [market for market, _ in (await self._rank(mirror))[: self.settings.max_markets]]

    async def popular(self, mirror: OrderBookMirror, limit: int = 20) -> list[dict]:
        """The same ranking as a browsable list, in the shape search results use."""
        return [
            {
                "ticker": market.ticker,
                "title": market.title,
                "subtitle": market.subtitle,
                "event_title": "",
                "yes_ask": raw.get("yes_ask_dollars"),
                "close_time": market.close_time,
            }
            for market, raw in (await self._rank(mirror))[:limit]
        ]

    async def search(self, query: str, limit: int = 12) -> list[dict]:
        """Text search over open markets, through the endpoint Kalshi's own site uses."""
        resp = await get_with_backoff(
            self.http,
            self.settings.kalshi_search_url,
            params={"query": query, "order_by": "querymatch", "page_size": limit},
            timeout=30,
        )
        hits: list[dict] = []
        for event in resp.json().get("current_page", []):
            for raw in event.get("markets") or []:
                if raw.get("result"):
                    continue
                hits.append(
                    {
                        "ticker": raw.get("ticker", ""),
                        "title": raw.get("title") or event.get("event_title", ""),
                        "subtitle": raw.get("yes_subtitle") or "",
                        "event_title": event.get("event_title", ""),
                        "yes_ask": raw.get("yes_ask_dollars"),
                        "close_time": raw.get("close_ts") or "",
                    }
                )
        return [h for h in hits if h["ticker"]][:limit]

    async def get_market(self, ticker: str, mirror: OrderBookMirror) -> Market | None:
        resp = await get_with_backoff(self.http, f"{self.settings.kalshi_url}/markets/{ticker}", timeout=30)
        raw = resp.json().get("market") or {}
        market = parse_market(raw) if raw else None
        if market:
            _apply_quote(mirror, raw)
        return market

    async def _open_markets(self, series: str | None) -> list[dict]:
        """Open markets closing inside the configured window, asked for directly so the
        sample is not whatever happens to sit on the first pages of the full listing."""
        now = int(time.time())
        params = {"status": "open", "limit": MARKETS_PER_PAGE, "mve_filter": "exclude", "min_close_ts": now}
        if self.settings.max_days_to_close > 0:
            params["max_close_ts"] = now + int(self.settings.max_days_to_close * 86400)
        if series:
            params["series_ticker"] = series

        found: list[dict] = []
        for _ in range(MAX_MARKET_PAGES):
            resp = await get_with_backoff(self.http, f"{self.settings.kalshi_url}/markets", params=params, timeout=60)
            body = resp.json()
            found.extend(body.get("markets", []))
            if not body.get("cursor"):
                break
            params["cursor"] = body["cursor"]
        return found

    async def refresh_quotes(self, markets: list[Market], mirror: OrderBookMirror) -> None:
        await self.refresh_tickers([m.ticker for m in markets], mirror)

    async def refresh_tickers(self, tickers: list[str], mirror: OrderBookMirror) -> None:
        for start in range(0, len(tickers), TICKERS_PER_REQUEST):
            batch = tickers[start : start + TICKERS_PER_REQUEST]
            resp = await get_with_backoff(
                self.http, f"{self.settings.kalshi_url}/markets", params={"tickers": ",".join(batch)}, timeout=30
            )
            for raw in resp.json().get("markets", []):
                _apply_quote(mirror, raw)
