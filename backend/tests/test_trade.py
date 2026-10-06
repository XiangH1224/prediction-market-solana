import asyncio

import httpx
import pytest

from app.audit import AuditLog
from app.config import USDC_MINT, Settings
from app.models import EdgeDecision, Market, Prediction
from app.orchestrator import Orchestrator, valid_pubkey
from app.trade.order import Order, OrderError, request_order
from app.trade.rpc import TOKEN_PROGRAM, associated_token_address
from app.trade.simulate import check_simulation
from app.ws_api import PanelHub

WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"
YES_MINT = "GPGgr29ektC4ZB2TsPpbWmmNiCtNjq3vospE8cLweH5U"
NO_MINT = "7fLxMYQdQRdTCVTDXzxaimt6rjXSpgogWYiBXVE78roi"


def order(**overrides) -> Order:
    base = dict(tx_base64="AQID", in_amount=10_000_000, out_amount=20_000_000, min_out_amount=19_800_000,
                execution_mode="sync", compute_unit_limit=200_000)
    return Order(**{**base, **overrides})


def token_account(amount: int) -> dict:
    return {"data": {"parsed": {"info": {"tokenAmount": {"amount": str(amount)}}}}}


def sim_value(usdc_after=90_000_000, outcome_after=20_000_000, err=None, units=120_000) -> dict:
    return {"err": err, "unitsConsumed": units, "logs": ["ok"],
            "accounts": [token_account(usdc_after), token_account(outcome_after) if outcome_after else None]}


def test_usdc_ata_matches_the_on_chain_account():
    # Checked against getTokenAccountsByOwner on mainnet for this wallet.
    assert associated_token_address(WALLET, USDC_MINT, TOKEN_PROGRAM) == "FGETo8T8wMcN2wCjav8VK6eh3dLk63evNDPxzLSJra8B"


def test_wallet_addresses_are_validated():
    assert valid_pubkey(WALLET) == WALLET
    assert valid_pubkey("not-a-key") is None
    assert valid_pubkey(None) is None


def test_clean_sync_fill_passes():
    report = check_simulation(sim_value(), order(), 100_000_000, 0, 1_400_000)
    assert report.ok and report.fill_checked
    assert report.usdc_delta == -10 and report.outcome_delta == 20


def test_simulation_error_fails():
    report = check_simulation(sim_value(err={"InstructionError": [2, "Custom"]}), order(), 100_000_000, 0, 1_400_000)
    assert not report.ok and "simulation error" in report.failures[0]


def test_compute_units_over_limit_fail():
    report = check_simulation(sim_value(units=250_000), order(), 100_000_000, 0, 1_400_000)
    assert not report.ok and "compute units" in report.failures[0]


def test_spending_more_than_quoted_fails():
    report = check_simulation(sim_value(usdc_after=85_000_000), order(), 100_000_000, 0, 1_400_000)
    assert not report.ok and "quote said at most" in report.failures[0]


def test_short_fill_fails():
    report = check_simulation(sim_value(outcome_after=15_000_000), order(), 100_000_000, 0, 1_400_000)
    assert not report.ok and "quote guaranteed" in report.failures[0]


def test_no_usdc_movement_fails():
    report = check_simulation(sim_value(usdc_after=100_000_000), order(), 100_000_000, 0, 1_400_000)
    assert not report.ok and "no USDC leaves" in report.failures[0]


def test_async_order_checks_escrow_but_not_fill():
    report = check_simulation(sim_value(outcome_after=0), order(execution_mode="async"), 100_000_000, 0, 1_400_000)
    assert report.ok and not report.fill_checked


def test_missing_post_trade_accounts_fail():
    value = {"err": None, "unitsConsumed": 1, "accounts": None}
    assert not check_simulation(value, order(), 0, 0, 1_400_000).ok


async def test_request_order_builds_dflow_query():
    def handler(request: httpx.Request) -> httpx.Response:
        q = request.url.params
        assert (q["inputMint"], q["outputMint"], q["amount"], q["userPublicKey"]) == (USDC_MINT, YES_MINT, "12500000", WALLET)
        assert q["transactionVersion"] == "v0"
        return httpx.Response(200, json={"transaction": "AQID", "inAmount": "12500000", "outAmount": "25000000",
                                         "minOutAmount": "24000000", "executionMode": "async", "computeUnitLimit": 300000})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        result = await request_order(http, Settings(), YES_MINT, WALLET, 12.5)
    assert result.effective_price == 0.5 and result.execution_mode == "async"


