import http from "node:http";
import type { AddressInfo, Socket } from "node:net";

import { test, expect, type Locator, type Page } from "@playwright/test";

/**
 * End-to-end coverage for the seven scenarios in planning/PLAN.md sec.12.
 *
 * The suite runs against a single app container with one shared database, so
 * `workers: 1` (see playwright.config.ts) keeps the tests serialised. Apart
 * from "Fresh start" — which by definition needs an untouched database and is
 * therefore declared first — every test sets up the positions it needs, so a
 * retry re-establishes its own preconditions.
 */

const DEFAULT_TICKERS = [
  "AAPL",
  "GOOGL",
  "MSFT",
  "AMZN",
  "TSLA",
  "NVDA",
  "META",
  "JPM",
  "V",
  "NFLX",
];

const PRICE = /^\d+\.\d{2}$/;

function money(text: string): number {
  return Number(text.replace(/[$,\s]/g, ""));
}

function status(page: Page): Locator {
  return page.getByTestId("connection-status");
}

async function cash(page: Page): Promise<number> {
  return money(await page.getByTestId("cash-balance").innerText());
}

async function portfolioValue(page: Page): Promise<number> {
  return money(await page.getByTestId("portfolio-value").innerText());
}

function formatMoney(value: number): string {
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Load the app and wait until it is fully live: prices streaming *and* the
 * portfolio fetched. The header renders zeroes until that first fetch resolves,
 * so reading balances any earlier yields $0.00.
 */
async function openApp(page: Page): Promise<void> {
  const portfolioLoaded = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/portfolio" &&
      r.request().method() === "GET"
  );
  await page.goto("/");
  const portfolio = await (await portfolioLoaded).json();
  await expect(page.getByTestId("cash-balance")).toHaveText(
    formatMoney(portfolio.cash_balance)
  );
  await expect(status(page)).toHaveText("connected", { timeout: 20_000 });
}

function watchlistRow(page: Page, ticker: string): Locator {
  return page
    .getByTestId("panel-watchlist")
    .locator("tr")
    .filter({ has: page.getByRole("cell", { name: ticker, exact: true }) });
}

function positionRow(page: Page, ticker: string): Locator {
  return page
    .getByTestId("panel-positions")
    .locator("tr")
    .filter({ has: page.getByRole("cell", { name: ticker, exact: true }) });
}

/** Current holding, or zeroes when the ticker is not held. */
async function position(
  page: Page,
  ticker: string
): Promise<{ quantity: number; avgCost: number }> {
  const row = positionRow(page, ticker);
  if ((await row.count()) === 0) return { quantity: 0, avgCost: 0 };
  return {
    quantity: Number(await row.locator("td").nth(1).innerText()),
    avgCost: money(await row.locator("td").nth(2).innerText()),
  };
}

async function expectQuantity(
  page: Page,
  ticker: string,
  quantity: number
): Promise<void> {
  await expect(positionRow(page, ticker).locator("td").nth(1)).toHaveText(
    String(quantity),
    { timeout: 20_000 }
  );
}

/**
 * Execute a trade through the trade bar and return the fill price reported by
 * the API, so callers can assert on exact cash movements.
 */
async function trade(
  page: Page,
  ticker: string,
  quantity: number,
  side: "buy" | "sell"
): Promise<number> {
  const bar = page.getByTestId("panel-trade");
  await bar.getByPlaceholder("Ticker").fill(ticker);
  await bar.getByPlaceholder("Qty").fill(String(quantity));

  const response = page.waitForResponse(
    (r) =>
      r.url().includes("/api/portfolio/trade") &&
      r.request().method() === "POST"
  );
  await bar.getByRole("button", { name: side.toUpperCase(), exact: true }).click();

  const body = await (await response).json();
  expect(body).toMatchObject({ ticker, side, quantity });
  expect(body.price).toBeGreaterThan(0);

  // The bar echoes the fill back to the user (the message clears after 3s).
  await expect(
    bar.getByText(
      `${side.toUpperCase()} ${quantity} ${ticker} @ $${body.price.toFixed(2)}`
    )
  ).toBeVisible();

  return body.price as number;
}

test.describe("Fresh start", () => {
  test("default watchlist, $10,000 balance and streaming prices", async ({
    page,
  }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "FinAlly"
    );
    await expect(page.getByTestId("cash-balance")).toHaveText("$10,000.00");
    await expect(page.getByTestId("portfolio-value")).toHaveText("$10,000.00");

    // All ten seeded tickers are listed.
    for (const ticker of DEFAULT_TICKERS) {
      await expect(watchlistRow(page, ticker)).toBeVisible();
    }

    await expect(status(page)).toHaveText("connected", { timeout: 20_000 });

    // Every row is priced from the stream...
    for (const ticker of DEFAULT_TICKERS) {
      await expect(
        watchlistRow(page, ticker).locator("td.tabular-nums").first()
      ).toHaveText(PRICE, { timeout: 20_000 });
    }

    // ...and the prices actually move, which is what "streaming" means.
    const aaplPrice = watchlistRow(page, "AAPL")
      .locator("td.tabular-nums")
      .first();
    const initial = await aaplPrice.innerText();
    await expect
      .poll(() => aaplPrice.innerText(), {
        timeout: 20_000,
        intervals: [250],
      })
      .not.toBe(initial);
  });
});

