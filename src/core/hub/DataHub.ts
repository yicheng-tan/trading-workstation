/**
 * DataHub - the orchestrator that lives inside the SharedWorker and is the
 * single owner of the one live Binance connection shared by every window
 * (main window + every pop-out) connected to this worker.
 *
 * Ownership:
 *  - One control WebSocket per logical connection, to `wss://<host>/ws`.
 *    We use the raw `/ws` endpoint (not `/stream?streams=...`) and manage
 *    membership dynamically via SUBSCRIBE/UNSUBSCRIBE control frames
 *    (`SubscriptionManager`) so changing symbols/panels never requires a
 *    full socket reconnect. Because `/ws` is used (not `/stream`), inbound
 *    payloads arrive UNWRAPPED (no `{stream, data}` envelope) - we route
 *    purely by the event's own `e` (and `s`) fields.
 *  - One `OrderBookManager` per subscribed symbol (depth).
 *  - One `TapeBuffer` (ring buffer) per subscribed symbol (aggTrade).
 *  - One latest-known `Candle` per subscribed (symbol, interval) (kline).
 *  - One shared `Map<symbol, WatchlistRow>` fed by the single global
 *    `!miniTicker@arr` stream (there is only ever at most one such stream
 *    for the whole hub, regardless of how many watchlist panels exist).
 *  - One `ReconnectPolicy` governing backoff + primary/fallback host choice
 *    + proactive reconnects ahead of Binance's 24h forced disconnect.
 *  - One `PortBackpressureGate` per (port, stream-kind+symbol[+interval])
 *    pair, so a slow/backgrounded window can never build backlog or block
 *    delivery to other windows. The pair is identified by a `gateKey`
 *    string, e.g. `depth:BTCUSDT`, `trades:ETHUSDT`, `candle:BTCUSDT:1m`,
 *    or the single shared `watchlist` key.
 *
 * Design trade-offs / known gaps (please read before extending):
 *
 *  1. Ack <-> gate routing. `protocol.ts`'s `AckMsg` only carries a bare
 *     `{ clientId, seq }` - it has no stream/subId to disambiguate WHICH
 *     gate an ack is for, yet each `PortBackpressureGate` independently
 *     numbers its own sends starting at 1 (by design/tests), so two gates
 *     on the same port can legitimately both be "waiting for ack of seq 1"
 *     at the same time. To avoid any risk of an ack for one stream
 *     spuriously flushing a different stream's gate, every outgoing
 *     message gets a **per-port globally unique "wire seq"** (independent
 *     of each gate's own internal counter), and the hub keeps a
 *     `wireSeq -> { gate, localSeq }` map per port. An incoming ack is
 *     looked up by wire seq and translated into a call to that *specific*
 *     gate's own `ack(localSeq)` - so stale/unknown wire seqs are ignored
 *     and never cross-talk between streams.
 *
 *  2. Reconnect re-subscribe strategy. Rather than trying to replay a
 *     stale `SubscriptionManager`'s pending/active bookkeeping across a
 *     brand new socket, we swap in a **fresh `SubscriptionManager`** on
 *     every successful (re)connect and re-seed it from our own
 *     `streamOwners` map (the hub's source of truth for "who currently
 *     wants this raw Binance stream"). This guarantees every logically-
 *     active stream gets a real SUBSCRIBE frame on the new socket, batched
 *     and rate-limited exactly like any other subscribe burst.
 *
 *  3. Trade tape delivery model. Rather than trying to deliver an
 *     exactly-once log of every individual `aggTrade` through the
 *     ack-gated gate (which is explicitly latest-state-wins, i.e. may
 *     coalesce/drop intermediate pushes for a slow consumer), each push to
 *     a trade-tape gate carries the **current full tape snapshot** (most
 *     recent N trades for that symbol, from a bounded `TapeBuffer`) rather
 *     than "only what changed since last ack". This keeps the semantics
 *     identical to every other stream the hub serves (order book, candle,
 *     watchlist are all "latest full state", not deltas) and means a
 *     backgrounded tape panel simply catches up to the latest N trades
 *     instead of silently losing prints with no way to notice. The
 *     trade-off: a panel that is behind by more than N trades will see a
 *     gap in trade IDs rather than every single print. N is
 *     `TRADE_BUFFER_SIZE` below.
 *
 *  4. Connection status is pushed via a direct `port.send(...)`, bypassing
 *     the backpressure gate entirely - `ConnectionStatusMsg` has no `seq`
 *     field (it isn't part of the ack-gated protocol), and it's an
 *     inherently low-frequency, latest-value-wins signal anyway.
 *
 *  5. Sharding past Binance's 1024-streams-per-connection cap is explicitly
 *     OUT OF SCOPE: the PRD's reference scenario (30 panels / 10 symbols)
 *     needs at most ~41 streams (10 depth + 10 aggTrade + up to ~20 kline
 *     intervals + 1 shared miniTicker-all), nowhere near the cap.
 *     `SubscriptionManager` already enforces the cap defensively
 *     (`subscribe()` returns `false` once truly full), but `DataHub` does
 *     not open a second WebSocket connection to shard across; it simply
 *     accepts the rejection. Multi-connection sharding would be the
 *     natural next step for a workstation that needs hundreds of symbols.
 *
 *  6. REST depth snapshots are retried per symbol with exponential backoff
 *     (`SNAPSHOT_RETRY_BASE_MS` doubling up to `SNAPSHOT_RETRY_MAX_MS`),
 *     driven both by incoming diffs and by `tick()` so a book with no
 *     traffic still recovers. A 429/418 response pauses every snapshot
 *     fetch for `Retry-After` (or a minute). A snapshot that still leaves the
 *     book stale (buffer didn't straddle it) counts as a failed attempt, so a
 *     book that keeps desyncing can't turn into a stream of weight-50 calls.
 *
 *  7. Replay / fault injection. `setReplayMode(true, speed)` fetches our own
 *     bundled recording (`REPLAY_SAMPLE_URL`, made by
 *     `scripts/recordSample.ts` - never an archived Binance dataset): live
 *     depth diffs + trades for a few symbols plus one REST depth snapshot
 *     per symbol, captured exactly as the live sync procedure sees them.
 *     It's fed through `ReplayEngine` at the given speed into the same
 *     `dispatchEvent` routing the live socket uses, and loops until stopped.
 *     Only the recorded symbols switch to replay: their order books and
 *     tapes are reset at the start of every loop and rebuilt from the
 *     recording (live and recorded update ids must never mix in one
 *     `OrderBookManager`), and live depth/trade frames and REST resyncs for
 *     those symbols are suppressed meanwhile. Every other stream stays live,
 *     and the socket stays connected so reconnect/status stay real.
 *     Stopping replay resets those symbols and resyncs them from live data.
 *     `injectFault('dropConnection')` closes the live socket to exercise
 *     `ReconnectPolicy`; `injectFault('gap', symbol)` arms a one-shot
 *     update-id shift on the next `depthUpdate` for that symbol (live or
 *     replayed) to exercise `OrderBookManager`'s gap detection and resync.
 */