async def test_request_order_surfaces_dflow_errors():
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(400, json={"code": "route_not_found"}))) as http:
        with pytest.raises(OrderError, match="route_not_found"):
            await request_order(http, Settings(), YES_MINT, WALLET, 5)


# -- staging -------------------------------------------------------------------


class RecordingHub(PanelHub):
    def __init__(self):
        super().__init__()
        self.sent = []

    async def broadcast(self, message):
        self.sent.append(message)


def chain(order_body: dict, sim: dict, usdc_before: int = 100_000_000):
    """Mock DFlow /order plus the three RPC calls staging makes."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/order":
            return httpx.Response(200, json=order_body)
        import json
        method = json.loads(request.content)["method"]
        if method == "getAccountInfo":
            return httpx.Response(200, json={"result": {"value": {"owner": str(TOKEN_PROGRAM)}}})
        if method == "getMultipleAccounts":
            return httpx.Response(200, json={"result": {"value": [token_account(usdc_before), None]}})
        if method == "simulateTransaction":
            return httpx.Response(200, json={"result": {"value": sim}})
        raise AssertionError(method)

    return httpx.MockTransport(handler)


ORDER_BODY = {"transaction": "AQID", "inAmount": "10000000", "outAmount": "20000000", "minOutAmount": "19800000",
              "executionMode": "sync", "computeUnitLimit": 200000, "lastValidBlockHeight": 123}
MARKET = Market(ticker="T", title="Will it happen?", yes_mint=YES_MINT, no_mint=NO_MINT)
PREDICTION = Prediction(p_true=0.65, confidence=0.8, rationale="because")
DECISION = EdgeDecision(side="yes", p_win=0.65, price=0.5, edge=0.15, actionable=True, stake_usd=10, contracts=20)


async def run_stage(tmp_path, order_body, sim):
    hub = RecordingHub()
    audit_path = tmp_path / "audit.jsonl"
    async with httpx.AsyncClient(transport=chain(order_body, sim)) as http:
        orch = Orchestrator(Settings(dflow_api_key="k"), http, hub, AuditLog(str(audit_path)))
        trade = await orch.stage(MARKET, PREDICTION, DECISION, WALLET)
    return trade, hub, orch, audit_path.read_text()


async def test_passing_simulation_is_staged_and_broadcast(tmp_path):
    trade, hub, orch, audit = await run_stage(tmp_path, ORDER_BODY, sim_value())
    assert trade is not None and trade.tx_base64 == "AQID"
    assert trade.effective_price == 0.5 and trade.effective_edge == pytest.approx(0.15)
    assert trade.est_payout_usd == 20 and trade.simulation.units_consumed == 120_000
    assert [m["type"] for m in hub.sent] == ["staged_trade"]
    assert '"event": "staged"' in audit


async def test_failing_simulation_is_discarded_and_never_reaches_the_panel(tmp_path):
    trade, hub, orch, audit = await run_stage(tmp_path, ORDER_BODY, sim_value(err="InsufficientFunds"))
    assert trade is None and hub.sent == [] and orch.staged == {}
    assert '"event": "discarded"' in audit and "simulation error" in audit


async def test_quote_worse_than_the_book_is_discarded_before_simulating(tmp_path):
    # Fill at 0.625 leaves an edge of 0.025, under the 6% hurdle.
    body = {**ORDER_BODY, "outAmount": "16000000"}
    trade, hub, orch, audit = await run_stage(tmp_path, body, sim_value())
    assert trade is None and hub.sent == []
    assert "below hurdle" in audit


async def test_panel_decisions_are_audited_and_unstage(tmp_path):
    trade, hub, orch, _ = await run_stage(tmp_path, ORDER_BODY, sim_value())
    await orch.handle_panel_message({"type": "approved", "id": trade.id})
    assert trade.id in orch.staged
    await orch.handle_panel_message({"type": "sent", "id": trade.id, "signature": "sig"})
    assert orch.staged == {}
    assert hub.sent[-1] == {"type": "unstaged", "data": {"id": trade.id, "reason": "sent"}}
    audit = (tmp_path / "audit.jsonl").read_text()
    assert '"event": "approved"' in audit and '"signature": "sig"' in audit


# -- search, analysis, paper trades ----------------------------------------------

from app.models import Prediction as _Prediction
from app.orchestrator import verdict
from app.paper import PaperBook

KALSHI_RAW = {
    "ticker": "KXFED-26OCT", "event_ticker": "KXFED", "status": "active", "market_type": "binary",
    "title": "Will the Fed cut rates in October?", "yes_sub_title": "Cut", "rules_primary": "Resolves YES on a cut.",
    "close_time": "", "yes_bid_dollars": "0.3800", "yes_ask_dollars": "0.4000",
    "no_bid_dollars": "0.6000", "no_ask_dollars": "0.6200",
}
SEARCH_BODY = {"current_page": [{"event_title": "Fed decision in October", "markets": [
    {"ticker": "KXFED-26OCT", "title": "Will the Fed cut rates in October?", "yes_subtitle": "Cut",
     "yes_ask_dollars": "0.4000", "close_ts": "2026-10-28T18:00:00Z", "result": ""},
    {"ticker": "SETTLED", "title": "old", "result": "yes"}]}]}


class FixedEngine:
    def __init__(self, p_true, confidence):
        self.prediction = _Prediction(p_true=p_true, confidence=confidence, rationale="why")

    async def predict(self, market, deep=False, on_progress=None):
        self.deep = deep
        if on_progress:
            await on_progress("Forecasting, run 1 of 3")
        return self.prediction


def kalshi_transport():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/search/series"):
            assert request.url.params["query"] == "fed"
            return httpx.Response(200, json=SEARCH_BODY)
        if request.url.path.endswith("/markets/KXFED-26OCT"):
            return httpx.Response(200, json={"market": KALSHI_RAW})
        if request.url.path.endswith("/markets"):
            return httpx.Response(200, json={"markets": [KALSHI_RAW]})
        raise AssertionError(request.url)

    return httpx.MockTransport(handler)


async def analysed(tmp_path, p_true, confidence):
    hub = RecordingHub()
    http = httpx.AsyncClient(transport=kalshi_transport())
    settings = Settings(paper_positions_path=str(tmp_path / "paper.json"), paper_bankroll_usd=1000)
    orch = Orchestrator(settings, http, hub, AuditLog(str(tmp_path / "audit.jsonl")), engine=FixedEngine(p_true, confidence))
    await orch.analyze("KXFED-26OCT")
    return orch, hub, http


async def test_browse_lists_popular_markets_before_any_search(tmp_path):
    orch, hub, http = await analysed(tmp_path, 0.5, 0.5)
    await orch.handle_panel_message({"type": "browse"})
    message = hub.sent[-1]
    assert message["type"] == "browse" and message["data"]["results"][0] == {
        "ticker": "KXFED-26OCT", "title": "Will the Fed cut rates in October?", "subtitle": "Cut",
        "event_title": "", "yes_ask": "0.4000", "close_time": ""}
    await http.aclose()


async def test_search_returns_open_markets_only(tmp_path):
    orch, hub, http = await analysed(tmp_path, 0.5, 0.5)
    await orch.handle_panel_message({"type": "search", "query": " fed "})
    results = hub.sent[-1]["data"]["results"]
    assert [r["ticker"] for r in results] == ["KXFED-26OCT"] and results[0]["yes_ask"] == "0.4000"
    await http.aclose()


async def test_analysis_recommends_investing_when_edge_and_confidence_clear(tmp_path):
    orch, hub, http = await analysed(tmp_path, 0.55, 0.8)
    updates = [m["data"] for m in hub.sent if m["type"] == "analysis"]
    assert [u["state"] for u in updates] == ["running", "running", "done"]
    assert [u.get("stage") for u in updates[:2]] == ["Loading the market", "Forecasting, run 1 of 3"]
    assert orch.engine.deep is True
    result = orch.analyses["KXFED-26OCT"]
    assert result["verdict"]["invest"] is True and result["verdict"]["headline"] == "Invest: buy YES at 40¢"
    assert result["paper_stake_usd"] == 25

    await orch.handle_panel_message({"type": "paper_buy", "ticker": "KXFED-26OCT"})
    paper = hub.sent[-1]["data"]
    assert paper["error"] == "" and paper["cash_usd"] == 975
    position = paper["positions"][0]
    assert (position["side"], position["price"], position["contracts"]) == ("yes", 0.4, 62.5)
    # Marked at the 0.38 bid: 62.5 contracts are worth 23.75, a 1.25 loss to the spread.
    assert (position["value_usd"], position["pnl_usd"]) == (23.75, -1.25)
    assert PaperBook(str(tmp_path / "paper.json"), 1000).cash == 975
    await http.aclose()


async def test_analysis_says_not_to_invest_on_low_confidence_but_allows_a_small_paper_buy(tmp_path):
    orch, hub, http = await analysed(tmp_path, 0.55, 0.2)
    result = orch.analyses["KXFED-26OCT"]
    assert result["verdict"]["invest"] is False and "confidence" in result["verdict"]["detail"]
    assert result["paper_stake_usd"] == 10
    await http.aclose()


async def test_paper_buy_needs_an_analysis_first(tmp_path):
    orch, hub, http = await analysed(tmp_path, 0.55, 0.8)
    await orch.paper_buy("UNSEEN")
    assert hub.sent[-1]["data"]["error"] == "analyse the market first" and orch.paper.positions == []
    await http.aclose()


def test_rate_limit_errors_are_explained_in_plain_words():
    from openai import RateLimitError
    from app.orchestrator import explain

    response = httpx.Response(429, request=httpx.Request("POST", "https://x.test"))
    exc = RateLimitError("Rate limit reached ... Please try again in 13m58.9s. Need more tokens?", response=response, body=None)
    assert explain(exc) == "The free model allowance is used up for now. Try again in 13m58.9s."
    assert explain(ValueError("boom")) == "ValueError: boom"


def test_verdict_without_a_price():
    assert verdict(_Prediction(p_true=0.5, confidence=0.9, rationale="r"), None)["invest"] is False


class SlowEngine(FixedEngine):
    """Holds each forecast until released, and records what ran at the same time."""

    def __init__(self):
        super().__init__(0.55, 0.8)
        self.release = asyncio.Event()
        self.started, self.active, self.max_active = [], 0, 0

    async def predict(self, market, deep=False, on_progress=None):
        self.started.append(market.ticker)
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        try:
            await self.release.wait()
        finally:
            self.active -= 1
        return self.prediction


def slow_orchestrator(tmp_path):
    def handler(request: httpx.Request) -> httpx.Response:
        ticker = request.url.path.rsplit("/", 1)[-1]
        return httpx.Response(200, json={"market": {**KALSHI_RAW, "ticker": ticker}})

    hub, engine = RecordingHub(), SlowEngine()
    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    settings = Settings(paper_positions_path=str(tmp_path / "paper.json"))
    return Orchestrator(settings, http, hub, AuditLog(str(tmp_path / "audit.jsonl")), engine=engine), hub, engine, http


async def settle():
    for _ in range(20):
        await asyncio.sleep(0)


async def test_repeat_clicks_are_ignored_and_analyses_run_one_at_a_time(tmp_path):
    orch, hub, engine, http = slow_orchestrator(tmp_path)
    for ticker in ("A", "A", "A", "B"):
        await orch.handle_panel_message({"type": "analyze", "ticker": ticker})
    await settle()
    assert engine.started == ["A"]
    assert orch.analyses["B"]["stage"] == "Waiting for the analysis ahead of it"

    engine.release.set()
    await asyncio.gather(*orch._analysis_tasks.values())
    assert engine.started == ["A", "B"] and engine.max_active == 1
    assert orch.analyses["A"]["state"] == orch.analyses["B"]["state"] == "done"
    await http.aclose()


async def test_cancelling_frees_the_queue_for_the_next_analysis(tmp_path):
    orch, hub, engine, http = slow_orchestrator(tmp_path)
    await orch.handle_panel_message({"type": "analyze", "ticker": "A"})
    await orch.handle_panel_message({"type": "analyze", "ticker": "B"})
    await settle()
    await orch.handle_panel_message({"type": "cancel_analysis", "ticker": "A"})
    await settle()
    assert "A" not in orch.analyses and engine.started == ["A", "B"]
    assert {"type": "analysis", "data": {"ticker": "A", "state": "cancelled"}} in hub.sent
    engine.release.set()
    await asyncio.gather(*orch._analysis_tasks.values())
    assert orch.analyses["B"]["state"] == "done"
    await http.aclose()
