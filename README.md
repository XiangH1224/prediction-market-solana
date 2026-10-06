# PredictFlow

## Run it

One-time setup: `npm install`, then `cd backend && python3.13 -m venv .venv && .venv/bin/pip install -r requirements.txt`, and fill in `backend/.env` (see `backend/.env.example`).

```bash
npm start
```

This builds the panel and runs the analysis backend (port 8000) until Ctrl+C; the backend starts the Kalshi market relay (port 4178) itself, so starting it directly with `uvicorn` works too. Then load this folder as an unpacked extension at `chrome://extensions` and open the side panel, or open http://localhost:8000/predictflow/ in a tab (saving analyses and Following need the extension).

**Analyze this market** is answered by the backend in `backend/`: the model writes search queries, Tavily runs them, the results are condensed into an evidence report, several forecast runs are combined, and the estimate is compared with the live price (see `backend/README.md`). The panel shows each step as it runs. The panel itself only lists Kalshi markets and displays the result; it does no news retrieval or model calls of its own.

## Running the current prototype

Results are one **Overall Conclusion**: the Yes/No probabilities, whether the price is worth buying at (edge and confidence), and the model's reasoning. Below it are the linked sources. **Load More Sources** expands already-retrieved results.

**Save Analysis** stores an immutable snapshot under the exact market ticker and automatically follows that market. Open **Following → market → Saved Analyses** to revisit snapshots. **Compare with Previous Analysis** shows probability changes, changed evidence/sources, and a concise model explanation tied to the previous saved snapshot supplied during analysis. If that baseline was not supplied, the interface explicitly avoids attributing the probability change to a cause. Saving requires Chrome local storage; failures leave the current result visible and do not claim it was saved. Saved events remain available in Following even when absent from the current market catalogue.

After the complete analysis, **Buy position** opens confirmation with both Yes and No selectable, quantity, purchase amount, current price and implied probability, and estimated position received. **Confirm Purchase** opens a continuous local checkout: select the Solana account, approve connection, wait for route preparation, review the quote, and approve or reject the purchase. Submission, processing, and settlement advance automatically after approval, followed by a position summary and receipt. Cancelling confirmation returns to the analysis. Expired quotes require renewed review, insufficient balances allow amount changes, and failed fills release reserved funds. The interface uses ordinary purchase wording with a persistent **No funds move** indicator. Wallet connection, signatures, fees, routing, and settlement are local models, not a live DFlow integration or a replica of a specific wallet. Each new session starts with 1,000 units of session-specific USDC; successful settlement saves the receipt and activity history in `lastSimulatedPurchase`. No DFlow API request, real wallet interaction, transaction submission, or live order is implemented.

Run `npm test` for the panel tests in `tests/` (root-level legacy test copies use invalid parent-directory imports) and `cd backend && .venv/bin/python -m pytest` for the backend. `npm start` rebuilds the panel; run `npm run build:panel` yourself only if you start the services separately.

After changing extension code, reload PredictFlow at `chrome://extensions` and reopen its side panel. If the backend, the search or the model fails, a dedicated error screen offers **Retry analysis**.

PredictFlow is a Chrome side-panel assistant that helps users research prediction-market events. It combines web research, a model-based forecast from a local backend, and Solana-based transaction support in one interface.

PredictFlow is currently designed around Kalshi prediction markets, with plans to support additional prediction markets in the future.

## Why it matters

Prediction markets reduce complex events to simple Yes-or-No prices, but the price alone does not explain the evidence behind it. Users must compare recent reporting, understand the event rules, check publication dates, and identify repeated or conflicting information.

PredictFlow collects relevant coverage and presents evidence for both possible outcomes. It also shows when the available evidence is too weak or conflicting to support either side.

The goal is to help users make more informed and transparent decisions before purchasing a prediction-market position.

## Main functions

### Search events

Users can search for prediction-market events and review:

- The event question
- Available outcomes
- Closing date
- Current price
- Resolution rules

PredictFlow initially focuses on events connected to Kalshi.

### Find relevant news

