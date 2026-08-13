"""Keeps the running provider's ticker set in sync with what the user tracks.

SPEC sec.6: the provider prices the union of all watched tickers. "Watched"
here means the watchlist plus any ticker still held as a position — dropping a
held ticker from the watchlist must not stop pricing it, or portfolio
valuation would silently fall back to cost basis.
"""

from app.market import provider as provider_registry


async def tracked_tickers(db) -> list[str]:
    """Union of watchlist tickers and open-position tickers."""
    cursor = await db.execute(
        "SELECT ticker FROM watchlist WHERE user_id = 'default' ORDER BY added_at"
    )
    tickers = [row["ticker"] for row in await cursor.fetchall()]

    cursor = await db.execute(
        "SELECT ticker FROM positions WHERE user_id = 'default' AND quantity > 0"
    )
    for row in await cursor.fetchall():
        if row["ticker"] not in tickers:
            tickers.append(row["ticker"])

    return tickers


def register_watched_ticker(ticker: str) -> None:
    """Start pricing a newly watched ticker."""
    provider_registry.register_ticker(ticker)


async def unregister_watched_ticker(db, ticker: str) -> None:
    """Stop pricing an unwatched ticker unless it is still held as a position."""
    cursor = await db.execute(
        "SELECT 1 FROM positions WHERE user_id = 'default' AND ticker = ? AND quantity > 0",
        (ticker,),
    )
    if await cursor.fetchone():
        return
    provider_registry.unregister_ticker(ticker)
