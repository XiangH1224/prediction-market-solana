import asyncio
import logging
import time
import uuid

import httpx
from solders.pubkey import Pubkey

from .audit import AuditLog
from .config import TOKEN_SCALE, USDC_MINT, Settings
from .edge.evaluate import evaluate
from .market.kalshi import KalshiClient
from .market.metadata import MetadataClient
from .market.orderbook import OrderBookMirror
from .market.select import in_price_band
from .market.stream import run_price_stream
import re

from openai import APIConnectionError, APITimeoutError, RateLimitError

from .models import EdgeDecision, Market, Prediction, StagedTrade
from .paper import PaperBook
from .prediction.engine import PredictionEngine
from .trade.order import request_order
from .trade.rpc import associated_token_address, token_balances
from .trade.simulate import simulate_order
from .ws_api import PanelHub

log = logging.getLogger(__name__)

# Lets signals show an edge before a wallet is connected; nothing is staged without one.
NO_WALLET_BANKROLL = 1e9
# A market whose search, forecast or order failed is left alone this long, so a bad key
# or an outage does not burn search credits on every scan.
FAILURE_BACKOFF_S = 300


def valid_pubkey(value) -> str | None:
    try:
        return str(Pubkey.from_string(value))
    except (TypeError, ValueError):
        return None


def explain(exc: Exception) -> str:
    """An error message a person can act on."""
    if isinstance(exc, RateLimitError):
        wait = re.search(r"try again in ([0-9hms.]+)", str(exc))
        return "The free model allowance is used up for now." + (f" Try again in {wait.group(1).rstrip('.')}." if wait else "")
    if isinstance(exc, APITimeoutError):
        return "The model took too long to answer and was stopped. Try again, or pick a smaller model."
    if isinstance(exc, APIConnectionError):
        return "Could not reach the model server. If you use LM Studio, start it with: lms server start"
    return f"{type(exc).__name__}: {str(exc)[:300]}"


def verdict(prediction: Prediction, decision: EdgeDecision | None) -> dict:
    """Plain-language recommendation for one analysed market."""
    if decision is None:
        return {"invest": False, "headline": "Don't invest", "detail": "There is no price to buy at right now."}
    side = decision.side.upper()
    numbers = (
        f"Model puts {side} at {decision.p_win:.0%}; it costs {decision.price:.0%}. "
        f"Edge {decision.edge * 100:+.1f} pts, confidence {prediction.confidence:.2f}."
    )
    if decision.actionable:
        return {
            "invest": True,
            "headline": f"Invest: buy {side} at {decision.price * 100:.0f}\u00a2",
            "detail": f"{numbers} Suggested stake ${decision.stake_usd:.2f}.",
        }
    return {"invest": False, "headline": "Don't invest", "detail": f"{numbers} Not enough: {decision.reason}."}


