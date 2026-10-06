# FieldNote

## Running the current prototype

The analysis policy in `analysis-prompt.js` preserves the supplied evidence-based Kalshi prompt, with the latest display requirements applied in the request contract. Results start with **Overall Conclusion**, at most five numbered sentences in this order: final Yes/No decision and probabilities, concrete market signal, strongest counter-signal, critical unknowns, and how uncertainty affects the probability and final decision. Exactly balanced probabilities have no favored side; insufficient evidence produces an explicit unavailable assessment. New results store these four explanatory sentences in structured fields; older saved analyses remain readable without rewriting their snapshots. Resolution interpretation, methodology, and retrieval details remain in the background. The screen shows only material Yes/No evidence, up to three critical unknowns, and three linked sources with key evidence. **Load More Sources** expands already-retrieved articles.

**Save Analysis** stores an immutable snapshot under the exact market ticker and automatically follows that market. Open **Following → market → Saved Analyses** to revisit snapshots. **Compare with Previous Analysis** shows probability changes, changed evidence/sources, and a concise model explanation tied to the previous saved snapshot supplied during analysis. If that baseline was not supplied, the interface explicitly avoids attributing the probability change to a cause. Saving requires Chrome local storage; failures leave the current result visible and do not claim it was saved. Saved events remain available in Following even when absent from the current market catalogue. The research relay supplements reporting with relevant retrieved records; it does not provide a statistically calibrated forecasting model.

After the complete analysis, **Buy position** opens confirmation with both Yes and No selectable, quantity, purchase amount, current price and implied probability, and estimated position received. **Confirm Purchase** opens a continuous local checkout: select the Solana account, approve connection, wait for route preparation, review the quote, and approve or reject the purchase. Submission, processing, and settlement advance automatically after approval, followed by a position summary and receipt. Cancelling confirmation returns to the analysis. Expired quotes require renewed review, insufficient balances allow amount changes, and failed fills release reserved funds. The interface uses ordinary purchase wording with a persistent **No funds move** indicator. Wallet connection, signatures, fees, routing, and settlement are local models, not a live DFlow integration or a replica of a specific wallet. Each new session starts with 1,000 units of session-specific USDC; successful settlement saves the receipt and activity history in `lastSimulatedPurchase`. No DFlow API request, real wallet interaction, transaction submission, or live order is implemented.

Run `npm test` to execute the maintained `tests/` suite (root-level legacy test copies use invalid parent-directory imports). Run `npm run build:panel` before loading or reloading the unpacked extension. Start the market/news relay with `npm run news:proxy`, and start LM Studio's local server on `127.0.0.1:1234` with a chat model loaded.

Market analysis first requests GNews through the relay. If GNews is unconfigured, unavailable, or returns no articles, the extension falls back to Google News RSS through the relay's `/rss` endpoint. The relay caches RSS feeds for five minutes; the extension does not request Google News directly. RSS analysis uses headlines and metadata only; the results identify that source. Set `GNEWS_API_KEY` in the relay environment to use GNews descriptions and available excerpts.

After changing extension code, reload Fieldnote at `chrome://extensions` and reopen its side panel. Analysis displays progress, followed by a verdict, estimated Yes probability, rationale, and cited sources. If news or the local model fails, a dedicated error screen offers **Retry analysis**.

FieldNote is a Chrome side-panel assistant that helps users research prediction-market events. It combines Google News RSS, a locally running AI model, and Solana-based transaction support in one interface.

FieldNote is currently designed around Kalshi prediction markets, with plans to support additional prediction markets in the future.

## Why it matters

Prediction markets reduce complex events to simple Yes-or-No prices, but the price alone does not explain the evidence behind it. Users must compare recent reporting, understand the event rules, check publication dates, and identify repeated or conflicting information.

FieldNote collects relevant coverage and presents evidence for both possible outcomes. It also shows when the available evidence is too weak or conflicting to support either side.

The goal is to help users make more informed and transparent decisions before purchasing a prediction-market position.

## Main functions

### Search events

Users can search for prediction-market events and review:

- The event question
- Available outcomes
- Closing date
- Current price
- Resolution rules

FieldNote initially focuses on events connected to Kalshi.

### Find relevant news

FieldNote creates a focused Google News RSS search for the selected event. It displays:

- Recent headlines
- Publishers
- Publication dates
- Original source links

It also reduces obvious duplicate coverage so that repeated versions of the same report are not treated as independent evidence.

### Analyze both outcomes

FieldNote sends the event rules and selected news evidence to a local Qwen model through LM Studio.