test.describe("Watchlist CRUD", () => {
  test("add and remove a ticker", async ({ page }) => {
    await openApp(page);
    const input = page.getByTestId("panel-watchlist").getByPlaceholder("Add ticker");

    // Lowercase input is normalised to a ticker symbol.
    await input.fill("snap");
    await input.press("Enter");
    await expect(watchlistRow(page, "SNAP")).toBeVisible({ timeout: 10_000 });

    // A ticker added at runtime is priced too (fin-hrl).
    await expect(
      watchlistRow(page, "SNAP").locator("td.tabular-nums").first()
    ).toHaveText(PRICE, { timeout: 20_000 });

    // The addition was persisted server-side, not just held in React state.
    await page.reload();
    await expect(watchlistRow(page, "SNAP")).toBeVisible({ timeout: 20_000 });

    await watchlistRow(page, "SNAP").getByTitle("Remove").click();
    await expect(watchlistRow(page, "SNAP")).toHaveCount(0);

    await page.reload();
    await expect(watchlistRow(page, "AAPL")).toBeVisible({ timeout: 20_000 });
    await expect(watchlistRow(page, "SNAP")).toHaveCount(0);
  });
});

test.describe("Trading", () => {
  test("buy shares: cash decreases, position appears, portfolio updates", async ({
    page,
  }) => {
    await openApp(page);

    const before = await position(page, "AMZN");
    const cashBefore = await cash(page);
    const positionsValueBefore = (await portfolioValue(page)) - cashBefore;
    const price = await trade(page, "AMZN", 3, "buy");
    const cost = 3 * price;

    await expect
      .poll(() => cash(page), { timeout: 20_000 })
      .toBeCloseTo(cashBefore - cost, 1);

    const row = positionRow(page, "AMZN");
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expectQuantity(page, "AMZN", before.quantity + 3);

    // Average cost is the weighted average of what was held and what was paid.
    const expectedAvg =
      (before.quantity * before.avgCost + cost) / (before.quantity + 3);
    await expect(row.locator("td").nth(2)).toHaveText(
      `$${expectedAvg.toFixed(2)}`
    );

    // Cash became stock: the value held in positions grew by the trade cost.
    const positionsValue = (await portfolioValue(page)) - (await cash(page));
    expect(positionsValue - positionsValueBefore).toBeGreaterThan(cost * 0.9);
    expect(positionsValue - positionsValueBefore).toBeLessThan(cost * 1.1);

    // Buying more of the same ticker adds to the position.
    await trade(page, "AMZN", 2, "buy");
    await expectQuantity(page, "AMZN", before.quantity + 5);
  });

  test("sell shares: cash increases, position updates then disappears", async ({
    page,
  }) => {
    await openApp(page);

    // Establish the position this test sells, whatever was held before.
    const startQuantity = (await position(page, "TSLA")).quantity;
    await trade(page, "TSLA", 4, "buy");
    const held = startQuantity + 4;
    await expectQuantity(page, "TSLA", held);

    // Partial sale: cash up, quantity down.
    const beforePartial = await cash(page);
    const partialPrice = await trade(page, "TSLA", 3, "sell");
    await expect
      .poll(() => cash(page), { timeout: 20_000 })
      .toBeCloseTo(beforePartial + 3 * partialPrice, 1);
    await expectQuantity(page, "TSLA", held - 3);

    // Selling the remainder removes the position entirely.
    const remaining = held - 3;
    const beforeFinal = await cash(page);
    const finalPrice = await trade(page, "TSLA", remaining, "sell");
    await expect
      .poll(() => cash(page), { timeout: 20_000 })
      .toBeCloseTo(beforeFinal + remaining * finalPrice, 1);
    await expect(positionRow(page, "TSLA")).toHaveCount(0, { timeout: 20_000 });
  });
});

