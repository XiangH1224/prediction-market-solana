import httpx
import pytest

from app.config import USDC_MINT, Settings
from app.market.metadata import MetadataClient, get_with_backoff, parse_market
from app.market.orderbook import OrderBookMirror
from app.market.stream import apply_message

EVENT = {
    "ticker": "KXEPLGAME-26FEB18WOLARS",
    "title": "Wolverhampton vs Arsenal",
    "markets": [
        {
            "ticker": "KXEPLGAME-26FEB18WOLARS-ARS",
            "title": "Wolverhampton vs Arsenal Winner?",
            "yesSubTitle": "Arsenal",
            "status": "active",
            "yesBid": "0.7600",
            "yesAsk": "0.7700",
            "noBid": "0.2300",
            "noAsk": "0.2400",
            "accounts": {
                USDC_MINT: {
                    "yesMint": "GPGgr29ektC4ZB2TsPpbWmmNiCtNjq3vospE8cLweH5U",
                    "noMint": "7fLxMYQdQRdTCVTDXzxaimt6rjXSpgogWYiBXVE78roi",
                    "isInitialized": True,
                }
            },
        },
        {"ticker": "UNINITIALIZED", "title": "x", "status": "active",
         "accounts": {USDC_MINT: {"yesMint": "a", "noMint": "b", "isInitialized": False}}},
        {"ticker": "CLOSED", "title": "x", "status": "finalized", "accounts": {}},
    ],
}


def test_parse_market_reads_usdc_outcome_mints():
    market = parse_market(EVENT, EVENT["markets"][0])
    assert market.yes_mint == "GPGgr29ektC4ZB2TsPpbWmmNiCtNjq3vospE8cLweH5U"
    assert market.mint("no") == "7fLxMYQdQRdTCVTDXzxaimt6rjXSpgogWYiBXVE78roi"
    assert market.question == "Wolverhampton vs Arsenal Winner? (Arsenal)"


def test_parse_market_skips_uninitialized_and_inactive():
    assert parse_market(EVENT, EVENT["markets"][1]) is None
    assert parse_market(EVENT, EVENT["markets"][2]) is None


def test_mirror_parses_dollar_string_prices():
    mirror = OrderBookMirror()
    quote = mirror.update_prices("T", "0.7600", "0.7700", "0.2300", None)
    assert (quote.yes_bid, quote.yes_ask, quote.no_bid, quote.no_ask) == (0.76, 0.77, 0.23, None)


def test_mirror_implies_asks_from_opposite_bids():
    mirror = OrderBookMirror()
    quote = mirror.update_ladders("T", {"0.7500": 10, "0.7600": 40}, {"0.2300": 5, "0.2000": 100})
    assert quote.yes_bids[0] == (0.76, 40)
    assert quote.yes_ask == pytest.approx(0.77)
    assert quote.no_ask == pytest.approx(0.24)


def test_stream_messages_update_the_mirror():
    mirror = OrderBookMirror()
    assert apply_message(mirror, {"channel": "prices", "market_ticker": "T", "yes_ask": "0.55", "no_ask": "0.47"}) == "T"
    assert mirror.get("T").yes_ask == 0.55
    assert apply_message(mirror, {"channel": "trades", "market_ticker": "T"}) is None
    assert apply_message(mirror, {"type": "subscribed"}) is None


async def test_list_active_markets_seeds_the_mirror():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["x-api-key"] == "k"
        assert request.url.params["withNestedMarkets"] == "true"
        return httpx.Response(200, json={"events": [EVENT], "cursor": None})

    mirror = OrderBookMirror()
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        markets = await MetadataClient(Settings(dflow_api_key="k"), http).list_active_markets(mirror)
    assert [m.ticker for m in markets] == ["KXEPLGAME-26FEB18WOLARS-ARS"]
    assert mirror.get("KXEPLGAME-26FEB18WOLARS-ARS").yes_ask == 0.77


