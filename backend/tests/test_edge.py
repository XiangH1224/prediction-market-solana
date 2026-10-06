import pytest

from app.config import Settings
from app.edge.evaluate import evaluate
from app.edge.kelly import kelly_fraction_binary, stake_fraction
from app.models import Prediction, Quote


def settings(**overrides) -> Settings:
    base = dict(edge_hurdle=0.06, kelly_fraction=0.25, max_position_fraction=0.05, max_trade_usd=25,
                min_trade_usd=1, min_confidence=0.5)
    return Settings(**{**base, **overrides})


def prediction(p_true: float, confidence: float = 0.8) -> Prediction:
    return Prediction(p_true=p_true, confidence=confidence, rationale="r")


def test_kelly_matches_closed_form():
    # p=0.6 at 0.5: b=1, f* = (1*0.6 - 0.4)/1 = 0.2
    assert kelly_fraction_binary(0.6, 0.5) == pytest.approx(0.2)
    # p=0.8 at 0.7: f* = 0.1/0.3
    assert kelly_fraction_binary(0.8, 0.7) == pytest.approx(1 / 3)


def test_kelly_is_zero_without_edge_or_at_degenerate_prices():
    assert kelly_fraction_binary(0.4, 0.5) == 0
    assert kelly_fraction_binary(0.9, 0) == 0
    assert kelly_fraction_binary(0.9, 1) == 0


def test_fractional_kelly_is_capped():
    assert stake_fraction(0.6, 0.5, 0.25, 0.5) == pytest.approx(0.05)
    assert stake_fraction(0.99, 0.5, 1.0, 0.05) == 0.05


def test_buys_yes_when_model_is_above_the_ask():
    d = evaluate(prediction(0.70), Quote(yes_ask=0.60, no_ask=0.42), 1000, settings())
    assert d.side == "yes" and d.actionable
    assert d.edge == pytest.approx(0.10)
    # Kelly 0.25, quarter Kelly 0.0625, capped at 5% of $1000 = $50, then at the $25 trade cap.
    assert d.stake_usd == 25
    assert d.contracts == pytest.approx(25 / 0.60)


def test_buys_no_when_model_is_below_the_market():
    d = evaluate(prediction(0.20), Quote(yes_ask=0.41, no_ask=0.61), 1000, settings())
    assert d.side == "no" and d.actionable
    assert d.p_win == pytest.approx(0.80)
    assert d.edge == pytest.approx(0.19)


def test_edge_inside_the_hurdle_is_not_actionable():
    d = evaluate(prediction(0.65), Quote(yes_ask=0.60, no_ask=0.42), 1000, settings())
    assert not d.actionable and "hurdle" in d.reason


def test_spread_can_remove_an_apparent_no_edge():
    # p_true is 7 points under the YES ask, but NO costs 0.50, so the NO edge is only 0.03.
    d = evaluate(prediction(0.47), Quote(yes_ask=0.54, no_ask=0.50), 1000, settings())
    assert not d.actionable


def test_low_confidence_blocks_the_trade():
    d = evaluate(prediction(0.80, confidence=0.3), Quote(yes_ask=0.60, no_ask=0.42), 1000, settings())
    assert not d.actionable and "confidence" in d.reason


def test_small_bankroll_falls_below_minimum_stake():
    d = evaluate(prediction(0.70), Quote(yes_ask=0.60, no_ask=0.42), 10, settings())
    assert not d.actionable and "minimum" in d.reason


def test_no_asks_means_no_decision():
    assert evaluate(prediction(0.70), Quote(), 1000, settings()) is None