test.describe("Portfolio visualization", () => {
  test("heatmap tiles are coloured by P&L and the P&L chart has data", async ({
    page,
  }) => {
    await openApp(page);

    // Two trades guarantee a position to draw and at least two snapshots.
    await trade(page, "GOOGL", 2, "buy");
    await trade(page, "META", 1, "buy");

    const heatmap = page.getByTestId("panel-portfolio-heatmap");
    for (const ticker of ["GOOGL", "META"]) {
      const tile = heatmap.getByText(ticker, { exact: true }).locator("xpath=..");
      await expect(tile).toBeVisible({ timeout: 20_000 });

      // Gain tiles are green, loss tiles red — both with a P&L percentage.
      const background = await tile.evaluate(
        (el) => getComputedStyle(el).backgroundColor
      );
      expect(background).toMatch(/rgba?\((?:63, 185, 80|248, 81, 73)[,)]/);
      await expect(tile.locator("span").nth(1)).toHaveText(/^[+-]\d+\.\d%$/);
    }

    // The P&L chart plots the snapshots recorded by those trades.
    const pnl = page.getByTestId("panel-p-l");
    await page.reload();
    await expect(pnl.getByText("Waiting for data...")).toHaveCount(0, {
      timeout: 20_000,
    });
    const curve = pnl.locator("path.recharts-line-curve");
    await expect(curve).toBeVisible({ timeout: 20_000 });
    const d = (await curve.getAttribute("d")) ?? "";
    const points = d.match(/-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?/g) ?? [];
    expect(points.length).toBeGreaterThanOrEqual(2);
  });
});

test.describe("AI Chat", () => {
  test("send a message, get a response and see the trade inline", async ({
    page,
  }) => {
    await openApp(page);

    await expect(page.getByText("AI Chat")).toBeVisible();
    await expect(
      page.getByText("Ask about stocks, trade, or manage your watchlist.")
    ).toBeVisible();

    const heldBefore = (await position(page, "JPM")).quantity;
    const chatInput = page.getByPlaceholder("Message...");
    await chatInput.fill("Buy JPM now");
    await page.getByRole("button", { name: "Send" }).click();

    // User message, then the mocked assistant reply.
    await expect(page.getByText("Buy JPM now")).toBeVisible();
    await expect(
      page.getByText("Buying 10 shares of JPM for you.")
    ).toBeVisible({ timeout: 20_000 });

    // The auto-executed trade is reported inline as an action badge...
    await expect(page.getByText("Bought 10 JPM")).toBeVisible();

    // ...and it really moved the portfolio.
    await expect(positionRow(page, "JPM")).toBeVisible({ timeout: 20_000 });
    await expectQuantity(page, "JPM", heldBefore + 10);

    // The empty-state prompt is gone once a conversation exists.
    await expect(
      page.getByText("Ask about stocks, trade, or manage your watchlist.")
    ).toHaveCount(0);
  });

  test("chat panel collapses and expands", async ({ page }) => {
    await page.goto("/");

    await page.getByLabel("Collapse chat").click();
    await expect(page.getByText("AI Chat")).toHaveCount(0);

    await page.getByLabel("Expand chat").click();
    await expect(page.getByText("AI Chat")).toBeVisible();
  });
});

/**
 * A pass-through HTTP proxy in front of the app, listening on loopback inside
 * the same container as the browser.
 *
 * `cut()` destroys every open socket, which is a real transport-level failure:
 * the in-flight SSE response dies mid-stream exactly as it would if the server
 * went away. Browser-level offline emulation is not enough — it only fails new
 * requests and leaves an established stream running.
 */
async function startProxy(): Promise<{
  url: string;
  cut: () => void;
  restore: () => void;
  close: () => Promise<void>;
}> {
  const upstream = new URL(process.env.BASE_URL || "http://localhost:8000");
  const sockets = new Set<Socket>();
  let cutOff = false;

  const server = http.createServer((req, res) => {
    const proxied = http.request(
      {
        host: upstream.hostname,
        port: upstream.port || 80,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: upstream.host },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      }
    );
    proxied.on("error", () => res.destroy());
    req.pipe(proxied);
  });

  server.on("connection", (socket) => {
    if (cutOff) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    cut: () => {
      cutOff = true;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
    restore: () => {
      cutOff = false;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

test.describe("SSE resilience", () => {
  test("drops the stream and reconnects", async ({ page }) => {
    const proxy = await startProxy();
    let streamRequests = 0;
    page.on("request", (req) => {
      if (req.url().includes("/api/stream/prices")) streamRequests += 1;
    });

    try {
      await page.goto(proxy.url);
      await expect(status(page)).toHaveText("connected", { timeout: 20_000 });
      const requestsWhenConnected = streamRequests;

      const price = watchlistRow(page, "AAPL")
        .locator("td.tabular-nums")
        .first();
      await expect(price).toHaveText(PRICE, { timeout: 20_000 });

      // Kill the stream mid-flight.
      proxy.cut();
      await expect(status(page)).toHaveText("reconnecting", { timeout: 30_000 });

      // Prices are frozen while the stream is down.
      const frozen = await price.innerText();
      await page.waitForTimeout(2_000);
      expect(await price.innerText()).toBe(frozen);

      // Let connections through again: EventSource retries and the app recovers.
      proxy.restore();
      await expect(status(page)).toHaveText("connected", { timeout: 60_000 });

      // The recovery is a genuinely new stream that is genuinely flowing.
      expect(streamRequests).toBeGreaterThan(requestsWhenConnected);
      await expect
        .poll(() => price.innerText(), { timeout: 30_000, intervals: [250] })
        .not.toBe(frozen);
    } finally {
      await proxy.close();
    }
  });
});
