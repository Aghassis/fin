const BASE = "/api";

/** Request failure that carries the HTTP status, so callers can branch on it. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, body: string) {
    super(`API ${status}: ${body}`);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    throw new ApiError(res.status, await res.text());
  }
  return res.json();
}

export const api = {
  getPortfolio: () => apiFetch<PortfolioResponse>("/portfolio"),
  trade: (body: TradeRequest) =>
    apiFetch<TradeResponse>("/portfolio/trade", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  getPortfolioHistory: () => apiFetch<SnapshotResponse[]>("/portfolio/history"),
  getWatchlist: () => apiFetch<WatchlistItem[]>("/watchlist"),
  addTicker: (ticker: string) =>
    apiFetch<WatchlistItem>("/watchlist", {
      method: "POST",
      body: JSON.stringify({ ticker }),
    }),
  removeTicker: (ticker: string) =>
    apiFetch<void>(`/watchlist/${ticker}`, { method: "DELETE" }),
  chat: (message: string) =>
    apiFetch<ChatResponse>("/chat", {
      method: "POST",
      body: JSON.stringify({ message }),
    }),
};

/* Types matching backend API responses */

export interface PortfolioResponse {
  cash_balance: number;
  total_value: number;
  positions: Position[];
}

export interface Position {
  ticker: string;
  quantity: number;
  avg_cost: number;
  current_price: number;
  unrealized_pnl: number;
  pnl_percent: number;
}

export interface TradeRequest {
  ticker: string;
  quantity: number;
  side: "buy" | "sell";
}

export interface TradeResponse {
  id: string;
  ticker: string;
  side: string;
  quantity: number;
  price: number;
  executed_at: string;
}

export interface WatchlistItem {
  ticker: string;
  price?: number;
  previous_price?: number;
  change_percent?: number;
}

export interface SnapshotResponse {
  total_value: number;
  recorded_at: string;
}

export interface ChatResponse {
  message: string;
  trades?: { ticker: string; side: string; quantity: number }[];
  watchlist_changes?: { ticker: string; action: string }[];
}