class Orchestrator:
    def __init__(
        self,
        settings: Settings,
        http: httpx.AsyncClient,
        hub: PanelHub,
        audit: AuditLog,
        engine: PredictionEngine | None = None,
        metadata: MetadataClient | KalshiClient | None = None,
    ):
        self.settings = settings
        self.http = http
        self.hub = hub
        self.audit = audit
        self.engine = engine or PredictionEngine(settings, http)
        source = KalshiClient if settings.signals_only else MetadataClient
        self.metadata = metadata or source(settings, http)
        # Search, on-demand analysis and paper trades always use Kalshi's public data.
        self.kalshi = self.metadata if isinstance(self.metadata, KalshiClient) else KalshiClient(settings, http)
        self.paper = PaperBook(settings.paper_positions_path, settings.paper_bankroll_usd)
        self.analyses: dict[str, dict] = {}
        self._analysis_tasks: dict[str, asyncio.Task] = {}
        # One analysis at a time: they share one model, and running several only makes each slower.
        self._analysis_turn = asyncio.Lock()
        self._analysing = 0
        self.mirror = OrderBookMirror()
        self.markets: list[Market] = []
        self.signals: dict[str, dict] = {}
        self.staged: dict[str, StagedTrade] = {}
        self.cooldown_until: dict[str, float] = {}
        self.retry_after: dict[str, float] = {}
        self.state = "starting"
        self.last_error = ""

    # -- panel ------------------------------------------------------------

    def status(self) -> dict:
        return {
            "type": "status",
            "data": {
                "state": self.state,
                "missing_keys": self.settings.missing_keys(),
                "signals_only": not self.metadata.tradable,
                "markets": len(self.markets),
                "wallet": self.hub.wallet,
                "edge_hurdle": self.settings.edge_hurdle,
                "last_error": self.last_error,
            },
        }

    def snapshot(self) -> list[dict]:
        """Everything a panel needs when it connects."""
        self._expire_staged()
        return [
            self.status(),
            *({"type": "signal", "data": s} for s in self.signals.values()),
            *({"type": "staged_trade", "data": t.model_dump()} for t in self.staged.values()),
            *({"type": "analysis", "data": a} for a in self.analyses.values()),
            self.paper_message(),
        ]

    def paper_message(self, error: str = "") -> dict:
        return {"type": "paper", "data": {**self.paper.snapshot(self.mirror), "error": error}}

    async def handle_panel_message(self, message: dict) -> None:
        kind = message.get("type")
        if kind == "hello":
            self.hub.wallet = valid_pubkey(message.get("wallet"))
            await self.hub.broadcast(self.status())
        elif kind == "browse":
            await self.browse()
        elif kind == "search":
            await self.search(str(message.get("query", "")).strip())
        elif kind == "analyze":
            self.start_analysis(str(message.get("ticker", "")))
        elif kind == "cancel_analysis":
            await self.cancel_analysis(str(message.get("ticker", "")))
        elif kind == "paper_buy":
            await self.paper_buy(str(message.get("ticker", "")))
        elif kind in ("approved", "rejected", "sent", "send_failed"):
            trade = self.staged.get(message.get("id", ""))
            if trade is None:
                return
            self.audit.write(
                kind,
                id=trade.id,
                ticker=trade.market.ticker,
                wallet=trade.wallet,
                signature=message.get("signature"),
                error=message.get("error"),
            )
            if kind != "approved":
                del self.staged[trade.id]
                await self.hub.broadcast({"type": "unstaged", "data": {"id": trade.id, "reason": kind}})

    # -- search, on-demand analysis, paper trades -----------------------------

    async def browse(self) -> None:
        """Popular markets to show before the operator has searched for anything."""
        try:
            results, error = await self.kalshi.popular(self.mirror), ""
        except Exception as exc:
            results, error = [], f"{type(exc).__name__}: {exc}"
        await self.hub.broadcast({"type": "browse", "data": {"query": "", "results": results, "error": error}})

    async def search(self, query: str) -> None:
        if not query:
            return
        try:
            results, error = await self.kalshi.search(query), ""
        except Exception as exc:
            results, error = [], f"{type(exc).__name__}: {exc}"
        await self.hub.broadcast({"type": "search_results", "data": {"query": query, "results": results, "error": error}})

    def start_analysis(self, ticker: str) -> None:
        """Queue an analysis beside the socket loop. A repeat click on a market already in the queue is ignored."""
        if not ticker or ticker in self._analysis_tasks:
            return
        task = asyncio.create_task(self.analyze(ticker))
        self._analysis_tasks[ticker] = task
        task.add_done_callback(lambda _: self._analysis_tasks.pop(ticker, None))

    async def cancel_analysis(self, ticker: str) -> None:
        task = self._analysis_tasks.get(ticker)
        if task:
            task.cancel()
        self.analyses.pop(ticker, None)
        await self.hub.broadcast({"type": "analysis", "data": {"ticker": ticker, "state": "cancelled"}})

    async def analyze(self, ticker: str) -> None:
        """Forecast one market the operator picked and say whether it is worth buying."""
        started = time.time()

        async def progress(stage: str) -> None:
            self.analyses[ticker] = {"ticker": ticker, "state": "running", "stage": stage, "started_at": started}
            await self.hub.broadcast({"type": "analysis", "data": self.analyses[ticker]})

        if self._analysis_turn.locked():
            await progress("Waiting for the analysis ahead of it")
        async with self._analysis_turn:
            await self._analyze(ticker, progress)

    async def _analyze(self, ticker: str, progress) -> None:
        await progress("Loading the market")
        self._analysing += 1
        try:
            market = await self.kalshi.get_market(ticker, self.mirror)
            if market is None:
                raise ValueError("this market is not an open yes/no market")
            quote = self.mirror.get(ticker)
            prediction = await self.engine.predict(market, deep=True, on_progress=progress)
            decision = evaluate(prediction, quote, self.paper.cash, self.settings)
            self.analyses[ticker] = {
                "ticker": ticker,
                "state": "done",
                "market": market.model_dump(),
                "prediction": prediction.model_dump(),
                "decision": decision.model_dump() if decision else None,
                "quote": quote.model_dump(),
                "verdict": verdict(prediction, decision),
                "sources": self.engine.sources(ticker) if hasattr(self.engine, "sources") else [],
                "paper_stake_usd": self._paper_stake(decision),
            }
        except Exception as exc:
            log.warning("analysis of %s failed: %s", ticker, exc)
            self.analyses[ticker] = {"ticker": ticker, "state": "error", "error": explain(exc)}
        finally:
            self._analysing -= 1
        await self.hub.broadcast({"type": "analysis", "data": self.analyses[ticker]})

    def _paper_stake(self, decision: EdgeDecision | None) -> float:
        if decision is None:
            return 0.0
        stake = decision.stake_usd if decision.actionable else self.settings.paper_default_stake_usd
        return round(min(stake, self.paper.cash), 2)

    async def paper_buy(self, ticker: str) -> None:
        """Record a simulated purchase of the analysed side at the current ask. No money moves."""
        analysis = self.analyses.get(ticker)
        try:
            if not analysis or analysis.get("state") != "done" or not analysis.get("decision"):
                raise ValueError("analyse the market first")
            await self.kalshi.refresh_tickers([ticker], self.mirror)
            quote = self.mirror.get(ticker)
            side = analysis["decision"]["side"]
            price = quote.yes_ask if side == "yes" else quote.no_ask
            if price is None:
                raise ValueError("no ask to buy at")
            market = Market(**analysis["market"])
            position = self.paper.buy(market, side, price, analysis["paper_stake_usd"])
            self.audit.write("paper_buy", **position, recommended=analysis["verdict"]["invest"])
            await self.hub.broadcast(self.paper_message())
        except Exception as exc:
            await self.hub.broadcast(self.paper_message(error=str(exc)))

    # -- scan loop ----------------------------------------------------------

    async def run(self) -> None:
        if self.settings.missing_keys():
            self.state = "missing_keys"
            log.error("not scanning, missing env: %s", ", ".join(self.settings.missing_keys()))
            return

        stream: asyncio.Task | None = None
        try:
            while True:
                try:
                    if not self.markets and self.settings.max_markets > 0:
                        self.markets = await self.metadata.list_active_markets(self.mirror)
                        if self.metadata.tradable:
                            tickers = [m.ticker for m in self.markets]
                            stream = asyncio.create_task(run_price_stream(self.settings, self.mirror, tickers))
                    self.state = "scanning"
                    if not self.retry_after or time.time() >= max(self.retry_after.values()):
                        self.last_error = ""
                    await self.scan()
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    self.state = "error"
                    self.last_error = f"{type(exc).__name__}: {exc}"
                    log.exception("scan failed")
                await self.hub.broadcast(self.status())
                await asyncio.sleep(self.settings.scan_interval_s)
        finally:
            if stream:
                stream.cancel()

    async def scan(self) -> None:
        for trade_id in self._expire_staged():
            await self.hub.broadcast({"type": "unstaged", "data": {"id": trade_id, "reason": "expired"}})

        await self.metadata.refresh_quotes(self.markets, self.mirror)
        if self.paper.positions:
            await self.kalshi.refresh_tickers(self.paper.tickers(), self.mirror)
            await self.hub.broadcast(self.paper_message())
        wallet = self.hub.wallet
        bankroll = await self.bankroll(wallet) if wallet else NO_WALLET_BANKROLL
        gate = asyncio.Semaphore(max(1, self.settings.scan_concurrency))

        async def guarded(market: Market) -> None:
            if time.time() < self.retry_after.get(market.ticker, 0):
                return
            async with gate:
                # An analysis the operator asked for goes ahead of the background scan.
                while self._analysing:
                    await asyncio.sleep(1)
                try:
                    await self.evaluate_market(market, wallet, bankroll)
                except Exception as exc:
                    self.retry_after[market.ticker] = time.time() + FAILURE_BACKOFF_S
                    self.last_error = f"{market.ticker}: {type(exc).__name__}: {exc}"
                    log.warning("%s skipped: %s", market.ticker, exc)

        await asyncio.gather(*(guarded(m) for m in self.markets))

    async def bankroll(self, wallet: str) -> float:
        (balance,) = await token_balances(
            self.http, self.settings.solana_rpc_url, [associated_token_address(wallet, USDC_MINT)]
        )
        return balance / TOKEN_SCALE

    async def evaluate_market(self, market: Market, wallet: str | None, bankroll: float) -> None:
        quote = self.mirror.get(market.ticker)
        if quote is None or not in_price_band(quote, self.settings):
            return

        prediction = await self.engine.predict(market)
        decision = evaluate(prediction, quote, bankroll, self.settings)
        if decision is None:
            return

        signal = {
            "market": market.model_dump(),
            "prediction": prediction.model_dump(),
            "decision": decision.model_dump(),
            "quote": quote.model_dump(),
        }
        self.signals[market.ticker] = signal
        await self.hub.broadcast({"type": "signal", "data": signal})

        if decision.actionable and wallet and self.metadata.tradable and self._can_stage(market.ticker):
            await self.stage(market, prediction, decision, wallet)

    def _can_stage(self, ticker: str) -> bool:
        if time.time() < self.cooldown_until.get(ticker, 0):
            return False
        return all(t.market.ticker != ticker for t in self.staged.values())

    def _expire_staged(self) -> list[str]:
        now = time.time()
        expired = [trade_id for trade_id, t in self.staged.items() if t.expires_at <= now]
        for trade_id in expired:
            del self.staged[trade_id]
        return expired

    async def stage(
        self, market: Market, prediction: Prediction, decision: EdgeDecision, wallet: str
    ) -> StagedTrade | None:
        """Build the order, dry-run it, and hand it to the panel only if every check passes."""
        self.cooldown_until[market.ticker] = time.time() + self.settings.restage_cooldown_s
        outcome_mint = market.mint(decision.side)

        order = await request_order(self.http, self.settings, outcome_mint, wallet, decision.stake_usd)
        effective_edge = decision.p_win - order.effective_price
        if effective_edge < self.settings.edge_hurdle:
            self.audit.write(
                "discarded",
                ticker=market.ticker,
                wallet=wallet,
                reason=f"edge at quoted fill {effective_edge:.3f} below hurdle",
            )
            return None

        report = await simulate_order(self.http, self.settings, order, wallet, outcome_mint)
        if not report.ok:
            self.audit.write("discarded", ticker=market.ticker, wallet=wallet, reason="; ".join(report.failures))
            return None

        now = time.time()
        expected = order.out_amount / TOKEN_SCALE
        trade = StagedTrade(
            id=uuid.uuid4().hex,
            market=market,
            prediction=prediction,
            decision=decision,
            simulation=report,
            tx_base64=order.tx_base64,
            wallet=wallet,
            spend_usd=order.in_amount / TOKEN_SCALE,
            expected_contracts=expected,
            min_contracts=order.min_out_amount / TOKEN_SCALE,
            effective_price=order.effective_price,
            effective_edge=effective_edge,
            est_payout_usd=expected,
            execution_mode=order.execution_mode,
            last_valid_block_height=order.last_valid_block_height,
            staged_at=now,
            expires_at=now + self.settings.stage_ttl_s,
        )
        self.staged[trade.id] = trade
        self.audit.write(
            "staged",
            id=trade.id,
            ticker=market.ticker,
            wallet=wallet,
            side=decision.side,
            spend_usd=trade.spend_usd,
            effective_edge=effective_edge,
            p_true=prediction.p_true,
            rationale=prediction.rationale,
            units_consumed=report.units_consumed,
        )
        await self.hub.broadcast({"type": "staged_trade", "data": trade.model_dump()})
        return trade
