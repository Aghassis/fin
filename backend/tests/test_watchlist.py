"""Tests for runtime watchlist changes reaching the market data provider."""

import json

import pytest
import pytest_asyncio

from app.database import get_db
from app.market import provider as provider_registry
from app.market.cache import price_cache
from app.market.provider import create_provider
from app.market.simulator import Simulator
from app.market.stream import _price_event_generator
from app.market.tracking import tracked_tickers

NEW_TICKER = "PYPL"  # not in DEFAULT_TICKERS


def _clear_cache():
    for update in price_cache.get_all():
        price_cache.remove(update.ticker)


async def _stream_tickers() -> list[str]:
    """Tickers emitted in one pass of the SSE price generator."""
    expected = len(price_cache.get_all())
    gen = _price_event_generator()
    tickers = []
    try:
        for _ in range(expected):
            event = await gen.__anext__()
            tickers.append(json.loads(event["data"])["ticker"])
    finally:
        await gen.aclose()
    return tickers


@pytest.fixture
def simulator():
    """Install a live simulator as the process-wide provider."""
    _clear_cache()
    sim = Simulator()
    provider_registry.set_provider(sim)
    yield sim
    provider_registry.set_provider(None)
    _clear_cache()


@pytest_asyncio.fixture
async def raw_db(db):
    """Direct DB handle alongside the API client."""
    conn = await get_db()
    yield conn
    await conn.close()


# ---------------------------------------------------------------------------
# Add
# ---------------------------------------------------------------------------


async def test_post_watchlist_returns_a_price_immediately(client, simulator):
    resp = await client.post("/api/watchlist", json={"ticker": NEW_TICKER})
    assert resp.status_code == 200
    body = resp.json()
    assert body["ticker"] == NEW_TICKER
    assert body["price"] is not None
    assert body["price"] > 0


async def test_added_ticker_is_registered_with_the_provider(client, simulator):
    await client.post("/api/watchlist", json={"ticker": NEW_TICKER})
    assert NEW_TICKER in simulator.tickers


async def test_added_ticker_appears_in_the_price_stream(client, simulator):
    await client.post("/api/watchlist", json={"ticker": NEW_TICKER})
    assert NEW_TICKER in await _stream_tickers()


async def test_added_ticker_keeps_ticking(client, simulator):
    await client.post("/api/watchlist", json={"ticker": NEW_TICKER})
    seed = simulator._prices[NEW_TICKER]
    for _ in range(5):
        simulator._step()
    assert simulator._prices[NEW_TICKER] != seed
    assert price_cache.get(NEW_TICKER) is not None


async def test_get_watchlist_shows_a_price_for_the_added_ticker(client, simulator):
    await client.post("/api/watchlist", json={"ticker": NEW_TICKER})
    resp = await client.get("/api/watchlist")
    row = next(r for r in resp.json() if r["ticker"] == NEW_TICKER)
    assert row["price"] is not None
    assert row["previous_price"] is not None


async def test_lowercase_ticker_is_normalized_before_registration(client, simulator):
    resp = await client.post("/api/watchlist", json={"ticker": "pypl"})
    assert resp.json()["price"] is not None
    assert simulator.tickers.count(NEW_TICKER) == 1


# ---------------------------------------------------------------------------
# Remove
# ---------------------------------------------------------------------------


async def test_removed_ticker_stops_streaming(client, simulator):
    await client.post("/api/watchlist", json={"ticker": NEW_TICKER})
    resp = await client.delete(f"/api/watchlist/{NEW_TICKER}")
    assert resp.status_code == 200

    assert NEW_TICKER not in simulator.tickers
    assert price_cache.get(NEW_TICKER) is None
    assert NEW_TICKER not in await _stream_tickers()

    simulator._step()
    assert price_cache.get(NEW_TICKER) is None


