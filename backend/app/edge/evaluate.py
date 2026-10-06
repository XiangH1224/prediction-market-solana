from ..config import Settings
from ..models import EdgeDecision, Prediction, Quote, Side
from .kelly import kelly_fraction_binary, stake_fraction


def evaluate(prediction: Prediction, quote: Quote, bankroll_usd: float, settings: Settings) -> EdgeDecision | None:
    """Pick the better side and size it.

    Each side is priced against its own ask: buying YES costs yes_ask and wins with
    p_true, buying NO costs no_ask and wins with 1 - p_true. Returns None when the
    book has no ask on either side.
    """
    candidates: list[tuple[Side, float, float]] = []
    if quote.yes_ask is not None and 0 < quote.yes_ask < 1:
        candidates.append(("yes", prediction.p_true, quote.yes_ask))
    if quote.no_ask is not None and 0 < quote.no_ask < 1:
        candidates.append(("no", 1 - prediction.p_true, quote.no_ask))
    if not candidates:
        return None

    side, p_win, price = max(candidates, key=lambda c: c[1] - c[2])
    return size_position(side, p_win, price, prediction.confidence, bankroll_usd, settings)


def size_position(
    side: Side, p_win: float, price: float, confidence: float, bankroll_usd: float, settings: Settings
) -> EdgeDecision:
    edge = p_win - price
    decision = EdgeDecision(side=side, p_win=p_win, price=price, edge=edge, actionable=False)

    if edge < settings.edge_hurdle:
        decision.reason = f"edge {edge:.3f} below hurdle {settings.edge_hurdle:.3f}"
        return decision
    if confidence < settings.min_confidence:
        decision.reason = f"confidence {confidence:.2f} below minimum {settings.min_confidence:.2f}"
        return decision

    decision.kelly_full = kelly_fraction_binary(p_win, price)
    decision.stake_fraction = stake_fraction(p_win, price, settings.kelly_fraction, settings.max_position_fraction)
    stake = min(bankroll_usd * decision.stake_fraction, settings.max_trade_usd)
    if stake < settings.min_trade_usd:
        decision.reason = f"stake ${stake:.2f} below minimum ${settings.min_trade_usd:.2f}"
        return decision

    decision.stake_usd = round(stake, 2)
    decision.contracts = decision.stake_usd / price
    decision.actionable = True
    return decision
