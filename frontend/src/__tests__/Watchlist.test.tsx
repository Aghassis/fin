import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import Watchlist from "@/components/Watchlist";

// Mock recharts to avoid canvas rendering issues
vi.mock("recharts", async () => (await import("./helpers/mocks")).rechartsMock());

const basePrices = {
  AAPL: {
    ticker: "AAPL",
    price: 150.25,
    previous_price: 149.0,
    timestamp: "2026-01-01T00:00:00Z",
    direction: "up" as const,
  },
};

function renderWatchlist(overrides: Partial<React.ComponentProps<typeof Watchlist>> = {}) {
  const props = {
    tickers: [],
    prices: {},
    priceHistory: {},
    selectedTicker: null,
    onSelectTicker: vi.fn(),
    onAddTicker: vi.fn(),
    onRemoveTicker: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<Watchlist {...props} />) };
}

describe("Watchlist", () => {
  it("renders add ticker input", () => {
    renderWatchlist();
    expect(screen.getByPlaceholderText("Add ticker")).toBeInTheDocument();
  });

  it("renders the add button", () => {
    const { container } = renderWatchlist();
    const btn = within(container).getByRole("button", { name: "+" });
    expect(btn).toBeInTheDocument();
  });

  it("renders the tickers it is given", () => {
    renderWatchlist({ tickers: ["AAPL", "MSFT"], prices: basePrices });

    expect(screen.getByText("AAPL")).toBeInTheDocument();
    expect(screen.getByText("MSFT")).toBeInTheDocument();
  });

  it("renders price data when available", () => {
    renderWatchlist({ tickers: ["AAPL"], prices: basePrices });

    expect(screen.getByText("AAPL")).toBeInTheDocument();
    expect(screen.getByText("150.25")).toBeInTheDocument();
  });

  it("adds a ticker via input", async () => {
    const { container, props } = renderWatchlist();

    const input = screen.getByPlaceholderText("Add ticker");
    fireEvent.change(input, { target: { value: "tsla" } });
    // Wait for React to re-render with updated state before clicking
    await waitFor(() => expect(input).toHaveValue("tsla"));
    const addBtn = within(container).getByRole("button", { name: "+" });
    fireEvent.click(addBtn);

    expect(props.onAddTicker).toHaveBeenCalledWith("TSLA");
    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("ignores a ticker that is already on the list", async () => {
    const { container, props } = renderWatchlist({ tickers: ["AAPL"] });

    const input = screen.getByPlaceholderText("Add ticker");
    fireEvent.change(input, { target: { value: "aapl" } });
    await waitFor(() => expect(input).toHaveValue("aapl"));
    fireEvent.click(within(container).getByRole("button", { name: "+" }));

    expect(props.onAddTicker).not.toHaveBeenCalled();
  });

  it("removes a ticker via the row button", () => {
    const { props } = renderWatchlist({ tickers: ["AAPL"], prices: basePrices });

    fireEvent.click(screen.getByTitle("Remove"));

    expect(props.onRemoveTicker).toHaveBeenCalledWith("AAPL");
  });

  it("calls onSelectTicker when clicking a row", () => {
    const { props } = renderWatchlist({ tickers: ["AAPL"], prices: basePrices });

    fireEvent.click(screen.getByText("AAPL"));
    expect(props.onSelectTicker).toHaveBeenCalledWith("AAPL");
  });

  it("renders a sparkline once a ticker has price history", () => {
    const { container } = renderWatchlist({
      tickers: ["AAPL"],
      prices: basePrices,
      priceHistory: { AAPL: [{ price: 149.0 }, { price: 150.25 }] },
    });

    expect(screen.getByText("AAPL")).toBeInTheDocument();
    // Sparkline renders only with >= 2 points; it pulls in YAxis from recharts
    expect(container.querySelector("tbody svg")).toBeInTheDocument();
  });

  it("renders table column headers", () => {
    const { container } = renderWatchlist();
    const thead = container.querySelector("thead")!;
    expect(within(thead).getByText("Ticker")).toBeInTheDocument();
    expect(within(thead).getByText("Price")).toBeInTheDocument();
    expect(within(thead).getByText("Chg%")).toBeInTheDocument();
  });
});