The backend has the model write three searches for the selected event (latest news, the deciding official source, and background for a base rate) and runs them. The panel displays each result's title, publisher, date and original link.

### Analyze both outcomes

The backend condenses the search results into a dated evidence report, then forecasts the market several times from that report without seeing the price. The runs are combined into one probability; disagreement between runs lowers the confidence score. The result is then compared with the live price to say whether either side is worth buying.

### Support Solana transactions

When a prediction market and the user’s location permit participation, PredictFlow can use Solana as the transaction layer for purchasing supported prediction-market positions.

The user reviews the outcome, amount, price, and transaction details before approving the transaction through a compatible Solana wallet.

Using Solana does not override a prediction market’s country restrictions, identity requirements, or local laws. International users can participate only when the specific market and connected service permit them to do so.

## Why Solana is useful for PredictFlow

### Fast transactions

Solana transactions generally confirm quickly, allowing a user to respond to changing events and market prices without a long settlement delay.

### Low network costs

Low fees make smaller prediction-market purchases more practical. This is especially useful when the network fee would otherwise represent a significant percentage of the position.

### International payment infrastructure

Solana provides a shared transaction network that can be accessed through compatible wallets around the world. This can make cross-border participation simpler when the prediction market permits users from the relevant country.

### User-approved purchases

The user approves each transaction directly through their wallet. PredictFlow prepares the transaction but does not control the wallet or authorize the purchase independently.

### Verifiable transaction history

Completed transactions can be inspected on Solana, giving users a transparent record of the wallet, time, asset, and transaction status.

### Composable prediction positions

Supported prediction-market outcomes can be represented as Solana tokens. This allows PredictFlow to connect research, wallet approval, position ownership, and future on-chain applications within the same ecosystem.

## How it works

```text
Chrome side panel
  ├── Prediction-event search
  ├── Event prices and resolution rules
  ├── Analysis from the local backend (search, evidence report, forecast, edge)
  └── User-approved Solana transaction
```

## Technology

| Component | Purpose |
| --- | --- |
| Chrome side-panel extension | Provides the PredictFlow interface |
| FastAPI backend (`backend/`) | Researches and forecasts the selected market |
| Tavily | Web and news search for the research step |
| Any OpenAI-compatible model | Writes the searches, the evidence report and the forecasts; set in `backend/.env` |
| Kalshi relay (`news-proxy.mjs`) | Serves Kalshi's public market list and quotes to the panel |
| Prediction-market data source | Supplies events, prices, deadlines, and rules |
| Solana wallet | Allows the user to approve transactions |
| Solana | Processes supported prediction-market purchases |

Pointing the backend at a local model avoids per-request AI charges. Internet access is required for current news, event data, and blockchain transactions.

## Current and future market support

PredictFlow is currently being developed for Kalshi prediction markets. Solana access to Kalshi-related positions may depend on connected services such as tokenization or liquidity providers, as well as the user’s eligibility.

Future versions can expand to other prediction markets by adding adapters for their:

- Event catalogues
- Prices and liquidity
- Resolution rules
- Outcome assets
- Transaction services

This approach allows PredictFlow to keep the same research experience while supporting multiple prediction-market providers.

## Project scope

PredictFlow is a research and transaction-assistance tool. It does not guarantee accurate predictions or profitable outcomes.

Every purchase remains the user’s decision and requires wallet approval. Availability depends on the prediction market, connected transaction provider, user location, and applicable eligibility requirements.# PredictFlow Demo

A local-first Chrome side-panel prototype for researching sample prediction-market events and recording simulated practice positions.

## Install in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select this project folder.
4. Click the PredictFlow toolbar icon to open the side panel.

## Current scope

- Six labeled sample events with resolution rules and official source links.
- Search, event research, example Yes/No/Wait analysis, and simulated position review.
- Practice portfolio saved using `chrome.storage.local`.
- Optional GDELT headline search for an event; article text is not fetched.
- No wallet connection, on-chain transaction, or real trading.

Sample prices and example analysis are illustrative only. GDELT receives the event's news search query. The portfolio is local demo data, not a real position. A future Devnet receipt would record a demo action only and would not represent an outcome token or market purchase.

