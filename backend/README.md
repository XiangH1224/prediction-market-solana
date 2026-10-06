# Orchestrator (FastAPI)

Scans DFlow's tokenized Kalshi markets, forecasts each one with Grok over fresh news,
and stages a trade for the side panel only when it clears the edge hurdle and passes a
mainnet dry run. It never holds a key and never sends a transaction.

## Run

```bash
cd backend
python3.13 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env   # XAI_API_KEY is required; see the comments for the optional keys
.venv/bin/uvicorn app.main:app --port 8000
```

The PredictFlow panel at the repo root is the UI; `npm start` there runs this backend together with the
Kalshi market relay the panel needs. Then open http://localhost:8000/predictflow/ in a browser, or load the
repo root as an unpacked extension. Search or pick an event, read the
verdict and its sources, and buy with simulated money or pass. Set `PANEL_TOKEN` only if
you want the panel to require a shared secret.

## Layout

| Path | Role |
|---|---|
| `app/prediction/` | Tavily date-fenced news search, Grok structured forecast `{p_true, confidence, rationale}` |
| `app/market/` | DFlow metadata client, in-memory order book mirror, websocket price stream |
| `app/edge/` | Edge per side against its own ask, 6% hurdle, fractional Kelly sizing |
| `app/trade/` | DFlow `/order` request, `simulateTransaction` dry run and its checks |
| `app/orchestrator.py` | Scan loop, staging, expiry, panel messages |
| `app/ws_api.py` | Token-gated websocket for the panel |
| `app/audit.py` | JSONL log of staged, discarded, approved, rejected and sent trades |

## Checks before a trade reaches the panel

1. Edge on the chosen side is at least `EDGE_HURDLE`, and confidence at least `MIN_CONFIDENCE`.
2. Edge recomputed at DFlow's quoted fill price still clears the hurdle.
3. Dry run returns no error.
4. Compute units stay within the order's limit.
5. USDC leaving the wallet is positive and no more than the quote.
6. For synchronous fills, contracts received are at least the quoted minimum.
   Asynchronous orders escrow USDC and fill later, so this check is skipped and the
   panel says so.

## Checking forecast quality

```bash
.venv/bin/python -m scripts.eval_forecasts --markets 8 --label my-change
```

Forecasts a sample of live markets and prints, per market, the model probability, its
confidence and the gap to the market mid. Confidence is the model's evidence-quality
score scaled down by disagreement between ensemble runs and by failed runs. Searches
are cached in `.eval_cache/` so prompt changes are compared on the same news.

## Tests

```bash
.venv/bin/python -m pytest
```
