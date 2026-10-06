"""Forecast a sample of live markets and report confidence and agreement with the market.

    .venv/bin/python -m scripts.eval_forecasts --markets 8 --label baseline

There is no ground truth for open markets, so two proxies are reported: how often the
forecast clears MIN_CONFIDENCE, and the mean gap between the forecast and the market
mid. A change that raises confidence while the gap grows is the model being surer, not
better. Searches are cached on disk so prompt changes can be compared on the same news.
"""

import argparse
import logging
import asyncio
import hashlib
import json
import pathlib
import statistics

import httpx

from app.config import Settings
from app.edge.evaluate import evaluate
from app.market.kalshi import KalshiClient
from app.market.orderbook import OrderBookMirror
from app.orchestrator import NO_WALLET_BANKROLL
from app.prediction import engine as engine_module
from app.prediction.engine import PredictionEngine

CACHE_DIR = pathlib.Path(".eval_cache")


def cached(search):
    async def wrapper(client, api_key, query, **kwargs):
        key = hashlib.sha1(json.dumps([query, kwargs], sort_keys=True).encode()).hexdigest()[:16]
        path = CACHE_DIR / f"search-{key}.json"
        if path.exists():
            return json.loads(path.read_text())
        result = await search(client, api_key, query, **kwargs)
        path.write_text(json.dumps(result))
        return result

    return wrapper


async def main(n_markets: int, label: str, deep: bool) -> None:
    CACHE_DIR.mkdir(exist_ok=True)
    engine_module.date_fenced_search = cached(engine_module.date_fenced_search)
    settings = Settings(max_markets=n_markets)
    mirror = OrderBookMirror()
    rows = []
    async with httpx.AsyncClient() as http:
        markets = await KalshiClient(settings, http).list_active_markets(mirror)
        engine = PredictionEngine(settings, http)
        for market in markets:
            quote = mirror.get(market.ticker)
            mid = statistics.mean(p for p in (quote.yes_bid, quote.yes_ask) if p is not None)
            try:
                prediction = await engine.predict(market, deep=deep)
            except Exception as exc:
                print(f"{market.ticker}: FAILED {type(exc).__name__}: {str(exc)[:160]}")
                continue
            decision = evaluate(prediction, quote, NO_WALLET_BANKROLL, settings)
            rows.append(
                {
                    "ticker": market.ticker,
                    "question": market.question,
                    "mid": mid,
                    "p_true": prediction.p_true,
                    "confidence": prediction.confidence,
                    "gap": abs(prediction.p_true - mid),
                    "actionable": bool(decision and decision.actionable),
                    "rationale": prediction.rationale,
                    "sources": len(engine.sources(market.ticker)),
                }
            )

    for r in rows:
        print(
            f"{r['ticker'][:34]:34} mid {r['mid']:.2f}  model {r['p_true']:.2f}  conf {r['confidence']:.2f}"
            f"  gap {r['gap']:.2f}  sources {r['sources']}  {'ACTIONABLE' if r['actionable'] else ''}\n    {r['question'][:110]}"
        )
    if rows:
        confident = [r for r in rows if r["confidence"] >= settings.min_confidence]
        print(
            f"\n[{label}] n={len(rows)}  mean confidence {statistics.mean(r['confidence'] for r in rows):.2f}"
            f"  clearing {settings.min_confidence:.2f}: {len(confident)}/{len(rows)}"
            f"  mean gap to market {statistics.mean(r['gap'] for r in rows):.3f}"
            + (f"  (confident only: {statistics.mean(r['gap'] for r in confident):.3f})" if confident else "")
            + f"  actionable {sum(r['actionable'] for r in rows)}"
        )
    (CACHE_DIR / f"results-{label}.json").write_text(json.dumps(rows, indent=1))


if __name__ == "__main__":
    logging.basicConfig(level=logging.WARNING, format="%(message)s")
    parser = argparse.ArgumentParser()
    parser.add_argument("--markets", type=int, default=8)
    parser.add_argument("--label", default="run")
    parser.add_argument("--deep", action="store_true", help="use multi-query research and an evidence report")
    args = parser.parse_args()
    asyncio.run(main(args.markets, args.label, args.deep))
