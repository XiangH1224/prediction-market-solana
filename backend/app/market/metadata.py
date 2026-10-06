import asyncio
import logging

import httpx

from ..config import USDC_MINT, Settings
from ..models import Market
from .orderbook import OrderBookMirror

log = logging.getLogger(__name__)

MAX_RETRIES = 5


async def get_with_backoff(client: httpx.AsyncClient, url: str, **kwargs) -> httpx.Response:
    """GET that waits out 429s and transient 5xx with exponential backoff."""
    delay = 1.0
    for attempt in range(MAX_RETRIES):
        resp = await client.get(url, **kwargs)
        if resp.status_code != 429 and resp.status_code < 500:
            resp.raise_for_status()
            return resp
        if attempt == MAX_RETRIES - 1:
            resp.raise_for_status()
        retry_after = resp.headers.get("retry-after")
        wait = float(retry_after) if retry_after and retry_after.isdigit() else delay
        log.warning("%s returned %s, retrying in %.1fs", url, resp.status_code, wait)
        await asyncio.sleep(wait)
        delay = min(delay * 2, 30)
    raise RuntimeError("unreachable")


class MetadataClient:
    tradable = True

    def __init__(self, settings: Settings, http: httpx.AsyncClient):
        self.settings = settings
        self.http = http

    @property
    def _headers(self) -> dict:
        return {"x-api-key": self.settings.dflow_api_key} if self.settings.dflow_api_key else {}

    async def list_active_markets(self, mirror: OrderBookMirror) -> list[Market]:
        """Fetch active events with nested markets, seeding the mirror with their quotes."""
        markets: list[Market] = []
        cursor = None
        while len(markets) < self.settings.max_markets:
            params = {"status": "active", "withNestedMarkets": "true", "limit": 100}
            if self.settings.series_tickers:
                params["seriesTickers"] = ",".join(self.settings.series_tickers)
            if cursor:
                params["cursor"] = cursor
            resp = await get_with_backoff(
                self.http, f"{self.settings.dflow_metadata_url}/api/v1/events", params=params, headers=self._headers, timeout=30
            )
            body = resp.json()
            for event in body.get("events", []):
                for raw in event.get("markets") or []:
                    market = parse_market(event, raw)
                    if market is None:
                        continue
                    markets.append(market)
                    mirror.update_prices(
                        market.ticker, raw.get("yesBid"), raw.get("yesAsk"), raw.get("noBid"), raw.get("noAsk")
                    )
            cursor = body.get("cursor")
            if not cursor:
                break
        return markets[: self.settings.max_markets]

    async def refresh_quotes(self, markets: list[Market], mirror: OrderBookMirror) -> None:
        """The websocket stream keeps quotes current; only fill in markets it has not reached."""
        for market in markets:
            if mirror.get(market.ticker) is None:
                await self.refresh_orderbook(market.ticker, mirror)

    async def refresh_orderbook(self, ticker: str, mirror: OrderBookMirror) -> None:
        resp = await get_with_backoff(
            self.http, f"{self.settings.dflow_metadata_url}/api/v1/orderbook/{ticker}", headers=self._headers, timeout=30
        )
        body = resp.json()
        mirror.update_ladders(ticker, body.get("yes_bids"), body.get("no_bids"))


def parse_market(event: dict, raw: dict) -> Market | None:
    """Keep only active markets whose USDC-settled outcome mints are initialized on-chain."""
    if raw.get("status", "active") != "active":
        return None
    account = (raw.get("accounts") or {}).get(USDC_MINT)
    if not account or not account.get("isInitialized") or not account.get("yesMint") or not account.get("noMint"):
        return None
    return Market(
        ticker=raw["ticker"],
        event_ticker=event.get("ticker", ""),
        title=raw.get("title") or event.get("title", ""),
        subtitle=raw.get("yesSubTitle") or raw.get("subtitle") or "",
        rules=raw.get("rulesPrimary") or "",
        open_time=str(raw.get("openTime") or ""),
        close_time=str(raw.get("closeTime") or ""),
        early_close=raw.get("earlyCloseCondition") or "",
        yes_mint=account["yesMint"],
        no_mint=account["noMint"],
    )
