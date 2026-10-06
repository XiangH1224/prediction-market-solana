from typing import Literal

from pydantic import BaseModel, Field

Side = Literal["yes", "no"]


class Market(BaseModel):
    ticker: str
    event_ticker: str = ""
    title: str
    subtitle: str = ""
    rules: str = ""
    open_time: str = ""
    close_time: str = ""
    early_close: str = ""
    # Empty when the market came from Kalshi's public data instead of DFlow.
    yes_mint: str = ""
    no_mint: str = ""

    @property
    def question(self) -> str:
        return f"{self.title} ({self.subtitle})" if self.subtitle else self.title

    def mint(self, side: Side) -> str:
        return self.yes_mint if side == "yes" else self.no_mint


class Quote(BaseModel):
    """Top of book for one market. Prices are probabilities in dollars (0-1)."""

    yes_bid: float | None = None
    yes_ask: float | None = None
    no_bid: float | None = None
    no_ask: float | None = None
    # Bid ladders as [price, size] pairs, best first.
    yes_bids: list[tuple[float, float]] = Field(default_factory=list)
    no_bids: list[tuple[float, float]] = Field(default_factory=list)
    updated_at: float = 0.0


class Prediction(BaseModel):
    p_true: float = Field(ge=0, le=1, description="Probability that the market resolves YES")
    confidence: float = Field(ge=0, le=1, description="How much the evidence supports p_true")
    rationale: str = Field(description="Two or three sentences citing the evidence used")


class EdgeDecision(BaseModel):
    side: Side
    p_win: float
    price: float
    edge: float
    actionable: bool
    reason: str = ""
    kelly_full: float = 0.0
    stake_fraction: float = 0.0
    stake_usd: float = 0.0
    contracts: float = 0.0


class SimulationReport(BaseModel):
    ok: bool
    failures: list[str] = Field(default_factory=list)
    err: object | None = None
    units_consumed: int | None = None
    compute_unit_limit: int | None = None
    usdc_delta: float | None = None
    outcome_delta: float | None = None
    # Async orders escrow USDC now and fill later, so the fill cannot be seen in simulation.
    fill_checked: bool = False
    logs_tail: list[str] = Field(default_factory=list)


class StagedTrade(BaseModel):
    id: str
    market: Market
    prediction: Prediction
    decision: EdgeDecision
    simulation: SimulationReport
    tx_base64: str
    wallet: str
    spend_usd: float
    expected_contracts: float
    min_contracts: float
    effective_price: float
    effective_edge: float
    est_payout_usd: float
    execution_mode: str = ""
    last_valid_block_height: int | None = None
    staged_at: float
    expires_at: float
