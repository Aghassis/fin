"""Tests for the GBM market data simulator."""

import math

import numpy as np
import pytest

from app.market.cache import price_cache
from app.market.simulator import (
    TICKER_CONFIG,
    TECH_TICKERS,
    FINANCE_TICKERS,
    _build_correlation_matrix,
    _safe_cholesky,
    ticker_config,
    Simulator,
)


def test_ticker_config_has_required_fields():
    for ticker, cfg in TICKER_CONFIG.items():
        assert "seed" in cfg, f"{ticker} missing seed"
        assert "drift" in cfg, f"{ticker} missing drift"
        assert "vol" in cfg, f"{ticker} missing vol"
        assert cfg["seed"] > 0, f"{ticker} seed must be positive"
        assert cfg["vol"] > 0, f"{ticker} volatility must be positive"


def test_correlation_matrix_is_symmetric():
    tickers = list(TICKER_CONFIG.keys())
    corr = _build_correlation_matrix(tickers)
    np.testing.assert_array_almost_equal(corr, corr.T)


def test_correlation_matrix_has_ones_on_diagonal():
    tickers = list(TICKER_CONFIG.keys())
    corr = _build_correlation_matrix(tickers)
    np.testing.assert_array_almost_equal(np.diag(corr), np.ones(len(tickers)))


def test_correlation_matrix_tech_cluster():
    tickers = list(TICKER_CONFIG.keys())
    corr = _build_correlation_matrix(tickers)
    # Find two tech tickers
    i = tickers.index("AAPL")
    j = tickers.index("GOOGL")
    assert corr[i, j] == 0.6


def test_correlation_matrix_finance_cluster():
    tickers = list(TICKER_CONFIG.keys())
    corr = _build_correlation_matrix(tickers)
    i = tickers.index("JPM")
    j = tickers.index("V")
    assert corr[i, j] == 0.5


def test_correlation_matrix_cross_sector():
    tickers = list(TICKER_CONFIG.keys())
    corr = _build_correlation_matrix(tickers)
    i = tickers.index("AAPL")
    j = tickers.index("JPM")
    assert corr[i, j] == 0.2


def test_correlation_matrix_is_positive_definite():
    """A valid correlation matrix must be positive definite for Cholesky."""
    tickers = list(TICKER_CONFIG.keys())
    corr = _build_correlation_matrix(tickers)
    # Cholesky will raise if not positive definite
    np.linalg.cholesky(corr)


def test_simulator_initializes_with_seed_prices():
    sim = Simulator()
    for ticker, cfg in TICKER_CONFIG.items():
        assert sim._prices[ticker] == cfg["seed"]


def test_simulator_step_produces_valid_prices():
    sim = Simulator()
    sim._step()
    for ticker in TICKER_CONFIG:
        assert sim._prices[ticker] >= 0.01, f"{ticker} price below floor"


def test_simulator_step_changes_prices():
    """After stepping, at least some prices should have changed."""
    sim = Simulator()
    before = dict(sim._prices)
    sim._step()
    changed = sum(1 for t in TICKER_CONFIG if sim._prices[t] != before[t])
    assert changed > 0, "No prices changed after step"


def test_simulator_price_floor():
    """Prices should never go below 0.01."""
    sim = Simulator()
    # Force very low prices
    for ticker in sim._prices:
        sim._prices[ticker] = 0.02
    sim._step()
    for ticker in sim._prices:
        assert sim._prices[ticker] >= 0.01


# ---------------------------------------------------------------------------
# Runtime ticker registration
# ---------------------------------------------------------------------------

UNKNOWN = "PYPL"  # not in TICKER_CONFIG


@pytest.fixture(autouse=True)
def clean_cache():
    """Registration writes to the shared cache — keep tests isolated."""
    yield
    for update in price_cache.get_all():
        price_cache.remove(update.ticker)


def test_ticker_config_for_unknown_ticker_is_sensible_and_deterministic():
    cfg = ticker_config(UNKNOWN)
    assert 0 < cfg["seed"] <= 500
    assert cfg["vol"] > 0
    assert cfg == ticker_config(UNKNOWN)


