from datetime import datetime, timezone

from ..config import Settings
from ..models import Quote


def in_price_band(quote: Quote, settings: Settings) -> bool:
    """Long shots and near-locks are where a forecast error of a few points looks like a
    large edge, so only markets with a YES price inside the band are forecast."""
    price = quote.yes_ask if quote.yes_ask is not None else quote.yes_bid
    return price is not None and settings.min_price <= price <= settings.max_price


def days_to_close(close_time: str, now: datetime | None = None) -> float | None:
    try:
        closes = datetime.fromisoformat(close_time.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        return None
    if closes.tzinfo is None:
        closes = closes.replace(tzinfo=timezone.utc)
    return (closes - (now or datetime.now(timezone.utc))).total_seconds() / 86400


def closes_soon_enough(close_time: str, settings: Settings) -> bool:
    """Recent news says little about a market that resolves years out. Unknown close times pass."""
    days = days_to_close(close_time)
    return days is None or 0 < days <= settings.max_days_to_close
