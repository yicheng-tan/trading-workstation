/**
 * Main-thread implementation of `DataHubClient` (see `DataHubClient.ts`,
 * immutable). Opens one `SharedWorker` port - shared with every other
 * window at the same origin, including pop-outs - and layers a typed
 * subscribe/callback API plus automatic ack-on-receive on top of the raw
 * `ClientToHubMsg` / `HubToClientMsg` wire protocol (`protocol.ts`,
 * immutable).
 *
 * `CandleUpdateMsg` carries both `symbol` and `interval`, so concurrent
 * subscriptions to different intervals of the same symbol on one port are
 * correctly disambiguated (streamKey includes the interval below).
 */
import type { DataHubClient } from './DataHubClient';
import type { ClientToHubMsg, ConnectionStatus, HubToClientMsg } from './protocol';
import type {
  Candle,
  KlineInterval,
  OrderBookSnapshotView,
  StreamRef,
  Symbol,
  TradeTapeEntry,
  WatchlistRow,
} from '../types';

type Unsubscribe = () => void;

export function createDataHubClient(windowRole: 'main' | 'popout' = 'main'): DataHubClient {
  const clientId = crypto.randomUUID();

  const worker = new SharedWorker(new URL('../../worker/dataHub.worker.ts', import.meta.url), {
    type: 'module',
    name: 'trading-workstation-data-hub',
  });
  const port = worker.port;

  let connectionStatus: ConnectionStatus = 'connecting';
  const statusListeners = new Set<(status: ConnectionStatus) => void>();

  /** streamKey -> subId -> raw hub message callback. A streamKey can have several subIds (several panels watching the same thing on this port). */
  const callbacksByStreamKey = new Map<string, Map<string, (msg: HubToClientMsg) => void>>();

  function send(msg: ClientToHubMsg): void {
    port.postMessage(msg);
  }

  function streamKeyForRef(ref: StreamRef): string {
    switch (ref.kind) {
      case 'depth':
        return `depth:${ref.symbol}`;
      case 'aggTrade':
        return `trades:${ref.symbol}`;
      case 'kline':
        return `candle:${ref.symbol}:${ref.interval}`;
      case 'miniTicker':
      case 'miniTickerAll':
        return 'watchlist';
    }
  }

  function streamKeyForIncoming(msg: HubToClientMsg): string | null {
    switch (msg.type) {
      case 'orderBook':
        return `depth:${msg.book.symbol}`;
      case 'trades':
        return `trades:${msg.symbol}`;
      case 'candle':
        return `candle:${msg.symbol}:${msg.interval}`;
      case 'watchlist':
        return 'watchlist';
      default:
        return null;
    }
  }

  function registerSubscription(ref: StreamRef, onRaw: (msg: HubToClientMsg) => void): Unsubscribe {
    const subId = crypto.randomUUID();
    const streamKey = streamKeyForRef(ref);
    let bucket = callbacksByStreamKey.get(streamKey);
    if (!bucket) {
      bucket = new Map();
      callbacksByStreamKey.set(streamKey, bucket);
    }
    bucket.set(subId, onRaw);

    send({ type: 'subscribe', clientId, subId, ref });

    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      const b = callbacksByStreamKey.get(streamKey);
      if (b) {
        b.delete(subId);
        if (b.size === 0) callbacksByStreamKey.delete(streamKey);
      }
      send({ type: 'unsubscribe', clientId, subId });
    };
  }

  port.onmessage = (ev: MessageEvent<HubToClientMsg>) => {
    const msg = ev.data;

    if (msg.type === 'connectionStatus') {
      connectionStatus = msg.status;
      for (const listener of statusListeners) listener(msg.status);
      return; // not part of the ack-gated/seq protocol - nothing to ack.
    }

    if (msg.type === 'error') {
      console.error(`[DataHubClient] hub error (${msg.recoverable ? 'recoverable' : 'fatal'}): ${msg.message}`);
      return;
    }

    // msg is now OrderBookUpdateMsg | TradesUpdateMsg | CandleUpdateMsg | WatchlistUpdateMsg - all carry `seq`.
    const streamKey = streamKeyForIncoming(msg);
    const bucket = streamKey ? callbacksByStreamKey.get(streamKey) : undefined;
    if (bucket) {
      for (const cb of bucket.values()) cb(msg);
    }

    // Ack immediately after invoking callback(s) so the hub's
    // PortBackpressureGate is freed for the next update. Heavy rendering
    // work happens later, inside each panel's own requestAnimationFrame
    // loop, decoupled from this ack.
    send({ type: 'ack', clientId, seq: msg.seq });
  };

  send({ type: 'hello', clientId, windowRole });

  const client: DataHubClient = {
    clientId,

    subscribeOrderBook(symbol: Symbol, onUpdate: (book: OrderBookSnapshotView) => void): Unsubscribe {
      return registerSubscription({ kind: 'depth', symbol }, (msg) => {
        if (msg.type === 'orderBook') onUpdate(msg.book);
      });
    },

    subscribeTrades(symbol: Symbol, onUpdate: (trades: TradeTapeEntry[]) => void): Unsubscribe {
      return registerSubscription({ kind: 'aggTrade', symbol }, (msg) => {
        if (msg.type === 'trades') onUpdate(msg.trades);
      });
    },

    subscribeCandles(symbol: Symbol, interval: KlineInterval, onUpdate: (candle: Candle) => void): Unsubscribe {
      return registerSubscription({ kind: 'kline', symbol, interval }, (msg) => {
        if (msg.type === 'candle') onUpdate(msg.candle);
      });
    },

    subscribeWatchlist(onUpdate: (rows: WatchlistRow[]) => void): Unsubscribe {
      return registerSubscription({ kind: 'miniTickerAll' }, (msg) => {
        if (msg.type === 'watchlist') onUpdate(msg.rows);
      });
    },

    onConnectionStatus(cb: (status: ConnectionStatus) => void): Unsubscribe {
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    },

    getConnectionStatus(): ConnectionStatus {
      return connectionStatus;
    },

    setReplayMode(enabled: boolean, speed?: number): void {
      send({ type: 'setReplayMode', clientId, enabled, speed });
    },

    injectFault(kind: 'dropConnection' | 'gap', symbol?: Symbol): void {
      send({ type: 'injectFault', clientId, kind, symbol });
    },

    dispose(): void {
      send({ type: 'bye', clientId });
      port.close();
    },
  };

  return client;
}