The model uses the supplied sources and indicates when there is insufficient information to support a conclusion.

### Support Solana transactions

When a prediction market and the user’s location permit participation, FieldNote can use Solana as the transaction layer for purchasing supported prediction-market positions.

The user reviews the outcome, amount, price, and transaction details before approving the transaction through a compatible Solana wallet.

Using Solana does not override a prediction market’s country restrictions, identity requirements, or local laws. International users can participate only when the specific market and connected service permit them to do so.

## Why Solana is useful for FieldNote

### Fast transactions

Solana transactions generally confirm quickly, allowing a user to respond to changing events and market prices without a long settlement delay.

### Low network costs

Low fees make smaller prediction-market purchases more practical. This is especially useful when the network fee would otherwise represent a significant percentage of the position.

### International payment infrastructure

Solana provides a shared transaction network that can be accessed through compatible wallets around the world. This can make cross-border participation simpler when the prediction market permits users from the relevant country.

### User-approved purchases

The user approves each transaction directly through their wallet. FieldNote prepares the transaction but does not control the wallet or authorize the purchase independently.

### Verifiable transaction history

Completed transactions can be inspected on Solana, giving users a transparent record of the wallet, time, asset, and transaction status.

### Composable prediction positions

Supported prediction-market outcomes can be represented as Solana tokens. This allows FieldNote to connect research, wallet approval, position ownership, and future on-chain applications within the same ecosystem.

## How it works

```text
Chrome side panel
  ├── Prediction-event search
  ├── Event prices and resolution rules
  ├── Google News RSS results
  ├── Local Qwen analysis through LM Studio
  ├── Yes / No / Wait comparison
  └── User-approved Solana transaction
```

## Technology

| Component | Purpose |
| --- | --- |
| Chrome side-panel extension | Provides the FieldNote interface |
| Google News RSS | Finds recent coverage related to an event |
| LM Studio | Runs the AI model locally |
| Qwen3.5 | Compares evidence for Yes, No, and Wait |
| Prediction-market data source | Supplies events, prices, deadlines, and rules |
| Solana wallet | Allows the user to approve transactions |
| Solana | Processes supported prediction-market purchases |

Running the model locally avoids per-request AI charges. Internet access is required for current news, event data, and blockchain transactions.

## Current and future market support

FieldNote is currently being developed for Kalshi prediction markets. Solana access to Kalshi-related positions may depend on connected services such as tokenization or liquidity providers, as well as the user’s eligibility.

Future versions can expand to other prediction markets by adding adapters for their:

- Event catalogues
- Prices and liquidity
- Resolution rules
- Outcome assets
- Transaction services

This approach allows FieldNote to keep the same research experience while supporting multiple prediction-market providers.

## Project scope

FieldNote is a research and transaction-assistance tool. It does not guarantee accurate predictions or profitable outcomes.

Every purchase remains the user’s decision and requires wallet approval. Availability depends on the prediction market, connected transaction provider, user location, and applicable eligibility requirements.# Fieldnote Demo

A local-first Chrome side-panel prototype for researching sample prediction-market events and recording simulated practice positions.

## Install in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select this project folder.
4. Click the Fieldnote toolbar icon to open the side panel.

## Current scope

- Six labeled sample events with resolution rules and official source links.
- Search, event research, example Yes/No/Wait analysis, and simulated position review.
- Practice portfolio saved using `chrome.storage.local`.
- Optional GDELT headline search for an event; article text is not fetched.
- Optional LM Studio requests to `127.0.0.1:1234` after the user tests the connection.
- No wallet connection, on-chain transaction, or real trading.

Sample prices and example analysis are illustrative only. GDELT receives the event's news search query. Model prompts are sent only to the local LM Studio endpoint. The portfolio is local demo data, not a real position. A future Devnet receipt would record a demo action only and would not represent an outcome token or market purchase.

If LM Studio is running but the extension cannot connect, check its local server and CORS settings. The extension does not expose the model server to the network.


## Free research connectors

See [DATA_SOURCES.md](DATA_SOURCES.md) for backend credentials, exact market mappings, provider behavior, panel testing, live verification results, and startup commands. Copy `.env.example` to `.env`; credentials stay in the backend. The Sources section reports configuration, fetching, retrieval, cache, empty and error states independently. Fed RSS, BLS v2, FRED/ALFRED, SEC submissions/facts/filing excerpts, NWS and optional free SportsDB v1 are connected through the existing relay. Ambiguous mappings remain unresolved.
