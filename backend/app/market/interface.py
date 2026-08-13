"""Abstract market data provider interface."""

from abc import ABC, abstractmethod


class MarketDataProvider(ABC):
    """Abstract base for market data providers."""

    @abstractmethod
    async def start(self) -> None:
        """Start producing price updates."""

    @abstractmethod
    async def stop(self) -> None:
        """Stop producing price updates."""

    @abstractmethod
    def register_ticker(self, ticker: str) -> None:
        """Start producing prices for a ticker added at runtime.

        Must be idempotent: registering a ticker that is already tracked is a
        no-op.
        """

    @abstractmethod
    def unregister_ticker(self, ticker: str) -> None:
        """Stop producing prices for a ticker and drop it from the cache.

        Must be idempotent: unregistering an unknown ticker is a no-op.
        """

    @property
    @abstractmethod
    def tickers(self) -> list[str]:
        """Tickers currently being priced."""
