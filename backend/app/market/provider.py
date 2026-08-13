"""Environment-driven market data provider selection and process-wide access."""

import os

from app.market.interface import MarketDataProvider

# The live provider, set at app startup. None outside the app lifespan (e.g. in
# unit tests), in which case ticker registration is a no-op.
_provider: MarketDataProvider | None = None


def create_provider(tickers: list[str] | None = None) -> MarketDataProvider:
    """Create the appropriate provider based on environment."""
    api_key = os.environ.get("MASSIVE_API_KEY", "").strip()

    from app.database import DEFAULT_TICKERS

    initial = list(tickers) if tickers else list(DEFAULT_TICKERS)

    if api_key:
        from app.market.massive import MassiveClient

        return MassiveClient(tickers=initial)

    from app.market.simulator import Simulator

    return Simulator(tickers=initial)


def set_provider(provider: MarketDataProvider | None) -> None:
    """Install (or clear) the process-wide provider."""
    global _provider
    _provider = provider


def get_provider() -> MarketDataProvider | None:
    """Return the running provider, if any."""
    return _provider


def register_ticker(ticker: str) -> None:
    """Ask the running provider to start pricing a ticker."""
    if _provider is not None:
        _provider.register_ticker(ticker)


def unregister_ticker(ticker: str) -> None:
    """Ask the running provider to stop pricing a ticker."""
    if _provider is not None:
        _provider.unregister_ticker(ticker)
