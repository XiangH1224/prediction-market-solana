# FieldNote

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

Every purchase remains the user’s decision and requires wallet approval. Availability depends on the prediction market, connected transaction provider, user location, and applicable eligibility requirements.