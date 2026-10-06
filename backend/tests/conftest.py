import pytest

from app.config import Settings


@pytest.fixture(autouse=True)
def isolate_from_dotenv(monkeypatch, tmp_path):
    """Settings read the environment, which load_dotenv fills from the developer's .env.
    Tests must see the defaults, whatever that file holds."""
    for name in (
        "XAI_MODEL", "XAI_BASE_URL", "XAI_ENSEMBLE_MODELS", "XAI_FALLBACK_MODELS", "LLM_MAX_TOKENS", "LLM_TIMEOUT_S", "RESEARCH_RESULTS_PER_QUERY", "RESEARCH_QUERIES", "SCAN_CONCURRENCY", "ENSEMBLE_SIZE", "PREDICTION_TTL_S", "MAX_MARKETS",
        "SERIES_TICKERS", "EDGE_HURDLE", "KELLY_FRACTION", "MAX_POSITION_FRACTION", "MAX_TRADE_USD", "MIN_TRADE_USD",
        "MIN_CONFIDENCE", "MIN_PRICE", "MAX_PRICE", "MAX_DAYS_TO_CLOSE", "MAX_PER_EVENT", "DFLOW_API_KEY",
        "TAVILY_API_KEY", "SOLANA_RPC_URL",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("PAPER_POSITIONS_PATH", str(tmp_path / "paper_positions.json"))
    assert Settings().ensemble_models == []