import type {
  AggTradeEvent,
  Candle,
  DepthDiffEvent,
  KlineEvent,
  KlineInterval,
  MiniTickerEvent,
  StreamRef,
  Symbol,
  TradeTapeEntry,
  WatchlistRow,
} from '../types';
import { streamName as streamNameFor } from '../types';
import type {
  AckMsg,
  ByeMsg,
  ClientToHubMsg,
  ConnectionStatus,
  HelloMsg,
  HubPort,
  HubToClientMsg,
  SubscribeMsg,
  UnsubscribeMsg,
} from './protocol';
import { OrderBookManager } from '../orderbook/OrderBookManager';
import { SubscriptionManager } from '../connection/SubscriptionManager';
import { ReconnectPolicy, type Host } from '../connection/ReconnectPolicy';
import { PortBackpressureGate } from './PortBackpressureGate';
import { restBaseUrl, wsControlUrl } from './hosts';
import { BinanceRestError, fetchDepthSnapshot, fetchKlines, fetchRecentAggTrades, type FetchFn } from './binanceRest';
import { classifyTrade, TapeBuffer } from '../panels/tradeTape';
import { applyKlineEvent, mergeHistory } from '../panels/candles';
import { applyMiniTicker } from '../panels/watchlist';
import { ReplayEngine, type RecordedEvent } from '../replay/ReplayEngine';
import { injectSequenceGap } from '../replay/faultInjection';

/** Bundled short recording of our own live Binance streams, used for replay/stress testing (never archived Binance datasets). */
const REPLAY_SAMPLE_URL = '/samples/replay-sample.ndjson';
/**
 * Raw shape of one recorded line: the combined-stream envelope exactly as
 * Binance sent it, or a `<symbol>@depthSnapshot` line holding the REST
 * snapshot taken during recording.
 */
interface RecordedEnvelope {
  stream: string;
  data: unknown;
}
interface RecordedDepthSnapshot {
  s: string;
  lastUpdateId: number;
  bids: [string, string][];
  asks: [string, string][];
}

const SNAPSHOT_RETRY_BASE_MS = 1000;
const SNAPSHOT_RETRY_MAX_MS = 30_000;
const RATE_LIMIT_DEFAULT_PAUSE_MS = 60_000;
/** Candles kept per (symbol, interval) for chart history; matches the REST seed size. */
const CANDLE_HISTORY_LIMIT = 500;

/** Most recent N trades kept per symbol, and the size of the snapshot pushed to trade-tape ports (see trade-off #3 above). */
const TRADE_BUFFER_SIZE = 200;
/** Flat USD-notional heuristic for highlighting large prints on the tape. */
const LARGE_TRADE_NOTIONAL_USD = 50_000;
/** How often we attempt to flush batched SUBSCRIBE/UNSUBSCRIBE frames and check for a due proactive reconnect. */
const FLUSH_INTERVAL_MS = 250;

/**
 * Minimal structural subset of the real `WebSocket` we actually use, so
 * `DataHub` depends on this tiny interface rather than the full global
 * `WebSocket`/`WebSocketCtorLike` - keeps the class trivially testable
 * with a fake socket and decoupled from exactly which lib (`dom` vs
 * `webworker`) is in scope for a given tsconfig. The real global
 * `WebSocket` constructor is cast (`as unknown as WebSocketCtorLike`) to
 * this shape in the default option below; the cast is intentional and
 * safe because the real `WebSocket` is a structural superset of this.
 */
interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
}

interface WebSocketCtorLike {
  new (url: string): WebSocketLike;
  readonly OPEN: number;
}

export interface DataHubOptions {
  /** Injectable WebSocket constructor; defaults to the real global `WebSocket` (present on the main thread and inside a SharedWorker). */
  webSocketImpl?: WebSocketCtorLike;
  /** Injectable fetch; defaults to the real global `fetch`. */
  fetchImpl?: FetchFn;
  /** Injectable clock, mainly for future deterministic testing. */
  now?: () => number;
  initialHost?: Host;
}

interface TrackedSubscription {
  clientId: string;
  subId: string;
  ref: StreamRef;
  gateKey: string;
  streamName: string;
}

interface PendingAckEntry {
  gate: PortBackpressureGate<unknown>;
  localSeq: number;
}

export class DataHub {
  private readonly webSocketImpl: WebSocketCtorLike;
  private readonly fetchImpl: FetchFn;
  private readonly now: () => number;

  private ws: WebSocketLike | null = null;
  private host: Host;
  private connStatus: ConnectionStatus = 'connecting';
  private connStatusSince: number;
  private connectedAtMs: number | null = null;

  private subscriptionManager = new SubscriptionManager();
  private readonly reconnectPolicy = new ReconnectPolicy();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // --- Ports ----------------------------------------------------------
  private ports = new Map<string, HubPort>();
  private portGates = new Map<string, Map<string, PortBackpressureGate<unknown>>>();
  private portPendingAcks = new Map<string, Map<number, PendingAckEntry>>();
  private portNextWireSeq = new Map<string, number>();
  /** gateKey -> set of clientId currently interested in it (fan-out / broadcast target list). */
  private listeners = new Map<string, Set<string>>();
  /** clientId -> gateKey -> how many of this port's own subIds reference it. */
  private portGateRefCounts = new Map<string, Map<string, number>>();

  // --- Subscriptions / resources ---------------------------------------
  /** `${clientId}:${subId}` -> bookkeeping needed to clean up on unsubscribe/bye. */
  private subscriptions = new Map<string, TrackedSubscription>();
  /** Binance raw stream name -> set of `${clientId}:${subId}` owner keys currently wanting it. */
  private streamOwners = new Map<string, Set<string>>();
  private streamRefByName = new Map<string, StreamRef>();

  private orderBooks = new Map<Symbol, OrderBookManager>();
  private resyncInFlight = new Set<Symbol>();
  /** Per-symbol snapshot backoff: consecutive failed attempts and the earliest time the next one may start. */
  private snapshotRetry = new Map<Symbol, { attempts: number; notBefore: number }>();
  /** Set from a 429/418 `Retry-After`; no snapshot fetch starts before this. */
  private restPausedUntil = 0;
  private tradeBuffers = new Map<Symbol, TapeBuffer>();
  private candles = new Map<string, Candle>(); // `${symbol}:${interval}` -> latest candle
  private candleHistory = new Map<string, Candle[]>(); // `${symbol}:${interval}` -> oldest-first history
  private watchlistRows = new Map<Symbol, WatchlistRow>();
  private hasConnectedOnce = false;

  // --- Replay / fault injection ----------------------------------------
  private replayEngine: ReplayEngine<RecordedEnvelope> | null = null;
  private replayActive = false;
  /** Symbols currently driven by the recording instead of the live feed. */
  private replaySymbols = new Set<Symbol>();
  private pendingGapSymbol: Symbol | null = null;

  constructor(opts: DataHubOptions = {}) {
    this.webSocketImpl = opts.webSocketImpl ?? (WebSocket as unknown as WebSocketCtorLike);
    // Wrapped, not stored bare: `this.fetchImpl(...)` would call the global
    // fetch with `this === DataHub`, which throws "Illegal invocation".
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? (() => Date.now());
    this.host = opts.initialHost ?? 'primary';
    this.connStatusSince = this.now();

    this.flushTimer = setInterval(() => this.tick(), FLUSH_INTERVAL_MS);
    this.connect();
  }

  // ------------------------------------------------------------------
  // Public surface
  // ------------------------------------------------------------------

  handleClientMessage(port: HubPort, msg: ClientToHubMsg): void {
    switch (msg.type) {
      case 'hello':
        this.handleHello(port, msg);
        break;
      case 'subscribe':
        this.handleSubscribe(port, msg);
        break;
      case 'unsubscribe':
        this.handleUnsubscribe(msg);
        break;
      case 'ack':
        this.handleAck(msg);
        break;
      case 'bye':
        this.handleBye(msg);
        break;
      case 'setReplayMode':
        this.setReplayMode(msg.enabled, msg.speed);
        break;
      case 'injectFault':
        this.injectFault(msg.kind, msg.symbol as Symbol | undefined);
        break;
    }
  }

