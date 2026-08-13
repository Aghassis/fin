import { act, render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import Watchlist from "@/components/Watchlist";

// Mock recharts to avoid canvas rendering issues
vi.mock("recharts", async () => (await import("./helpers/mocks")).rechartsMock());

// Mock api
vi.mock("@/lib/api", () => ({
  api: {
    getWatchlist: vi.fn().mockResolvedValue([]),
    addTicker: vi.fn().mockResolvedValue({ ticker: "TEST" }),
    removeTicker: vi.fn().mockResolvedValue(undefined),
  },
  apiFetch: vi.fn(),
}));

import { api } from "@/lib/api";

const basePrices = {
  AAPL: {
    ticker: "AAPL",
    price: 150.25,
    previous_price: 149.0,
    timestamp: "2026-01-01T00:00:00Z",
    direction: "up" as const,
  },
};

describe("Watchlist", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getWatchlist).mockResolvedValue([]);
  });

  it("renders add ticker input", () => {
    render(
      <Watchlist
        prices={{}}
        priceHistory={{}}
        selectedTicker={null}
        onSelectTicker={vi.fn()}
      />
    );
    expect(screen.getByPlaceholderText("Add ticker")).toBeInTheDocument();
  });

  it("renders the add button", () => {
    const { container } = render(
      <Watchlist
        prices={{}}
        priceHistory={{}}
        selectedTicker={null}
        onSelectTicker={vi.fn()}
      />
    );
    const btn = within(container).getByRole("button", { name: "+" });
    expect(btn).toBeInTheDocument();
  });

  it("renders price data when available", async () => {
    vi.mocked(api.getWatchlist).mockResolvedValue([{ ticker: "AAPL" }]);

    render(
      <Watchlist
        prices={basePrices}
        priceHistory={{}}
        selectedTicker={null}
        onSelectTicker={vi.fn()}
      />
    );

    expect(await screen.findByText("AAPL")).toBeInTheDocument();
    expect(screen.getByText("150.25")).toBeInTheDocument();
  });

  it("adds a ticker via input", async () => {
    const { container } = render(
      <Watchlist
        prices={{}}
        priceHistory={{}}
        selectedTicker={null}
        onSelectTicker={vi.fn()}
      />
    );

    const input = screen.getByPlaceholderText("Add ticker");
    fireEvent.change(input, { target: { value: "tsla" } });
    // Wait for React to re-render with updated state before clicking
    await waitFor(() => expect(input).toHaveValue("tsla"));
    const addBtn = within(container).getByRole("button", { name: "+" });
    fireEvent.click(addBtn);

    expect(await screen.findByText("TSLA")).toBeInTheDocument();
    expect(api.addTicker).toHaveBeenCalledWith("TSLA");
  });

  it("keeps a ticker added while the initial load is still in flight", async () => {
    // The GET was issued before the POST, so its response cannot contain the
    // new ticker. Resolving it must not wipe out the optimistic row (fin-8hh).
    let resolveLoad: (items: { ticker: string }[]) => void = () => {};
    vi.mocked(api.getWatchlist).mockReturnValue(
      new Promise((resolve) => {
        resolveLoad = resolve;
      })
    );

    const { container } = render(
      <Watchlist
        prices={{}}
        priceHistory={{}}
        selectedTicker={null}
        onSelectTicker={vi.fn()}
      />
    );

    const input = screen.getByPlaceholderText("Add ticker");
    fireEvent.change(input, { target: { value: "snap" } });
    await waitFor(() => expect(input).toHaveValue("snap"));
    fireEvent.click(within(container).getByRole("button", { name: "+" }));

    expect(await screen.findByText("SNAP")).toBeInTheDocument();

    resolveLoad([{ ticker: "AAPL" }, { ticker: "GOOGL" }]);

    expect(await screen.findByText("AAPL")).toBeInTheDocument();
    expect(screen.getByText("GOOGL")).toBeInTheDocument();
    expect(screen.getByText("SNAP")).toBeInTheDocument();
  });

  it("does not duplicate a ticker the initial load also returns", async () => {
    let resolveLoad: (items: { ticker: string }[]) => void = () => {};
    vi.mocked(api.getWatchlist).mockReturnValue(
      new Promise((resolve) => {
        resolveLoad = resolve;
      })
    );

    const { container } = render(
      <Watchlist
        prices={{}}
        priceHistory={{}}
        selectedTicker={null}
        onSelectTicker={vi.fn()}
      />
    );

    const input = screen.getByPlaceholderText("Add ticker");
    fireEvent.change(input, { target: { value: "aapl" } });
    await waitFor(() => expect(input).toHaveValue("aapl"));
    fireEvent.click(within(container).getByRole("button", { name: "+" }));

    // Flush the load inside act() so the merge has definitely applied — a bare
    // waitFor would pass on the pre-merge render even if the merge duplicated.
    await act(async () => {
      resolveLoad([{ ticker: "AAPL" }]);
    });

    expect(screen.getAllByText("AAPL")).toHaveLength(1);
  });

  it("calls onSelectTicker when clicking a row", async () => {
    vi.mocked(api.getWatchlist).mockResolvedValue([{ ticker: "AAPL" }]);
    const onSelect = vi.fn();

    render(
      <Watchlist
        prices={basePrices}
        priceHistory={{}}
        selectedTicker={null}
        onSelectTicker={onSelect}
      />
    );

    const row = await screen.findByText("AAPL");
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith("AAPL");
  });

  it("renders a sparkline once a ticker has price history", async () => {
    vi.mocked(api.getWatchlist).mockResolvedValue([{ ticker: "AAPL" }]);

    const { container } = render(
      <Watchlist
        prices={basePrices}
        priceHistory={{
          AAPL: [{ price: 149.0 }, { price: 150.25 }],
        }}
        selectedTicker={null}
        onSelectTicker={vi.fn()}
      />
    );

    expect(await screen.findByText("AAPL")).toBeInTheDocument();
    // Sparkline renders only with >= 2 points; it pulls in YAxis from recharts
    expect(container.querySelector("tbody svg")).toBeInTheDocument();
  });

  it("renders table column headers", () => {
    const { container } = render(
      <Watchlist
        prices={{}}
        priceHistory={{}}
        selectedTicker={null}
        onSelectTicker={vi.fn()}
      />
    );
    const thead = container.querySelector("thead")!;
    expect(within(thead).getByText("Ticker")).toBeInTheDocument();
    expect(within(thead).getByText("Price")).toBeInTheDocument();
    expect(within(thead).getByText("Chg%")).toBeInTheDocument();
  });
});
