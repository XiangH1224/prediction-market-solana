import os
from dataclasses import dataclass, field

from dotenv import load_dotenv

load_dotenv()

USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
# USDC and DFlow outcome tokens both use 6 decimals.
TOKEN_DECIMALS = 6
TOKEN_SCALE = 10**TOKEN_DECIMALS


def _float(name: str, default: float) -> float:
    return float(os.getenv(name, default))


def _int(name: str, default: int) -> int:
    return int(os.getenv(name, default))


def _list(name: str) -> list[str]:
    return [s.strip() for s in os.getenv(name, "").split(",") if s.strip()]


@dataclass
class Settings:
    # Prediction engine
    xai_api_key: str = field(default_factory=lambda: os.getenv("XAI_API_KEY", ""))
    xai_base_url: str = field(default_factory=lambda: os.getenv("XAI_BASE_URL", "https://api.x.ai/v1"))
    xai_model: str = field(default_factory=lambda: os.getenv("XAI_MODEL", "grok-4"))
    tavily_api_key: str = field(default_factory=lambda: os.getenv("TAVILY_API_KEY", ""))
    news_days: int = field(default_factory=lambda: _int("NEWS_DAYS", 7))
    news_max_results: int = field(default_factory=lambda: _int("NEWS_MAX_RESULTS", 8))
    # Deep research, used when someone asks about a specific market.
    research_queries: int = field(default_factory=lambda: _int("RESEARCH_QUERIES", 3))
    research_results_per_query: int = field(default_factory=lambda: _int("RESEARCH_RESULTS_PER_QUERY", 5))
    prediction_ttl_s: float = field(default_factory=lambda: _float("PREDICTION_TTL_S", 3600))
    # Forecast runs per market; their spread feeds the confidence score.
    ensemble_size: int = field(default_factory=lambda: _int("ENSEMBLE_SIZE", 3))
    # Optional: one run per listed model instead of ENSEMBLE_SIZE runs of XAI_MODEL.
    # Useful when the provider rate-limits each model separately.
    ensemble_models: list[str] = field(default_factory=lambda: _list("XAI_ENSEMBLE_MODELS"))
    # Tried in order when a model is rate-limited past the SDK's retries (e.g. a daily token cap).
    fallback_models: list[str] = field(default_factory=lambda: _list("XAI_FALLBACK_MODELS"))
    # Bounds on one model call. A local thinking model can otherwise generate for many minutes.
    llm_max_tokens: int = field(default_factory=lambda: _int("LLM_MAX_TOKENS", 1200))
    llm_timeout_s: float = field(default_factory=lambda: _float("LLM_TIMEOUT_S", 180))
    llm_max_retries: int = field(default_factory=lambda: _int("LLM_MAX_RETRIES", 6))

    # DFlow
    dflow_api_key: str = field(default_factory=lambda: os.getenv("DFLOW_API_KEY", ""))
    dflow_metadata_url: str = field(
        default_factory=lambda: os.getenv("DFLOW_METADATA_URL", "https://prediction-markets-api.dflow.net")
    )
    dflow_metadata_ws_url: str = field(
        default_factory=lambda: os.getenv("DFLOW_METADATA_WS_URL", "wss://prediction-markets-api.dflow.net/api/v1/ws")
    )
    dflow_trade_url: str = field(default_factory=lambda: os.getenv("DFLOW_TRADE_URL", "https://quote-api.dflow.net"))
    # Keyless fallback for market data when DFLOW_API_KEY is not set.
    kalshi_url: str = field(
        default_factory=lambda: os.getenv("KALSHI_URL", "https://api.elections.kalshi.com/trade-api/v2")
    )
    kalshi_search_url: str = field(
        default_factory=lambda: os.getenv("KALSHI_SEARCH_URL", "https://api.elections.kalshi.com/v1/search/series")
    )
    series_tickers: list[str] = field(default_factory=lambda: _list("SERIES_TICKERS"))
    max_markets: int = field(default_factory=lambda: _int("MAX_MARKETS", 25))
    # Market selection: skip near-certain prices, far-off closes, and crowding from one event.
    min_price: float = field(default_factory=lambda: _float("MIN_PRICE", 0.05))
    max_price: float = field(default_factory=lambda: _float("MAX_PRICE", 0.95))
    max_days_to_close: float = field(default_factory=lambda: _float("MAX_DAYS_TO_CLOSE", 45))
    max_per_event: int = field(default_factory=lambda: _int("MAX_PER_EVENT", 2))

    # Solana
    solana_rpc_url: str = field(
        default_factory=lambda: os.getenv("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com")
    )
    max_compute_units: int = field(default_factory=lambda: _int("MAX_COMPUTE_UNITS", 1_400_000))

    # Edge and sizing
    edge_hurdle: float = field(default_factory=lambda: _float("EDGE_HURDLE", 0.06))
    kelly_fraction: float = field(default_factory=lambda: _float("KELLY_FRACTION", 0.25))
    max_position_fraction: float = field(default_factory=lambda: _float("MAX_POSITION_FRACTION", 0.05))
    max_trade_usd: float = field(default_factory=lambda: _float("MAX_TRADE_USD", 25))
    min_trade_usd: float = field(default_factory=lambda: _float("MIN_TRADE_USD", 1))
    min_confidence: float = field(default_factory=lambda: _float("MIN_CONFIDENCE", 0.5))

    # Orchestration
    # Markets forecast at once. Keep at 1 on rate-limited free tiers so a search is not stuck behind the scan.
    scan_concurrency: int = field(default_factory=lambda: _int("SCAN_CONCURRENCY", 1))
    scan_interval_s: float = field(default_factory=lambda: _float("SCAN_INTERVAL_S", 20))
    stage_ttl_s: float = field(default_factory=lambda: _float("STAGE_TTL_S", 45))
    restage_cooldown_s: float = field(default_factory=lambda: _float("RESTAGE_COOLDOWN_S", 300))

    # Paper trading
    paper_bankroll_usd: float = field(default_factory=lambda: _float("PAPER_BANKROLL_USD", 1000))
    paper_default_stake_usd: float = field(default_factory=lambda: _float("PAPER_DEFAULT_STAKE_USD", 10))
    paper_positions_path: str = field(default_factory=lambda: os.getenv("PAPER_POSITIONS_PATH", "paper_positions.json"))

    # Panel auth and audit
    # Optional shared secret for the panel. Empty means any page or extension on this machine may connect.
    panel_token: str = field(default_factory=lambda: os.getenv("PANEL_TOKEN", ""))
    audit_log_path: str = field(default_factory=lambda: os.getenv("AUDIT_LOG_PATH", "audit.jsonl"))

    def missing_keys(self) -> list[str]:
        """Env vars the scan loop cannot run without."""
        return [] if self.xai_api_key else ["XAI_API_KEY"]

    @property
    def signals_only(self) -> bool:
        """Without a DFlow key there are no outcome mints, so nothing can be staged."""
        return not self.dflow_api_key