  /**
   * Enters or exits replay mode (see design note #7 at the top of this
   * file). Fetches our own bundled recording on first enable and loops it
   * through `ReplayEngine` at `speed`; calling again while active only
   * changes the speed.
   */
  setReplayMode(enabled: boolean, speed = 1): void {
    if (!enabled) {
      if (!this.replayActive) return;
      this.replayEngine?.stop();
      this.replayEngine = null;
      this.replayActive = false;
      const symbols = Array.from(this.replaySymbols);
      this.replaySymbols.clear();
      // Back to live: rebuild those books from a fresh live snapshot.
      this.resetReplaySymbols(symbols);
      for (const symbol of symbols) this.requestResync(symbol);
      return;
    }

    this.replayActive = true;
    if (this.replayEngine) {
      this.replayEngine.setSpeed(speed);
      return;
    }

    void this.fetchImpl(REPLAY_SAMPLE_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then((text) => {
        const events: RecordedEvent<RecordedEnvelope>[] = text
          .split('\n')
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as RecordedEvent<RecordedEnvelope>);

        if (events.length === 0 || !this.replayActive || this.replayEngine) return;

        for (const evt of events) {
          const symbol = (evt.payload.data as { s?: string } | null)?.s;
          if (symbol) this.replaySymbols.add(symbol.toUpperCase());
        }
        const engine = new ReplayEngine<RecordedEnvelope>(events, (envelope) => this.dispatchReplayed(envelope), {
          speed,
          onEnd: () => {
            // Loop: every pass starts from a clean book, like a fresh sync.
            this.resetReplaySymbols(Array.from(this.replaySymbols));
            engine.start();
          },
        });
        this.replayEngine = engine;
        this.resetReplaySymbols(Array.from(this.replaySymbols));
        engine.start();
      })
      .catch((err) => {
        console.error('[DataHub] failed to load replay sample:', err);
        this.replayActive = false;
        this.replaySymbols.clear();
      });
  }

  private dispatchReplayed(envelope: RecordedEnvelope): void {
    if (envelope.stream.endsWith('@depthSnapshot')) {
      const snap = envelope.data as RecordedDepthSnapshot;
      const manager = this.orderBooks.get(snap.s);
      if (!manager) return;
      manager.applySnapshot({ lastUpdateId: snap.lastUpdateId, bids: snap.bids, asks: snap.asks });
      this.broadcastOrderBook(snap.s);
      return;
    }
    this.dispatchEvent(envelope.data);
  }

  /** Fresh, unsynced books and empty tapes for `symbols` (keeping every subscriber attached). */
  private resetReplaySymbols(symbols: Symbol[]): void {
    for (const symbol of symbols) {
      if (this.orderBooks.has(symbol)) {
        this.orderBooks.set(symbol, new OrderBookManager(symbol));
        this.snapshotRetry.delete(symbol);
        this.broadcastOrderBook(symbol);
      }
      if (this.tradeBuffers.has(symbol)) {
        this.tradeBuffers.set(symbol, new TapeBuffer(TRADE_BUFFER_SIZE));
        this.broadcastToGateKey(`trades:${symbol}`, [] as TradeTapeEntry[], (trades, seq) => ({ type: 'trades', seq, symbol, trades }));
      }
    }
  }

  private isReplaySymbol(symbol: Symbol): boolean {
    return this.replayActive && this.replaySymbols.has(symbol);
  }

  /** `'dropConnection'` exercises the live reconnect path; `'gap'` arms a one-shot update-id shift on the next depthUpdate for `symbol` (live or replayed) to exercise OrderBookManager's resync path. */
  injectFault(kind: 'dropConnection' | 'gap', symbol?: Symbol): void {
    if (kind === 'dropConnection') {
      this.ws?.close();
      return;
    }
    this.pendingGapSymbol = symbol ?? null;
  }

  dispose(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.flushTimer = null;
    this.reconnectTimer = null;
    this.replayEngine?.stop();
    this.replayEngine = null;
    this.replayActive = false;
    this.replaySymbols.clear();
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.setConnStatus('offline');
  }

  // ------------------------------------------------------------------
  // Client message handlers
  // ------------------------------------------------------------------

  private handleHello(port: HubPort, msg: HelloMsg): void {
    this.ports.set(msg.clientId, port);
    port.send({ type: 'connectionStatus', status: this.connStatus, host: this.host, since: this.connStatusSince });
  }

