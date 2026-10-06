import asyncio
import json
import logging

import websockets

from ..config import Settings
from .orderbook import OrderBookMirror

log = logging.getLogger(__name__)


def apply_message(mirror: OrderBookMirror, msg: dict) -> str | None:
    """Apply one stream message to the mirror. Returns the ticker it touched, if any."""
    ticker = msg.get("market_ticker")
    if not ticker:
        return None
    channel = msg.get("channel")
    if channel == "prices":
        mirror.update_prices(ticker, msg.get("yes_bid"), msg.get("yes_ask"), msg.get("no_bid"), msg.get("no_ask"))
        return ticker
    if channel == "orderbook":
        mirror.update_ladders(ticker, msg.get("yes_bids"), msg.get("no_bids"))
        return ticker
    return None


async def run_price_stream(settings: Settings, mirror: OrderBookMirror, tickers: list[str]) -> None:
    """Keep the mirror current from DFlow's websocket, reconnecting with backoff."""
    headers = {"x-api-key": settings.dflow_api_key} if settings.dflow_api_key else {}
    delay = 1.0
    while True:
        try:
            async with websockets.connect(settings.dflow_metadata_ws_url, additional_headers=headers) as ws:
                for channel in ("prices", "orderbook"):
                    await ws.send(json.dumps({"type": "subscribe", "channel": channel, "tickers": tickers}))
                log.info("price stream connected, %d tickers", len(tickers))
                delay = 1.0
                async for raw in ws:
                    try:
                        apply_message(mirror, json.loads(raw))
                    except (ValueError, AttributeError):
                        continue
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning("price stream dropped (%s), reconnecting in %.0fs", exc, delay)
            await asyncio.sleep(delay)
            delay = min(delay * 2, 60)