def test_ticker_config_prefers_hand_tuned_values():
    assert ticker_config("AAPL") == TICKER_CONFIG["AAPL"]


def test_simulator_accepts_an_explicit_ticker_universe():
    sim = Simulator(tickers=["AAPL", UNKNOWN])
    assert sim.tickers == ["AAPL", UNKNOWN]
    assert sim._prices["AAPL"] == TICKER_CONFIG["AAPL"]["seed"]
    assert sim._prices[UNKNOWN] > 0


def test_register_ticker_seeds_price_and_cache():
    sim = Simulator()
    sim.register_ticker(UNKNOWN)
    assert UNKNOWN in sim.tickers
    assert sim._prices[UNKNOWN] > 0
    assert price_cache.get(UNKNOWN).price == round(sim._prices[UNKNOWN], 2)


def test_register_ticker_normalizes_case_and_is_idempotent():
    sim = Simulator()
    sim.register_ticker(" pypl ")
    sim.register_ticker(UNKNOWN)
    assert sim.tickers.count(UNKNOWN) == 1


def test_register_ticker_does_not_disturb_existing_series():
    sim = Simulator()
    sim._step()
    before = dict(sim._prices)
    sim.register_ticker(UNKNOWN)
    for ticker, price in before.items():
        assert sim._prices[ticker] == price


def test_register_ticker_extends_the_correlation_factor():
    sim = Simulator()
    n = len(sim.tickers)
    sim.register_ticker(UNKNOWN)
    assert sim._cholesky.shape == (n + 1, n + 1)


def test_registered_ticker_is_priced_on_every_step():
    sim = Simulator()
    sim.register_ticker(UNKNOWN)
    seed = sim._prices[UNKNOWN]
    sim._step()
    assert sim._prices[UNKNOWN] != seed
    assert price_cache.get(UNKNOWN) is not None


def test_unregister_ticker_stops_pricing_it():
    sim = Simulator()
    sim.register_ticker(UNKNOWN)
    sim.unregister_ticker(UNKNOWN)

    assert UNKNOWN not in sim.tickers
    assert UNKNOWN not in sim._prices
    assert price_cache.get(UNKNOWN) is None

    sim._step()
    assert price_cache.get(UNKNOWN) is None


def test_unregister_ticker_leaves_the_rest_intact():
    sim = Simulator()
    sim._step()
    before = dict(sim._prices)
    sim.unregister_ticker("NFLX")
    del before["NFLX"]
    assert sim._prices == before
    assert sim._cholesky.shape == (len(before), len(before))


def test_unregister_unknown_ticker_is_a_no_op():
    sim = Simulator()
    sim.unregister_ticker("ZZZZ")
    assert len(sim.tickers) == len(TICKER_CONFIG)


def test_step_with_no_tickers_does_nothing():
    sim = Simulator(tickers=[])
    sim._step()  # must not raise
    assert sim.tickers == []


def test_correlation_matrix_stays_positive_definite_with_unknown_tickers():
    tickers = list(TICKER_CONFIG.keys()) + ["PYPL", "SHOP", "SQ", "COIN", "ABNB"]
    corr = _build_correlation_matrix(tickers)
    np.linalg.cholesky(corr)  # raises if not positive definite


def test_unknown_tickers_correlate_across_sectors():
    tickers = ["AAPL", UNKNOWN]
    corr = _build_correlation_matrix(tickers)
    assert corr[0, 1] == 0.2


def test_safe_cholesky_falls_back_for_a_non_positive_definite_matrix():
    bad = np.array([[1.0, 1.5], [1.5, 1.0]])
    factor = _safe_cholesky(bad)
    assert factor.shape == (2, 2)
    assert np.all(np.isfinite(factor))


def test_safe_cholesky_matches_numpy_for_a_valid_matrix():
    corr = _build_correlation_matrix(list(TICKER_CONFIG.keys()))
    np.testing.assert_array_almost_equal(_safe_cholesky(corr), np.linalg.cholesky(corr))