async def test_removed_ticker_still_held_keeps_its_price(client, simulator):
    """Dropping a held ticker from the watchlist must not break valuation."""
    await client.post("/api/watchlist", json={"ticker": NEW_TICKER})
    trade = await client.post(
        "/api/portfolio/trade",
        json={"ticker": NEW_TICKER, "quantity": 1, "side": "buy"},
    )
    assert trade.status_code == 200

    assert (await client.delete(f"/api/watchlist/{NEW_TICKER}")).status_code == 200

    # Still priced: the position is valued at the live price, not at cost
    assert NEW_TICKER in simulator.tickers
    assert price_cache.get(NEW_TICKER) is not None

    simulator._step()
    live_price = price_cache.get(NEW_TICKER).price

    portfolio = (await client.get("/api/portfolio")).json()
    position = next(p for p in portfolio["positions"] if p["ticker"] == NEW_TICKER)
    assert position["current_price"] == live_price
    assert portfolio["total_value"] == pytest.approx(
        portfolio["cash_balance"] + live_price * position["quantity"], abs=0.01
    )


async def test_removed_ticker_unregisters_once_the_position_is_sold(client, simulator):
    await client.post("/api/watchlist", json={"ticker": NEW_TICKER})
    await client.post(
        "/api/portfolio/trade",
        json={"ticker": NEW_TICKER, "quantity": 1, "side": "buy"},
    )
    await client.delete(f"/api/watchlist/{NEW_TICKER}")
    await client.post(
        "/api/portfolio/trade",
        json={"ticker": NEW_TICKER, "quantity": 1, "side": "sell"},
    )
    # Re-add then remove now that nothing is held
    await client.post("/api/watchlist", json={"ticker": NEW_TICKER})
    await client.delete(f"/api/watchlist/{NEW_TICKER}")

    assert NEW_TICKER not in simulator.tickers
    assert price_cache.get(NEW_TICKER) is None


# ---------------------------------------------------------------------------
# Chat-driven watchlist changes
# ---------------------------------------------------------------------------


async def test_chat_watchlist_add_registers_the_ticker(client, simulator, monkeypatch):
    monkeypatch.setenv("LLM_MOCK", "true")
    resp = await client.post("/api/chat", json={"message": "add PYPL to my watchlist"})
    assert resp.json()["watchlist_changes"] == [{"ticker": NEW_TICKER, "action": "add"}]

    assert NEW_TICKER in simulator.tickers
    assert price_cache.get(NEW_TICKER) is not None


async def test_chat_watchlist_remove_unregisters_the_ticker(client, simulator, monkeypatch):
    monkeypatch.setenv("LLM_MOCK", "true")
    simulator.register_ticker("NFLX")
    assert price_cache.get("NFLX") is not None

    resp = await client.post("/api/chat", json={"message": "remove NFLX please"})
    assert resp.json()["watchlist_changes"] == [{"ticker": "NFLX", "action": "remove"}]

    assert "NFLX" not in simulator.tickers
    assert price_cache.get("NFLX") is None


# ---------------------------------------------------------------------------
# Startup: the provider is built from what the user already tracks
# ---------------------------------------------------------------------------


async def test_tracked_tickers_unions_watchlist_and_positions(client, simulator, raw_db):
    await client.post("/api/watchlist", json={"ticker": NEW_TICKER})
    await client.post(
        "/api/portfolio/trade",
        json={"ticker": NEW_TICKER, "quantity": 1, "side": "buy"},
    )
    await client.delete(f"/api/watchlist/{NEW_TICKER}")

    tickers = await tracked_tickers(raw_db)
    assert NEW_TICKER in tickers, "held position must still be priced"
    assert "AAPL" in tickers
    assert len(tickers) == len(set(tickers))


async def test_provider_is_created_with_the_tracked_tickers(monkeypatch):
    monkeypatch.delenv("MASSIVE_API_KEY", raising=False)
    provider = create_provider(["AAPL", NEW_TICKER])
    assert provider.tickers == ["AAPL", NEW_TICKER]


async def test_provider_falls_back_to_defaults_when_nothing_is_tracked(monkeypatch):
    monkeypatch.delenv("MASSIVE_API_KEY", raising=False)
    from app.database import DEFAULT_TICKERS

    assert create_provider([]).tickers == list(DEFAULT_TICKERS)


def test_registration_without_a_running_provider_is_a_no_op():
    provider_registry.set_provider(None)
    provider_registry.register_ticker(NEW_TICKER)
    provider_registry.unregister_ticker(NEW_TICKER)
