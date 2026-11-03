/**
 * Thin REST helpers for Binance Spot public market-data endpoints. No API
 * key is required for any of these. `fetch` is injectable so the hub (and
 * tests, if any land later) can swap in a fake without touching global
 * state - defaults to the real global `fetch`, which is available both on
 * the main thread and inside a SharedWorker.
 */
import type { Candle, DepthSnapshot, KlineInterval } from '../types';

export type FetchFn = typeof fetch;

export interface BinanceRestOptions {
  fetchFn?: FetchFn;
}

/** Raw shape of one row returned by `GET /api/v3/klines`. */
type RawKline = [
  number, // open time
  string, // open
  string, // high
  string, // low
  string, // close
  string, // volume
  number, // close time
  string, // quote asset volume
  number, // number of trades
  string, // taker buy base asset volume
  string, // taker buy quote asset volume
  string, // unused
];

async function getJson<T>(fetchFn: FetchFn, url: string): Promise<T> {
  const res = await fetchFn(url);
  if (!res.ok) {
    throw new Error(`Binance REST request failed: ${res.status} ${res.statusText} (${url})`);
  }
  return (await res.json()) as T;
}

/** `GET /api/v3/depth?symbol=<SYM>&limit=1000` - order book snapshot used to (re)sync a local OrderBookManager. */
export async function fetchDepthSnapshot(
  restBaseUrl: string,
  symbol: string,
  opts: BinanceRestOptions = {},
): Promise<DepthSnapshot> {
  const fetchFn = opts.fetchFn ?? fetch;
  const url = `${restBaseUrl}/api/v3/depth?symbol=${encodeURIComponent(symbol.toUpperCase())}&limit=1000`;
  const raw = await getJson<{ lastUpdateId: number; bids: [string, string][]; asks: [string, string][] }>(
    fetchFn,
    url,
  );
  return {
    lastUpdateId: raw.lastUpdateId,
    bids: raw.bids,
    asks: raw.asks,
  };
}

/**
 * `GET /api/v3/klines?symbol=<SYM>&interval=<I>&limit=500` - recent candle
 * history used to seed a chart panel before the live `kline` stream takes
 * over. Binance's raw kline REST row shape differs from the websocket
 * kline event shape (a flat array, not `{ k: {...} }`), so we map it
 * explicitly here.
 */
export async function fetchKlines(
  restBaseUrl: string,
  symbol: string,
  interval: KlineInterval,
  opts: BinanceRestOptions = {},
): Promise<Candle[]> {
  const fetchFn = opts.fetchFn ?? fetch;
  const url = `${restBaseUrl}/api/v3/klines?symbol=${encodeURIComponent(
    symbol.toUpperCase(),
  )}&interval=${interval}&limit=500`;
  const raw = await getJson<RawKline[]>(fetchFn, url);
  const now = Date.now();
  return raw.map((row) => {
    const [openTime, open, high, low, close, volume, closeTime] = row;
    return {
      openTime,
      closeTime,
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume),
      // The most recent row from a REST kline query may be the
      // still-forming current candle; only rows whose closeTime has
      // already elapsed are guaranteed closed.
      closed: closeTime < now,
    };
  });
}
