import json
import os
import time
import uuid

from .market.orderbook import OrderBookMirror
from .models import Market, Side


class PaperBook:
    """Simulated positions bought with pretend dollars, kept in a JSON file between runs."""

    def __init__(self, path: str, bankroll_usd: float):
        self.path = path
        self.bankroll_usd = bankroll_usd
        self.positions: list[dict] = []
        if os.path.exists(path):
            with open(path) as f:
                self.positions = json.load(f)

    @property
    def cash(self) -> float:
        return self.bankroll_usd - sum(p["stake_usd"] for p in self.positions)

    def tickers(self) -> list[str]:
        return sorted({p["ticker"] for p in self.positions})

    def buy(self, market: Market, side: Side, price: float, stake_usd: float) -> dict:
        if not 0 < price < 1:
            raise ValueError("no ask to buy at")
        stake_usd = round(min(stake_usd, self.cash), 2)
        if stake_usd <= 0:
            raise ValueError("paper bankroll is spent")
        position = {
            "id": uuid.uuid4().hex,
            "ticker": market.ticker,
            "question": market.question,
            "side": side,
            "price": price,
            "contracts": round(stake_usd / price, 2),
            "stake_usd": stake_usd,
            "bought_at": time.time(),
        }
        self.positions.append(position)
        with open(self.path, "w") as f:
            json.dump(self.positions, f, indent=1)
        return position

    def snapshot(self, mirror: OrderBookMirror) -> dict:
        """Positions marked at the current bid for their side, which is what selling now would fetch."""
        rows = []
        for p in self.positions:
            quote = mirror.get(p["ticker"])
            bid = (quote.yes_bid if p["side"] == "yes" else quote.no_bid) if quote else None
            value = round(p["contracts"] * bid, 2) if bid is not None else None
            rows.append({**p, "bid": bid, "value_usd": value, "pnl_usd": None if value is None else round(value - p["stake_usd"], 2)})
        return {"cash_usd": round(self.cash, 2), "bankroll_usd": self.bankroll_usd, "positions": rows}
