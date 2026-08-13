"""Geometric Brownian Motion market data simulator."""

import asyncio
import math
import random
import zlib

import numpy as np

from app.market.cache import price_cache
from app.market.interface import MarketDataProvider

# Seed prices and per-ticker parameters (annual drift, annual volatility)
TICKER_CONFIG = {
    "AAPL": {"seed": 190.0, "drift": 0.08, "vol": 0.25},
    "GOOGL": {"seed": 175.0, "drift": 0.10, "vol": 0.28},
    "MSFT": {"seed": 420.0, "drift": 0.09, "vol": 0.24},
    "AMZN": {"seed": 185.0, "drift": 0.12, "vol": 0.30},
    "TSLA": {"seed": 250.0, "drift": 0.05, "vol": 0.50},
    "NVDA": {"seed": 880.0, "drift": 0.15, "vol": 0.40},
    "META": {"seed": 500.0, "drift": 0.10, "vol": 0.32},
    "JPM": {"seed": 195.0, "drift": 0.06, "vol": 0.20},
    "V": {"seed": 280.0, "drift": 0.07, "vol": 0.18},
    "NFLX": {"seed": 630.0, "drift": 0.11, "vol": 0.35},
}

# Correlation matrix sectors: tech stocks correlated, finance separate
TECH_TICKERS = ["AAPL", "GOOGL", "MSFT", "AMZN", "TSLA", "NVDA", "META", "NFLX"]
FINANCE_TICKERS = ["JPM", "V"]

UPDATE_INTERVAL = 0.5  # seconds
EVENT_PROBABILITY = 0.005  # per ticker per update
EVENT_MIN_PCT = 0.02
EVENT_MAX_PCT = 0.05

# Parameters for tickers added at runtime that have no hand-tuned config
UNKNOWN_DRIFT = 0.08
UNKNOWN_VOL = 0.30
UNKNOWN_SEED_MIN = 20.0
UNKNOWN_SEED_MAX = 500.0


def ticker_config(ticker: str) -> dict:
    """Return GBM parameters for a ticker, deriving them if it is unknown.

    Unknown tickers get a deterministic seed price in a plausible range so a
    ticker added at runtime looks like a real instrument and prices the same
    way across restarts.
    """
    cfg = TICKER_CONFIG.get(ticker)
    if cfg is not None:
        return cfg

    span = UNKNOWN_SEED_MAX - UNKNOWN_SEED_MIN
    offset = zlib.crc32(ticker.encode()) % int(span * 100)
    return {
        "seed": round(UNKNOWN_SEED_MIN + offset / 100.0, 2),
        "drift": UNKNOWN_DRIFT,
        "vol": UNKNOWN_VOL,
    }


def _build_correlation_matrix(tickers: list[str]) -> np.ndarray:
    """Build a correlation matrix with tech and finance clusters."""
    n = len(tickers)
    corr = np.eye(n)
    for i in range(n):
        for j in range(i + 1, n):
            ti, tj = tickers[i], tickers[j]
            if ti in TECH_TICKERS and tj in TECH_TICKERS:
                corr[i, j] = corr[j, i] = 0.6
            elif ti in FINANCE_TICKERS and tj in FINANCE_TICKERS:
                corr[i, j] = corr[j, i] = 0.5
            else:
                corr[i, j] = corr[j, i] = 0.2
    return corr


def _safe_cholesky(corr: np.ndarray) -> np.ndarray:
    """Cholesky factor of a correlation matrix, shrinking toward identity if needed.

    Tickers registered at runtime widen the matrix, so guard against a
    combination that is not quite positive definite rather than letting an
    API call blow up.
    """
    n = corr.shape[0]
    identity = np.eye(n)
    for weight in (0.0, 0.01, 0.05, 0.2, 0.5, 1.0):
        try:
            return np.linalg.cholesky((1 - weight) * corr + weight * identity)
        except np.linalg.LinAlgError:
            continue
    return identity


class Simulator(MarketDataProvider):
    """GBM-based market data simulator."""

    def __init__(self, tickers: list[str] | None = None):
        self._task: asyncio.Task | None = None
        self._tickers: list[str] = []
        self._config: dict[str, dict] = {}
        self._prices: dict[str, float] = {}
        self._dt = UPDATE_INTERVAL / (252 * 6.5 * 3600)  # fraction of trading year
        self._cholesky = np.zeros((0, 0))

        for ticker in tickers if tickers is not None else TICKER_CONFIG:
            self._track(ticker.upper().strip())
        self._rebuild_cholesky()

    @property
    def tickers(self) -> list[str]:
        return list(self._tickers)

    def _track(self, ticker: str) -> bool:
        """Add a ticker to the simulated universe. Returns False if already tracked."""
        if not ticker or ticker in self._prices:
            return False
        cfg = ticker_config(ticker)
        self._config[ticker] = cfg
        self._prices[ticker] = cfg["seed"]
        self._tickers.append(ticker)
        return True

    def _rebuild_cholesky(self) -> None:
        """Recompute the correlated-draw factor for the current ticker set.

        Only the draw factor changes — existing price series are untouched.
        """
        self._cholesky = _safe_cholesky(_build_correlation_matrix(self._tickers))

    def register_ticker(self, ticker: str) -> None:
        """Start simulating a ticker added at runtime and seed its price."""
        ticker = ticker.upper().strip()
        if not ticker:
            return
        if self._track(ticker):
            self._rebuild_cholesky()
        if price_cache.get(ticker) is None:
            price_cache.update(ticker, self._prices[ticker])

    def unregister_ticker(self, ticker: str) -> None:
        """Stop simulating a ticker and drop it from the price cache."""
        ticker = ticker.upper().strip()
        if ticker not in self._prices:
            return
        self._tickers.remove(ticker)
        del self._prices[ticker]
        self._config.pop(ticker, None)
        self._rebuild_cholesky()
        price_cache.remove(ticker)

    async def start(self) -> None:
        """Start the simulation loop."""
        # Seed initial prices into cache
        for ticker, price in self._prices.items():
            price_cache.update(ticker, price)
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        """Stop the simulation loop."""
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _run(self) -> None:
        """Main simulation loop."""
        while True:
            self._step()
            await asyncio.sleep(UPDATE_INTERVAL)

    def _step(self) -> None:
        """Advance all prices by one GBM step with correlation."""
        n = len(self._tickers)
        if n == 0:
            return
        # Correlated normal draws
        z_independent = np.random.standard_normal(n)
        z_correlated = self._cholesky @ z_independent

        for i, ticker in enumerate(self._tickers):
            cfg = self._config[ticker]
            drift = cfg["drift"]
            vol = cfg["vol"]
            s = self._prices[ticker]

            # GBM: dS = S * (mu*dt + sigma*sqrt(dt)*Z)
            ds = s * (drift * self._dt + vol * math.sqrt(self._dt) * z_correlated[i])
            new_price = s + ds

            # Random event: sudden 2-5% move
            if random.random() < EVENT_PROBABILITY:
                pct = random.uniform(EVENT_MIN_PCT, EVENT_MAX_PCT)
                sign = random.choice([-1, 1])
                new_price *= 1 + sign * pct

            new_price = max(new_price, 0.01)  # floor at 1 cent
            self._prices[ticker] = new_price
            price_cache.update(ticker, new_price)
