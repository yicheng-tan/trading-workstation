/**
 * Shared domain types for the trading workstation.
 * These types are the contract between the data hub (SharedWorker), the
 * panels (React/canvas), the workspace/layout system, and tests.
 */

export type Symbol = string; // e.g. "BTCUSDT" (upper-case, Binance format)

// ---------------------------------------------------------------------------
// Order book
// ---------------------------------------------------------------------------

/** [price, quantity] as strings, matching Binance's wire format (avoids float rounding on parse). */
export type RawLevel = [string, string];

export interface PriceLevel {
  price: number;
  qty: number;
}

/** Raw partial-book diff event, shape matches Binance's `<symbol>@depth` stream payload. */
export interface DepthDiffEvent {
  e: 'depthUpdate';
  E: number; // event time (ms)
  s: string; // symbol
  U: number; // first update ID in event
  u: number; // final update ID in event
  b: RawLevel[]; // bids to update
  a: RawLevel[]; // asks to update
}

/** REST `/api/v3/depth` snapshot shape. */
export interface DepthSnapshot {
  lastUpdateId: number;
  bids: RawLevel[];
  asks: RawLevel[];
}

export type OrderBookStatus = 'uninitialized' | 'syncing' | 'live' | 'stale' | 'resyncing';

export interface OrderBookSnapshotView {
  symbol: Symbol;
  status: OrderBookStatus;
  lastUpdateId: number;
  bids: PriceLevel[]; // sorted descending by price
  asks: PriceLevel[]; // sorted ascending by price
  bestBid: PriceLevel | null;
  bestAsk: PriceLevel | null;
  spread: number | null;
  updatedAt: number; // ms epoch of last applied event
}

// ---------------------------------------------------------------------------
// Trades
// ---------------------------------------------------------------------------

/** Raw aggTrade event shape, matches Binance `<symbol>@aggTrade`. */
export interface AggTradeEvent {
  e: 'aggTrade';
  E: number;
  s: string;
  a: number; // agg trade id
  p: string; // price
  q: string; // quantity
  T: number; // trade time
  m: boolean; // true = buyer is market maker (i.e. a sell-initiated/aggressive sell hit the bid)
}

export interface TradeTapeEntry {
  id: number;
  symbol: Symbol;
  price: number;
  qty: number;
  notional: number;
  side: 'buy' | 'sell'; // taker side: 'buy' = aggressive buy (lifted the ask), 'sell' = aggressive sell (hit the bid)
  time: number;
  isLarge: boolean;
}

// ---------------------------------------------------------------------------
// Klines / candles
// ---------------------------------------------------------------------------

export type KlineInterval =
  | '1m' | '3m' | '5m' | '15m' | '30m'
  | '1h' | '2h' | '4h' | '6h' | '12h'
  | '1d' | '3d' | '1w';

export interface KlineEvent {
  e: 'kline';
  E: number;
  s: string;
  k: {
    t: number; // kline open time
    T: number; // kline close time
    i: KlineInterval;
    o: string;
    c: string;
    h: string;
    l: string;
    v: string;
    x: boolean; // is this kline closed?
  };
}

export interface Candle {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closed: boolean;
}

// ---------------------------------------------------------------------------
// Mini ticker (watchlist)
// ---------------------------------------------------------------------------

export interface MiniTickerEvent {
  e: '24hrMiniTicker';
  E: number;
  s: string;
  c: string; // close
  o: string; // open
  h: string;
  l: string;
  v: string; // base volume
  q: string; // quote volume
}

export interface WatchlistRow {
  symbol: Symbol;
  last: number;
  changePct: number;
  high: number;
  low: number;
  quoteVolume: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Stream identity
// ---------------------------------------------------------------------------

export type StreamKind = 'depth' | 'aggTrade' | 'kline' | 'miniTicker' | 'miniTickerAll';

export interface StreamRef {
  kind: StreamKind;
  symbol?: Symbol; // absent for miniTickerAll
  interval?: KlineInterval; // only for kline
}

/** Canonical Binance combined-stream path segment, e.g. "btcusdt@depth@100ms". */
export function streamName(ref: StreamRef): string {
  const sym = ref.symbol?.toLowerCase();
  switch (ref.kind) {
    case 'depth':
      return `${sym}@depth@100ms`;
    case 'aggTrade':
      return `${sym}@aggTrade`;
    case 'kline':
      return `${sym}@kline_${ref.interval}`;
    case 'miniTicker':
      return `${sym}@miniTicker`;
    case 'miniTickerAll':
      return '!miniTicker@arr';
  }
}
