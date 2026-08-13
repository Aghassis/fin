"""Tests for runtime ticker registration on the Massive (Polygon.io) client."""

import pytest

from app.market.cache import price_cache


class _FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self._payload


class _FakeHTTPClient:
    """Stands in for httpx.AsyncClient, echoing a price for every ticker asked for."""

    def __init__(self, price=100.0):
        self.price = price
        self.requested: list[list[str]] = []

    async def get(self, url, params):
        tickers = params["tickers"].split(",")
        self.requested.append(tickers)
        return _FakeResponse(
            {"tickers": [{"ticker": t, "lastTrade": {"p": self.price}} for t in tickers]}
        )


@pytest.fixture
def massive(monkeypatch):
    monkeypatch.setenv("MASSIVE_API_KEY", "test-key")
    from app.market.massive import MassiveClient

    for update in price_cache.get_all():
        price_cache.remove(update.ticker)

    client = MassiveClient(tickers=["AAPL", "MSFT"])
    client._client = _FakeHTTPClient()
    yield client
    for update in price_cache.get_all():
        price_cache.remove(update.ticker)


async def test_next_poll_includes_a_registered_ticker(massive):
    massive.register_ticker("PYPL")
    await massive._poll()

    assert "PYPL" in massive._client.requested[-1]
    assert price_cache.get("PYPL") is not None


async def test_register_normalizes_and_is_idempotent(massive):
    massive.register_ticker(" pypl ")
    massive.register_ticker("PYPL")
    assert massive.tickers.count("PYPL") == 1


async def test_unregistered_ticker_stops_streaming(massive):
    massive.register_ticker("PYPL")
    await massive._poll()

    massive.unregister_ticker("PYPL")
    assert price_cache.get("PYPL") is None

    await massive._poll()
    assert "PYPL" not in massive._client.requested[-1]
    assert price_cache.get("PYPL") is None


async def test_unregister_unknown_ticker_is_a_no_op(massive):
    massive.unregister_ticker("ZZZZ")
    assert massive.tickers == ["AAPL", "MSFT"]


async def test_poll_skips_the_api_when_no_tickers_are_tracked(massive):
    for ticker in massive.tickers:
        massive.unregister_ticker(ticker)
    await massive._poll()
    assert massive._client.requested == []


def test_create_provider_returns_massive_client_with_tracked_tickers(monkeypatch):
    monkeypatch.setenv("MASSIVE_API_KEY", "test-key")
    from app.market.massive import MassiveClient
    from app.market.provider import create_provider

    provider = create_provider(["AAPL", "PYPL"])
    assert isinstance(provider, MassiveClient)
    assert provider.tickers == ["AAPL", "PYPL"]