  private handleSubscribe(port: HubPort, msg: SubscribeMsg): void {
    this.ports.set(msg.clientId, port);
    const subKey = `${msg.clientId}:${msg.subId}`;
    const ref = msg.ref;
    const gateKey = this.gateKeyFor(ref);
    const sName = streamNameFor(ref);

    this.subscriptions.set(subKey, { clientId: msg.clientId, subId: msg.subId, ref, gateKey, streamName: sName });
    this.addListener(gateKey, msg.clientId);
    this.bumpPortGateRefCount(msg.clientId, gateKey, 1);

    switch (ref.kind) {
      case 'depth': {
        const symbol = ref.symbol!;
        const isNew = !this.orderBooks.has(symbol);
        if (isNew) this.orderBooks.set(symbol, new OrderBookManager(symbol));
        this.addStreamOwner(sName, ref, subKey);
        if (isNew) {
          this.requestResync(symbol);
        } else {
          const manager = this.orderBooks.get(symbol)!;
          this.deliverTo(msg.clientId, gateKey, manager.getView(), (book, seq) => ({ type: 'orderBook', seq, book }));
        }
        break;
      }
      case 'aggTrade': {
        const symbol = ref.symbol!;
        const isNew = !this.tradeBuffers.has(symbol);
        if (isNew) this.tradeBuffers.set(symbol, new TapeBuffer(TRADE_BUFFER_SIZE));
        this.addStreamOwner(sName, ref, subKey);
        if (isNew && !this.isReplaySymbol(symbol)) void this.seedTradeTape(symbol);
        const buf = this.tradeBuffers.get(symbol)!;
        if (buf.entries.length > 0) {
          this.deliverTo(msg.clientId, gateKey, buf.entries, (trades, seq) => ({ type: 'trades', seq, symbol, trades }));
        }
        break;
      }
      case 'kline': {
        const symbol = ref.symbol!;
        const interval = ref.interval!;
        const key = `${symbol}:${interval}`;
        const isNew = !this.streamOwners.has(sName);
        this.addStreamOwner(sName, ref, subKey);
        if (isNew) {
          void this.seedCandleHistory(symbol, interval);
        } else {
          const history = this.candleHistory.get(key);
          if (history) this.sendCandleHistory(msg.clientId, symbol, interval, history);
          const candle = this.candles.get(key);
          if (candle) this.deliverTo(msg.clientId, gateKey, candle, (c, seq) => ({ type: 'candle', seq, symbol, interval, candle: c }));
        }
        break;
      }
      case 'miniTicker':
      case 'miniTickerAll': {
        this.addStreamOwner(sName, ref, subKey);
        if (this.watchlistRows.size > 0) {
          this.deliverTo(msg.clientId, gateKey, Array.from(this.watchlistRows.values()), (rows, seq) => ({
            type: 'watchlist',
            seq,
            rows,
          }));
        }
        break;
      }
    }

    this.flushSubscriptions();
  }

  private handleUnsubscribe(msg: UnsubscribeMsg): void {
    const subKey = `${msg.clientId}:${msg.subId}`;
    const sub = this.subscriptions.get(subKey);
    if (!sub) return;
    this.subscriptions.delete(subKey);
    this.bumpPortGateRefCount(msg.clientId, sub.gateKey, -1);
    this.removeStreamOwner(sub.streamName, subKey);
    this.flushSubscriptions();
  }

  private handleAck(msg: AckMsg): void {
    const pendingMap = this.portPendingAcks.get(msg.clientId);
    if (!pendingMap) return;
    const entry = pendingMap.get(msg.seq);
    if (!entry) return; // stale/unknown wire seq - ignore.
    pendingMap.delete(msg.seq);
    entry.gate.ack(entry.localSeq);
  }

  private handleBye(msg: ByeMsg): void {
    for (const subKey of Array.from(this.subscriptions.keys())) {
      if (!subKey.startsWith(`${msg.clientId}:`)) continue;
      const sub = this.subscriptions.get(subKey);
      if (sub) this.handleUnsubscribe({ type: 'unsubscribe', clientId: msg.clientId, subId: sub.subId });
    }
    this.ports.delete(msg.clientId);
    this.portGates.delete(msg.clientId);
    this.portGateRefCounts.delete(msg.clientId);
    this.portPendingAcks.delete(msg.clientId);
    this.portNextWireSeq.delete(msg.clientId);
  }

  // ------------------------------------------------------------------
  // Fan-out bookkeeping
  // ------------------------------------------------------------------

