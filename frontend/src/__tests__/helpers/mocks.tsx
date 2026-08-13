import type { ReactNode } from "react";
import { vi } from "vitest";

/**
 * Shared stand-ins for the browser/chart libraries jsdom can't run.
 *
 * These live in one place on purpose: a mock factory that omits an export
 * throws only on the code path that happens to use it, so a partial mock can
 * sit green for a long time before it bites. Every symbol a component imports
 * must be listed here.
 */

/** Every recharts symbol imported by Sparkline.tsx and PnlChart.tsx. */
export function rechartsMock() {
  return {
    ResponsiveContainer: ({ children }: { children: ReactNode }) => children,
    LineChart: ({ children }: { children?: ReactNode }) => <svg>{children}</svg>,
    Line: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
  };
}

/** Every lightweight-charts symbol imported by MainChart.tsx. */
export function lightweightChartsMock() {
  const makeSeries = () => ({
    setData: vi.fn(),
    update: vi.fn(),
    applyOptions: vi.fn(),
  });

  return {
    createChart: vi.fn(() => ({
      // v5 API: addSeries(SeriesDefinition, options)
      addSeries: vi.fn(makeSeries),
      timeScale: vi.fn(() => ({ fitContent: vi.fn(), applyOptions: vi.fn() })),
      applyOptions: vi.fn(),
      resize: vi.fn(),
      remove: vi.fn(),
    })),
    LineSeries: { type: "Line" },
    ColorType: { Solid: "solid", VerticalGradient: "gradient" },
    LineType: { Simple: 0, WithSteps: 1, Curved: 2 },
  };
}

type Listener = (event: MessageEvent) => void;

/**
 * EventSource stub with enough of the real surface for useMarketData:
 * addEventListener/removeEventListener, close, readyState, and helpers for a
 * test to drive the stream (`open`, `emit`, `emitError`).
 */
export class MockEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  /** Every stub constructed since the last reset(), in creation order. */
  static instances: MockEventSource[] = [];

  static reset() {
    MockEventSource.instances = [];
  }

  /** The most recently constructed stub — the one the component is using. */
  static get last(): MockEventSource | null {
    return MockEventSource.instances[MockEventSource.instances.length - 1] ?? null;
  }

  readonly CONNECTING = MockEventSource.CONNECTING;
  readonly OPEN = MockEventSource.OPEN;
  readonly CLOSED = MockEventSource.CLOSED;

  readonly url: string;
  readonly withCredentials = false;
  readyState: number = MockEventSource.CONNECTING;

  onopen: ((event: Event) => void) | null = null;
  onmessage: Listener | null = null;
  onerror: ((event: Event) => void) | null = null;

  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly openTimer: ReturnType<typeof setTimeout>;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
    // Real EventSource opens asynchronously; mirror that so the component sees
    // the "disconnected" state first.
    this.openTimer = setTimeout(() => this.open(), 0);
  }

  addEventListener(type: string, listener: Listener) {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: MessageEvent | Event): boolean {
    if (this.readyState === MockEventSource.CLOSED) return false;

    if (event.type === "open") this.onopen?.(event);
    else if (event.type === "error") this.onerror?.(event);
    else if (event.type === "message") this.onmessage?.(event as MessageEvent);

    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(event as MessageEvent);
    }
    return true;
  }

  close() {
    clearTimeout(this.openTimer);
    this.readyState = MockEventSource.CLOSED;
  }

  /** Simulate the server accepting the stream. */
  open() {
    if (this.readyState === MockEventSource.CLOSED) return;
    this.readyState = MockEventSource.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  /** Simulate a named SSE event carrying a JSON payload. */
  emit(type: string, data: unknown) {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
  }

  /** Simulate a transport error, which drops the stream back to CONNECTING. */
  emitError() {
    if (this.readyState === MockEventSource.CLOSED) return;
    this.readyState = MockEventSource.CONNECTING;
    this.dispatchEvent(new Event("error"));
  }
}
