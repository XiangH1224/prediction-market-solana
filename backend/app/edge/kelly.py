def kelly_fraction_binary(p_win: float, price: float) -> float:
    """Full-Kelly bankroll fraction for a binary contract bought at `price` that pays $1.

    Net odds are b = (1 - price) / price, so f* = (b*p - q) / b = (p - price) / (1 - price).
    Returns 0 when there is no positive edge or the price is degenerate.
    """
    if not 0 < price < 1 or not 0 <= p_win <= 1:
        return 0.0
    return max(0.0, (p_win - price) / (1 - price))


def stake_fraction(p_win: float, price: float, fraction: float, cap: float) -> float:
    """Fractional Kelly, capped at `cap` of bankroll."""
    return min(kelly_fraction_binary(p_win, price) * fraction, cap)