  private gateKeyFor(ref: StreamRef): string {
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

  private addListener(gateKey: string, clientId: string): void {
    let set = this.listeners.get(gateKey);
    if (!set) {
      set = new Set();
      this.listeners.set(gateKey, set);
    }
    set.add(clientId);
  }

  private removeListener(gateKey: string, clientId: string): void {
    const set = this.listeners.get(gateKey);
    if (!set) return;
    set.delete(clientId);
    if (set.size === 0) this.listeners.delete(gateKey);
  }

  private bumpPortGateRefCount(clientId: string, gateKey: string, delta: number): void {
    let m = this.portGateRefCounts.get(clientId);
    if (!m) {
      m = new Map();
      this.portGateRefCounts.set(clientId, m);
    }
    const next = (m.get(gateKey) ?? 0) + delta;
    if (next <= 0) {
      m.delete(gateKey);
      this.removeListener(gateKey, clientId);
      this.portGates.get(clientId)?.delete(gateKey);
    } else {
      m.set(gateKey, next);
    }
  }

  private addStreamOwner(streamName: string, ref: StreamRef, ownerKey: string): void {
    this.streamRefByName.set(streamName, ref);
    let owners = this.streamOwners.get(streamName);
    if (!owners) {
      owners = new Set();
      this.streamOwners.set(streamName, owners);
    }
    owners.add(ownerKey);
    this.subscriptionManager.subscribe(ownerKey, streamName);
  }

  private removeStreamOwner(streamName: string, ownerKey: string): void {
    const owners = this.streamOwners.get(streamName);
    if (!owners) return;
    owners.delete(ownerKey);
    this.subscriptionManager.unsubscribe(ownerKey, streamName);
    if (owners.size === 0) {
      this.streamOwners.delete(streamName);
      this.disposeResourceForStream(streamName);
    }
  }

  private disposeResourceForStream(streamName: string): void {
    const ref = this.streamRefByName.get(streamName);
    this.streamRefByName.delete(streamName);
    if (!ref) return;
    switch (ref.kind) {
      case 'depth':
        this.orderBooks.delete(ref.symbol!);
        this.resyncInFlight.delete(ref.symbol!);
        this.snapshotRetry.delete(ref.symbol!);
        break;
      case 'aggTrade':
        this.tradeBuffers.delete(ref.symbol!);
        break;
      case 'kline':
        this.candles.delete(`${ref.symbol}:${ref.interval}`);
        this.candleHistory.delete(`${ref.symbol}:${ref.interval}`);
        break;
      case 'miniTicker':
      case 'miniTickerAll':
        // Single shared global stream; harmless/cheap to keep cached rows around.
        break;
    }
  }

  // ------------------------------------------------------------------
  // Delivery (ack-gated, per port+stream)
  // ------------------------------------------------------------------

  private deliverTo<T>(
    clientId: string,
    gateKey: string,
    payload: T,
    buildMsg: (payload: T, seq: number) => HubToClientMsg,
  ): void {
    const port = this.ports.get(clientId);
    if (!port) return;

    let gatesForPort = this.portGates.get(clientId);
    if (!gatesForPort) {
      gatesForPort = new Map();
      this.portGates.set(clientId, gatesForPort);
    }
    let gate = gatesForPort.get(gateKey) as PortBackpressureGate<T> | undefined;
    if (!gate) {
      gate = new PortBackpressureGate<T>();
      gatesForPort.set(gateKey, gate as PortBackpressureGate<unknown>);
    }

    gate.push(payload, (p, localSeq) => {
      const wireSeq = this.nextWireSeq(clientId);
      let pendingMap = this.portPendingAcks.get(clientId);
      if (!pendingMap) {
        pendingMap = new Map();
        this.portPendingAcks.set(clientId, pendingMap);
      }
      pendingMap.set(wireSeq, { gate: gate as unknown as PortBackpressureGate<unknown>, localSeq });
      port.send(buildMsg(p, wireSeq));
    });
  }

  private broadcastToGateKey<T>(
    gateKey: string,
    payload: T,
    buildMsg: (payload: T, seq: number) => HubToClientMsg,
  ): void {
    const clientIds = this.listeners.get(gateKey);
    if (!clientIds || clientIds.size === 0) return;
    for (const clientId of clientIds) this.deliverTo(clientId, gateKey, payload, buildMsg);
  }

  private nextWireSeq(clientId: string): number {
    const next = (this.portNextWireSeq.get(clientId) ?? 0) + 1;
    this.portNextWireSeq.set(clientId, next);
    return next;
  }

  // ------------------------------------------------------------------
  // REST sync helpers
  // ------------------------------------------------------------------

  /** Starts a depth snapshot fetch for `symbol` unless one is in flight, it's backing off, REST is rate-limited, or the symbol is being replayed. */
  private requestResync(symbol: Symbol): void {
    if (this.isReplaySymbol(symbol) || this.resyncInFlight.has(symbol)) return;
    const now = this.now();
    if (now < this.restPausedUntil) return;
    const retry = this.snapshotRetry.get(symbol);
    if (retry && now < retry.notBefore) return;
    void this.syncOrderBook(symbol);
  }

  private async syncOrderBook(symbol: Symbol): Promise<void> {
    this.resyncInFlight.add(symbol);
    try {
      const snapshot = await fetchDepthSnapshot(restBaseUrl(this.host), symbol, { fetchFn: this.fetchImpl });
      const manager = this.orderBooks.get(symbol);
      if (!manager || this.isReplaySymbol(symbol)) return; // unsubscribed / switched to replay meanwhile.
      manager.applySnapshot(snapshot);
      if (manager.status === 'live') this.snapshotRetry.delete(symbol);
      else this.noteSnapshotFailure(symbol);
      this.broadcastOrderBook(symbol);
    } catch (err) {
      if (err instanceof BinanceRestError && err.isRateLimited) {
        this.restPausedUntil = Math.max(this.restPausedUntil, this.now() + (err.retryAfterMs ?? RATE_LIMIT_DEFAULT_PAUSE_MS));
      }
      this.noteSnapshotFailure(symbol);
      console.error(`[DataHub] failed to fetch depth snapshot for ${symbol}:`, err);
    } finally {
      this.resyncInFlight.delete(symbol);
    }
  }

  private noteSnapshotFailure(symbol: Symbol): void {
    const attempts = (this.snapshotRetry.get(symbol)?.attempts ?? 0) + 1;
    const delayMs = Math.min(SNAPSHOT_RETRY_MAX_MS, SNAPSHOT_RETRY_BASE_MS * 2 ** (attempts - 1));
    this.snapshotRetry.set(symbol, { attempts, notBefore: this.now() + delayMs });
  }

  private broadcastOrderBook(symbol: Symbol): void {
    const manager = this.orderBooks.get(symbol);
    if (!manager) return;
    this.broadcastToGateKey(`depth:${symbol}`, manager.getView(), (book, seq) => ({ type: 'orderBook', seq, book }));
  }

  private async seedCandleHistory(symbol: Symbol, interval: KlineInterval): Promise<void> {
    const key = `${symbol}:${interval}`;
    try {
      const fetched = await fetchKlines(restBaseUrl(this.host), symbol, interval, { fetchFn: this.fetchImpl });
      if (!this.streamOwners.has(streamNameFor({ kind: 'kline', symbol, interval }))) return; // unsubscribed meanwhile
      let history = fetched.slice(-CANDLE_HISTORY_LIMIT);
      // A live kline may already have arrived while REST was in flight; it's newer than the REST bar.
      const live = this.candles.get(key);
      const last = history[history.length - 1];
      if (live && (!last || live.openTime >= last.openTime)) history = mergeHistory(history, live);
      if (history.length === 0) return;
      this.candleHistory.set(key, history);
      this.candles.set(key, history[history.length - 1]);
      for (const clientId of this.listeners.get(`candle:${key}`) ?? []) {
        this.sendCandleHistory(clientId, symbol, interval, history);
      }
    } catch (err) {
      console.error(`[DataHub] failed to fetch kline history for ${symbol} ${interval}:`, err);
    }
  }

  /**
   * Fills a new tape with the latest REST prints so a quiet symbol isn't
   * blank until its next trade. Live prints that arrived meanwhile are kept
   * and win over REST duplicates (same aggregate-trade id).
   */
  private async seedTradeTape(symbol: Symbol): Promise<void> {
    const buffer = this.tradeBuffers.get(symbol);
    try {
      const events = await fetchRecentAggTrades(restBaseUrl(this.host), symbol, TRADE_BUFFER_SIZE, { fetchFn: this.fetchImpl });
      // Unsubscribed, reset for replay, or replaced meanwhile: this backfill no longer applies.
      if (!buffer || this.tradeBuffers.get(symbol) !== buffer || this.isReplaySymbol(symbol)) return;
      const live = buffer.entries;
      const oldestLiveId = live.length > 0 ? live[live.length - 1].id : Infinity;
      const seeded = new TapeBuffer(TRADE_BUFFER_SIZE);
      for (const evt of events) if (evt.a < oldestLiveId) seeded.push(classifyTrade(evt, LARGE_TRADE_NOTIONAL_USD));
      for (let i = live.length - 1; i >= 0; i--) seeded.push(live[i]);
      this.tradeBuffers.set(symbol, seeded);
      this.broadcastToGateKey(`trades:${symbol}`, seeded.entries, (trades, seq) => ({ type: 'trades', seq, symbol, trades }));
    } catch (err) {
      console.error(`[DataHub] failed to fetch recent trades for ${symbol}:`, err);
    }
  }

  /** History is a one-off bulk payload, so it bypasses the latest-state-wins gate (which would let a live candle overwrite it). */
  private sendCandleHistory(clientId: string, symbol: Symbol, interval: KlineInterval, candles: Candle[]): void {
    this.ports.get(clientId)?.send({ type: 'candleHistory', symbol, interval, candles });
  }

  // ------------------------------------------------------------------
  // WebSocket lifecycle
  // ------------------------------------------------------------------

  private connect(): void {
    let socket: WebSocketLike;
    try {
      socket = new this.webSocketImpl(wsControlUrl(this.host));
    } catch (err) {
      console.error('[DataHub] failed to construct WebSocket:', err);
      this.handleConnectionFailure();
      return;
    }
    this.ws = socket;
    socket.onopen = () => this.onSocketOpen();
    socket.onmessage = (ev: { data: unknown }) => {
      const data = ev.data;
      this.handleSocketMessage(typeof data === 'string' ? data : String(data));
    };
    socket.onerror = () => {
      /* onclose always follows onerror for browser/worker WebSocket; nothing extra to do here. */
    };
    socket.onclose = () => this.onSocketClose();
  }

  private onSocketOpen(): void {
    const now = this.now();
    this.connectedAtMs = now;
    this.reconnectPolicy.recordConnected(now);
    this.setConnStatus('live');

    // Fresh SubscriptionManager so every currently-wanted stream is treated as
    // newly-needed again and gets a SUBSCRIBE frame batched onto this new
    // socket (see trade-off #2 at the top of this file).
    this.subscriptionManager = new SubscriptionManager();
    for (const [sName, owners] of this.streamOwners) {
      for (const ownerKey of owners) this.subscriptionManager.subscribe(ownerKey, sName);
    }
    this.flushSubscriptions();

    // Binance requires a fresh REST snapshot after any disconnect/reconnect.
    this.snapshotRetry.clear();
    for (const symbol of this.orderBooks.keys()) this.requestResync(symbol);

    // Klines missed while disconnected would leave holes in the charts.
    if (this.hasConnectedOnce) {
      for (const ref of this.streamRefByName.values()) {
        if (ref.kind === 'kline') void this.seedCandleHistory(ref.symbol!, ref.interval!);
      }
    }
    this.hasConnectedOnce = true;
  }

  private onSocketClose(): void {
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
    }
    this.ws = null;
    this.handleConnectionFailure();
  }

