import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MockEventSource } from "./helpers/mocks";

vi.mock("recharts", async () => (await import("./helpers/mocks")).rechartsMock());

vi.mock("lightweight-charts", async () =>
  (await import("./helpers/mocks")).lightweightChartsMock()
);

// Mock EventSource for useMarketData
vi.stubGlobal("EventSource", MockEventSource);

// Mock api module
vi.mock("@/lib/api", () => ({
  api: {
    getPortfolio: vi.fn(),
    trade: vi.fn(),
    getPortfolioHistory: vi.fn(),
    getWatchlist: vi.fn(),
    addTicker: vi.fn(),
    removeTicker: vi.fn(),
    chat: vi.fn(),
  },
  apiFetch: vi.fn(),
}));

import { api } from "@/lib/api";
import Home from "@/app/page";

describe("Portfolio Page Integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockEventSource.reset();
    vi.mocked(api.getWatchlist).mockResolvedValue([]);
    vi.mocked(api.getPortfolioHistory).mockResolvedValue([]);
  });

  it("fetches portfolio data and renders in header", async () => {
    vi.mocked(api.getPortfolio).mockResolvedValue({
      cash_balance: 7500.0,
      total_value: 12500.0,
      positions: [],
    });

    render(<Home />);

    await waitFor(() => {
      expect(api.getPortfolio).toHaveBeenCalled();
    });

    // Portfolio and Cash display different values
    expect(await screen.findByText("$12,500.00")).toBeInTheDocument();
    expect(await screen.findByText("$7,500.00")).toBeInTheDocument();
  });

  it("shows portfolio value with positions", async () => {
    vi.mocked(api.getPortfolio).mockResolvedValue({
      cash_balance: 8165.4,
      total_value: 10000.0,
      positions: [
        {
          ticker: "AAPL",
          quantity: 10,
          avg_cost: 183.46,
          current_price: 183.46,
          unrealized_pnl: 0,
          pnl_percent: 0,
        },
      ],
    });

    render(<Home />);

    expect(await screen.findByText("$8,165.40")).toBeInTheDocument();
    expect(await screen.findByText("$10,000.00")).toBeInTheDocument();
    // AAPL appears in both heatmap and positions table
    const tickers = await screen.findAllByText("AAPL");
    expect(tickers.length).toBeGreaterThanOrEqual(1);
  });

  it("refreshes portfolio after trade execution", async () => {
    vi.mocked(api.getPortfolio)
      .mockResolvedValueOnce({
        cash_balance: 10000.0,
        total_value: 10000.0,
        positions: [],
      })
      .mockResolvedValueOnce({
        cash_balance: 8165.4,
        total_value: 10000.0,
        positions: [
          {
            ticker: "AAPL",
            quantity: 10,
            avg_cost: 183.46,
            current_price: 183.46,
            unrealized_pnl: 0,
            pnl_percent: 0,
          },
        ],
      });

    vi.mocked(api.trade).mockResolvedValue({
      id: "test-id",
      ticker: "AAPL",
      side: "buy",
      quantity: 10,
      price: 183.46,
      executed_at: "2026-01-01T00:00:00Z",
    });

    render(<Home />);

    await waitFor(() => {
      expect(api.getPortfolio).toHaveBeenCalledTimes(1);
    });

    // Execute a trade
    const tickerInput = screen.getByPlaceholderText("Ticker");
    const qtyInput = screen.getByPlaceholderText("Qty");
    fireEvent.change(tickerInput, { target: { value: "AAPL" } });
    fireEvent.change(qtyInput, { target: { value: "10" } });
    fireEvent.click(screen.getByText("BUY"));

    await waitFor(() => {
      expect(api.trade).toHaveBeenCalledWith({
        ticker: "AAPL",
        quantity: 10,
        side: "buy",
      });
    });

    // Portfolio should refresh after trade
    await waitFor(() => {
      expect(api.getPortfolio).toHaveBeenCalledTimes(2);
    });
  });

  it("applies streamed price updates to open positions", async () => {
    vi.mocked(api.getPortfolio).mockResolvedValue({
      cash_balance: 8165.4,
      total_value: 10000.0,
      positions: [
        {
          ticker: "AAPL",
          quantity: 10,
          avg_cost: 183.46,
          current_price: 183.46,
          unrealized_pnl: 0,
          pnl_percent: 0,
        },
      ],
    });

    render(<Home />);

    // Stream opens -> header reports the live connection
    expect(await screen.findByText("connected")).toBeInTheDocument();
    // Avg cost and current price both start at the REST snapshot value
    expect(await screen.findAllByText("$183.46")).toHaveLength(2);

    const stream = MockEventSource.last!;
    expect(stream.url).toBe("/api/stream/prices");
    expect(stream.readyState).toBe(MockEventSource.OPEN);

    act(() => {
      stream.emit("price", {
        ticker: "AAPL",
        price: 200.0,
        previous_price: 183.46,
        timestamp: "2026-01-01T00:00:05Z",
        direction: "up",
      });
    });

    // Positions table re-prices off the streamed quote, not the REST snapshot
    expect(await screen.findByText("$200.00")).toBeInTheDocument();
    expect(screen.getByText("+$165.40")).toBeInTheDocument();
  });

  it("reports a dropped stream as reconnecting", async () => {
    vi.mocked(api.getPortfolio).mockResolvedValue({
      cash_balance: 10000.0,
      total_value: 10000.0,
      positions: [],
    });

    render(<Home />);

    expect(await screen.findByText("connected")).toBeInTheDocument();

    act(() => {
      MockEventSource.last!.emitError();
    });

    expect(await screen.findByText("reconnecting")).toBeInTheDocument();
  });

  it("handles API failure gracefully", async () => {
    vi.mocked(api.getPortfolio).mockRejectedValue(new Error("Network error"));

    render(<Home />);

    await waitFor(() => {
      expect(api.getPortfolio).toHaveBeenCalled();
    });

    // Should show $0.00 (initial state) without crashing
    const zeros = screen.getAllByText("$0.00");
    expect(zeros.length).toBe(2); // Portfolio and Cash both show $0.00
  });
});