async def test_backoff_retries_after_429(monkeypatch):
    calls = []

    async def no_sleep(_):
        return None

    monkeypatch.setattr("app.market.metadata.asyncio.sleep", no_sleep)

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(429) if len(calls) < 3 else httpx.Response(200, json={})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        resp = await get_with_backoff(http, "https://x.test/y")
    assert resp.status_code == 200 and len(calls) == 3


# -- keyless fallbacks ---------------------------------------------------------

from app.market.kalshi import KalshiClient
from app.prediction.search import gdelt_keywords, gdelt_search

KALSHI_MARKET = {
    "ticker": "KXWC-30-ESP", "event_ticker": "KXWC-30", "status": "active", "market_type": "binary",
    "title": "Will Spain win the 2030 FIFA Men's World Cup?", "yes_sub_title": "Spain",
    "rules_primary": "If Spain is the champion, then the market resolves to Yes.", "close_time": "",
    "yes_bid_dollars": "0.1250", "yes_ask_dollars": "0.1430", "no_bid_dollars": "0.8570", "no_ask_dollars": "0.8750",
    "volume_24h_fp": "2580.03",
}


async def test_kalshi_source_ranks_by_volume_and_skips_combo_markets():
    quiet = {**KALSHI_MARKET, "ticker": "QUIET", "volume_24h_fp": "1.00"}
    combo = {**KALSHI_MARKET, "ticker": "COMBO", "volume_24h_fp": "99999", "mve_collection_ticker": "KXMVE-R"}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params["mve_filter"] == "exclude" and "max_close_ts" in request.url.params
        return httpx.Response(200, json={"markets": [quiet, combo, KALSHI_MARKET], "cursor": ""})

    mirror = OrderBookMirror()
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = KalshiClient(Settings(max_markets=5), http)
        markets = await client.list_active_markets(mirror)
    assert [m.ticker for m in markets] == ["KXWC-30-ESP", "QUIET"]
    assert markets[0].yes_mint == "" and not client.tradable
    assert mirror.get("KXWC-30-ESP").yes_ask == 0.143 and mirror.get("KXWC-30-ESP").no_ask == 0.875


async def test_kalshi_source_filters_long_shots_far_closes_and_event_crowding():
    def m(ticker, **over):
        return {**KALSHI_MARKET, "ticker": ticker, **over}

    raws = [
        m("LONGSHOT", yes_ask_dollars="0.0060", volume_24h_fp="900"),
        m("FAR", close_time="2031-01-15T03:00:00Z", volume_24h_fp="800"),
        m("A1", volume_24h_fp="700"), m("A2", volume_24h_fp="600"), m("A3", volume_24h_fp="500"),
        m("B1", event_ticker="OTHER", volume_24h_fp="400"),
    ]
    handler = lambda r: httpx.Response(200, json={"markets": raws, "cursor": ""})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        markets = await KalshiClient(Settings(max_markets=10, max_per_event=2), http).list_active_markets(OrderBookMirror())
    assert [x.ticker for x in markets] == ["A1", "A2", "B1"]


def test_gdelt_keywords_prefer_names_and_years():
    assert gdelt_keywords("Will Spain win the 2030 FIFA Men's World Cup? (Spain)") == ["Spain", "2030", "FIFA", "Men's"]


async def test_gdelt_search_maps_headlines_and_tolerates_text_errors(monkeypatch):
    monkeypatch.setattr("app.prediction.search.GDELT_MIN_INTERVAL_S", 0)
    replies = iter([
        httpx.Response(200, json={"articles": [{"title": "Spain favourites", "url": "https://n.test/a", "seendate": "20261002T080000Z"}]}),
        httpx.Response(200, text="Your query was too short."),
    ])
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: next(replies))) as http:
        assert await gdelt_search(http, "Will Spain win in 2030?", 7, 3) == [
            {"title": "Spain favourites", "url": "https://n.test/a", "snippet": "", "date": "20261002"}]
        assert await gdelt_search(http, "Will Spain win in 2030?", 7, 3) == []