  private handleConnectionFailure(): void {
    const now = this.now();
    if (this.connectedAtMs !== null) {
      this.reconnectPolicy.recordDisconnected(now);
    }
    this.connectedAtMs = null;
    this.setConnStatus('reconnecting');

    const decision = this.reconnectPolicy.recordFailure(this.host);
    this.host = decision.nextHost;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), decision.delayMs);
  }

  private proactiveReconnect(): void {
    console.info('[DataHub] proactively reconnecting ahead of Binance\u2019s 24h forced-disconnect window.');
    this.reconnectPolicy.reset();
    this.host = 'primary';
    this.ws?.close();
    // onSocketClose -> handleConnectionFailure will schedule the actual reconnect at base delay.
  }

  private tick(): void {
    this.flushSubscriptions();
    if (this.connectedAtMs !== null && this.reconnectPolicy.shouldProactivelyReconnect(this.now(), this.connectedAtMs)) {
      this.proactiveReconnect();
    }
    // Retry books whose snapshot failed or didn't line up, even if no diffs arrive to trigger it.
    if (this.connectedAtMs !== null) {
      for (const [symbol, manager] of this.orderBooks) {
        if (manager.status !== 'live') this.requestResync(symbol);
      }
    }
  }

  private flushSubscriptions(): void {
    if (!this.ws || this.ws.readyState !== this.webSocketImpl.OPEN) return;
    const frames = this.subscriptionManager.flush();
    for (const frame of frames) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  private setConnStatus(status: ConnectionStatus): void {
    if (this.connStatus === status) return;
    this.connStatus = status;
    this.connStatusSince = this.now();
    const msg: HubToClientMsg = { type: 'connectionStatus', status, host: this.host, since: this.connStatusSince };
    for (const port of this.ports.values()) port.send(msg);
  }

  // ------------------------------------------------------------------
  // Inbound WebSocket message routing (by `e` field - see header comment)
  // ------------------------------------------------------------------

  private handleSocketMessage(raw: string): void {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    // Live book/tape frames for replayed symbols are dropped (design note #7).
    if (this.replayActive && typeof data === 'object' && data !== null && 's' in data) {
      const evt = data as { e?: string; s: string };
      if ((evt.e === 'depthUpdate' || evt.e === 'aggTrade') && this.replaySymbols.has(evt.s)) return;
    }
    this.dispatchEvent(data);
  }

  /** Shared routing for both the live socket (via `handleSocketMessage`) and `ReplayEngine` playback. */
  private dispatchEvent(data: unknown): void {
    if (Array.isArray(data)) {
      this.handleMiniTickerArray(data as MiniTickerEvent[]);
      return;
    }
    if (typeof data !== 'object' || data === null || !('e' in data)) {
      // SUBSCRIBE/UNSUBSCRIBE control-frame ack (`{ result, id }`) or unrecognized payload.
      return;
    }

    const evt = data as { e: string };
    switch (evt.e) {
      case 'depthUpdate':
        this.handleDepthUpdate(data as DepthDiffEvent);
        break;
      case 'aggTrade':
        this.handleAggTrade(data as AggTradeEvent);
        break;
      case 'kline':
        this.handleKline(data as KlineEvent);
        break;
      case '24hrMiniTicker':
        this.handleMiniTickerArray([data as MiniTickerEvent]);
        break;
      default:
        break;
    }
  }

  private handleDepthUpdate(evt: DepthDiffEvent): void {
    const manager = this.orderBooks.get(evt.s);
    if (!manager) return;
    if (this.pendingGapSymbol === evt.s) {
      this.pendingGapSymbol = null;
      evt = injectSequenceGap(evt);
    }
    manager.applyDiff(evt);
    if (manager.needsResync()) {
      this.requestResync(evt.s);
    }
    this.broadcastOrderBook(evt.s);
  }

  private handleAggTrade(evt: AggTradeEvent): void {
    const buffer = this.tradeBuffers.get(evt.s);
    if (!buffer) return;
    const entry = classifyTrade(evt, LARGE_TRADE_NOTIONAL_USD);
    buffer.push(entry);
    this.broadcastToGateKey(`trades:${evt.s}`, buffer.entries, (trades, seq) => ({
      type: 'trades',
      seq,
      symbol: evt.s,
      trades,
    }));
  }

  private handleKline(evt: KlineEvent): void {
    const key = `${evt.s}:${evt.k.i}`;
    if (!this.candles.has(key) && !this.streamOwners.has(streamNameFor({ kind: 'kline', symbol: evt.s, interval: evt.k.i }))) {
      return;
    }
    const candle = applyKlineEvent(this.candles.get(key) ?? null, evt);
    this.candles.set(key, candle);
    const history = this.candleHistory.get(key);
    const last = history?.[history.length - 1];
    if (history && last) {
      if (candle.openTime === last.openTime) {
        history[history.length - 1] = candle;
      } else if (candle.openTime > last.openTime) {
        history.push(candle);
        if (history.length > CANDLE_HISTORY_LIMIT) history.shift();
      }
    }
    this.broadcastToGateKey(`candle:${evt.s}:${evt.k.i}`, candle, (c, seq) => ({
      type: 'candle',
      seq,
      symbol: evt.s,
      interval: evt.k.i,
      candle: c,
    }));
  }

  private handleMiniTickerArray(events: MiniTickerEvent[]): void {
    for (const evt of events) {
      this.watchlistRows.set(evt.s, applyMiniTicker(evt));
    }
    if ((this.listeners.get('watchlist')?.size ?? 0) > 0) {
      this.broadcastToGateKey('watchlist', Array.from(this.watchlistRows.values()), (rows, seq) => ({
        type: 'watchlist',
        seq,
        rows,
      }));
    }
  }
}
