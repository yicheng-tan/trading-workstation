/**
 * Message protocol between window clients (main window + pop-outs) and the
 * SharedWorker data hub. Transport-agnostic: works over a MessagePort.
 *
 * Design goals (from PRD):
 *  - Many windows share one Binance connection per host.
 *  - A slow/background window must never block others or build unbounded
 *    backlog -> hub uses latest-state-wins + ack-gated delivery per port.
 *  - Panels show a visible status (live/stale/reconnecting) -> hub pushes
 *    connection + per-symbol-orderbook status explicitly.
 */

import type {
  OrderBookSnapshotView,
  StreamRef,
  TradeTapeEntry,
  Candle,
  KlineInterval,
  WatchlistRow,
} from '../types';

export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';

// ---- Client -> Hub ---------------------------------------------------------

export interface SubscribeMsg {
  type: 'subscribe';
  clientId: string;
  subId: string; // caller-assigned handle to later unsubscribe
  ref: StreamRef;
}

export interface UnsubscribeMsg {
  type: 'unsubscribe';
  clientId: string;
  subId: string;
}

export interface AckMsg {
  type: 'ack';
  clientId: string;
  /** Sequence number of the last `update` batch this client finished rendering. */
  seq: number;
}

export interface HelloMsg {
  type: 'hello';
  clientId: string;
  windowRole: 'main' | 'popout';
}

export interface ByeMsg {
  type: 'bye';
  clientId: string;
}

export type ClientToHubMsg = SubscribeMsg | UnsubscribeMsg | AckMsg | HelloMsg | ByeMsg;

// ---- Hub -> Client ----------------------------------------------------------

export interface ConnectionStatusMsg {
  type: 'connectionStatus';
  status: ConnectionStatus;
  host: 'primary' | 'fallback';
  since: number;
}

export interface OrderBookUpdateMsg {
  type: 'orderBook';
  seq: number;
  book: OrderBookSnapshotView;
}

export interface TradesUpdateMsg {
  type: 'trades';
  seq: number;
  symbol: string;
  trades: TradeTapeEntry[];
}

export interface CandleUpdateMsg {
  type: 'candle';
  seq: number;
  symbol: string;
  /** Disambiguates concurrent subscriptions to different intervals of the same symbol on one port. */
  interval: KlineInterval;
  candle: Candle;
}

export interface WatchlistUpdateMsg {
  type: 'watchlist';
  seq: number;
  rows: WatchlistRow[];
}

export interface HubErrorMsg {
  type: 'error';
  message: string;
  recoverable: boolean;
}

export type HubToClientMsg =
  | ConnectionStatusMsg
  | OrderBookUpdateMsg
  | TradesUpdateMsg
  | CandleUpdateMsg
  | WatchlistUpdateMsg
  | HubErrorMsg;

/** A transport the hub pushes messages through; implemented by a MessagePort wrapper in prod, a fake in tests. */
export interface HubPort {
  readonly clientId: string;
  send(msg: HubToClientMsg): void;
}
