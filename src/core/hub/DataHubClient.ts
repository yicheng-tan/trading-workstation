/**
 * Main-thread facade over the SharedWorker data hub. Panels and the
 * workspace shell depend ONLY on this interface (never on SharedWorker/
 * MessagePort directly), so they can be built against a stable contract
 * while the concrete implementation (createDataHubClient, in
 * createDataHubClient.ts) is developed independently.
 *
 * Every subscribe* method returns an unsubscribe function. Multiple panels
 * subscribing to the same symbol/stream must be deduplicated upstream in
 * the hub (ref-counted) - callers do not need to worry about that here.
 */
import type { ConnectionStatus } from './protocol';
import type {
  OrderBookSnapshotView,
  TradeTapeEntry,
  Candle,
  WatchlistRow,
  KlineInterval,
  Symbol,
} from '../types';

export interface DataHubClient {
  readonly clientId: string;

  subscribeOrderBook(symbol: Symbol, onUpdate: (book: OrderBookSnapshotView) => void): () => void;
  subscribeTrades(symbol: Symbol, onUpdate: (trades: TradeTapeEntry[]) => void): () => void;
  subscribeCandles(
    symbol: Symbol,
    interval: KlineInterval,
    onUpdate: (candle: Candle) => void,
  ): () => void;
  /** Single shared `!miniTicker@arr` stream, filtered/sorted client-side. */
  subscribeWatchlist(onUpdate: (rows: WatchlistRow[]) => void): () => void;

  onConnectionStatus(cb: (status: ConnectionStatus) => void): () => void;
  getConnectionStatus(): ConnectionStatus;

  /** Switches the hub into (or out of) replay mode, feeding recorded samples instead of live Binance data. */
  setReplayMode(enabled: boolean, speed?: number): void;
  /** Stress-testing hooks surfaced in the UI; no-ops when not in replay mode. */
  injectFault(kind: 'dropConnection' | 'gap', symbol?: Symbol): void;

  dispose(): void;
}
