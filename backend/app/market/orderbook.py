import time

from ..models import Quote

LADDER_DEPTH = 5


def _price(value) -> float | None:
    """DFlow sends prices as dollar strings such as "0.7700"; missing sides come as null or ""."""
    try:
        price = float(value)
    except (TypeError, ValueError):
        return None
    return price if 0 < price < 1 else None


def _ladder(levels) -> list[tuple[float, float]]:
    """Bid ladders arrive as a {price: size} map. Returns [price, size] pairs, best bid first."""
    if not isinstance(levels, dict):
        return []
    parsed = []
    for price, size in levels.items():
        p = _price(price)
        try:
            s = float(size)
        except (TypeError, ValueError):
            continue
        if p is not None and s > 0:
            parsed.append((p, s))
    return sorted(parsed, reverse=True)


class OrderBookMirror:
    """In-memory top of book per market, fed by the stream so scans never hit REST."""

    def __init__(self):
        self._quotes: dict[str, Quote] = {}

    def get(self, ticker: str) -> Quote | None:
        return self._quotes.get(ticker)

    def age(self, ticker: str) -> float:
        quote = self._quotes.get(ticker)
        return time.time() - quote.updated_at if quote else float("inf")

    def update_prices(self, ticker: str, yes_bid=None, yes_ask=None, no_bid=None, no_ask=None) -> Quote:
        quote = self._quotes.setdefault(ticker, Quote())
        quote.yes_bid = _price(yes_bid)
        quote.yes_ask = _price(yes_ask)
        quote.no_bid = _price(no_bid)
        quote.no_ask = _price(no_ask)
        quote.updated_at = time.time()
        return quote

    def update_ladders(self, ticker: str, yes_bids, no_bids) -> Quote:
        """Apply an orderbook snapshot. The book only carries bids, so each ask is
        implied by the opposite side: yes_ask = 1 - best no_bid."""
        quote = self._quotes.setdefault(ticker, Quote())
        yes, no = _ladder(yes_bids), _ladder(no_bids)
        quote.yes_bids, quote.no_bids = yes[:LADDER_DEPTH], no[:LADDER_DEPTH]
        quote.yes_bid = yes[0][0] if yes else None
        quote.no_bid = no[0][0] if no else None
        quote.yes_ask = round(1 - no[0][0], 4) if no else None
        quote.no_ask = round(1 - yes[0][0], 4) if yes else None
        quote.updated_at = time.time()
        return quote
