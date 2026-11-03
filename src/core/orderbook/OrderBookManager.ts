import type {
  DepthDiffEvent,
  DepthSnapshot,
  OrderBookSnapshotView,
  OrderBookStatus,
  PriceLevel,
  RawLevel,
} from '../types';

/**
 * Maintains a single symbol's local order book in sync with Binance's
 * partial-book depth diff stream, following Binance's documented
 * "how to manage a local order book" procedure:
 *
 *  1. Buffer diff events while no snapshot has been applied yet.
 *  2. On snapshot: discard buffered events with `u <= lastUpdateId`. The
 *     first remaining event must satisfy `U <= lastUpdateId + 1 <= u`.
 *  3. Apply events in order as long as each event's `U === previous.u + 1`.
 *  4. If a gap is ever detected, mark the book `stale` and surface
 *     `needsResync() === true` without corrupting previously-applied state;
 *     the caller is expected to re-fetch a REST snapshot and call
 *     `applySnapshot` again.
 *
 * Design note: once the book is anything other than `'live'` (i.e.
 * `'uninitialized'` or `'stale'`), every incoming diff is buffered rather
 * than discarded. This matters for the `'stale'` case: the live WebSocket
 * keeps delivering ever-increasing update IDs while we wait for a fresh
 * REST snapshot, and we must not throw those away - otherwise the first
 * diff that arrives *after* the new snapshot would almost certainly look
 * like a fresh gap (its `U` would already be far past the new
 * `lastUpdateId + 1`), producing a stale/resync loop forever. Buffering
 * through the stale period lets `applySnapshot` replay exactly the same
 * discard/straddle/contiguous-replay procedure it uses for the initial
 * sync, which is what actually lets the book recover.
 *
 * Implementation is intentionally framework-agnostic (no network, no DOM)
 * so it can be unit tested in isolation and reused inside the SharedWorker.
 */
export class OrderBookManager {
  private _status: OrderBookStatus = 'uninitialized';
  private _needsResync = false;
  private lastUpdateId = 0;
  private updatedAt = 0;
  private bids = new Map<number, number>(); // price -> qty
  private asks = new Map<number, number>(); // price -> qty
  private buffer: DepthDiffEvent[] = [];
  /**
   * True right after a snapshot that had no buffered diff to replay: the next
   * diff is the first one applied on top of the snapshot, so (per Binance) it
   * only has to straddle `lastUpdateId + 1`, not start exactly there.
   */
  private awaitingFirstDiff = false;

  constructor(public readonly symbol: string) {}

  get status(): OrderBookStatus {
    return this._status;
  }

  /** Buffer or apply a diff event depending on current sync state. */
  applyDiff(evt: DepthDiffEvent): void {
    if (this._status !== 'live') {
      // Not yet synced (uninitialized) or desynced (stale) - buffer until
      // the next applySnapshot can validate/replay against it.
      this.buffer.push(evt);
      return;
    }

    if (evt.u <= this.lastUpdateId) {
      // Old/duplicate event; Binance's guidance is to drop these entirely.
      return;
    }

    const contiguous = this.awaitingFirstDiff ? evt.U <= this.lastUpdateId + 1 : evt.U === this.lastUpdateId + 1;
    this.awaitingFirstDiff = false;
    if (!contiguous) {
      // Gap detected: do not touch book state, just flag for resync and
      // start buffering (this event included) for the eventual replay.
      this._status = 'stale';
      this._needsResync = true;
      this.buffer.push(evt);
      return;
    }

    this.applyLevels(evt);
    this.lastUpdateId = evt.u;
    this.updatedAt = evt.E;
  }

  /** Apply a REST snapshot and replay/validate buffered diffs against it. */
  applySnapshot(snapshot: DepthSnapshot): void {
    this.bids = new Map();
    this.asks = new Map();
    this.applyRawLevels(this.bids, snapshot.bids);
    this.applyRawLevels(this.asks, snapshot.asks);
    this.lastUpdateId = snapshot.lastUpdateId;
    this.updatedAt = Date.now();

    const remaining = this.buffer.filter((d) => d.u > this.lastUpdateId);
    this.buffer = [];
    this.awaitingFirstDiff = false;

    if (remaining.length === 0) {
      this._status = 'live';
      this._needsResync = false;
      this.awaitingFirstDiff = true;
      return;
    }

    const first = remaining[0];
    if (!(first.U <= this.lastUpdateId + 1 && this.lastUpdateId + 1 <= first.u)) {
      // The oldest surviving buffered event doesn't straddle this snapshot's
      // lastUpdateId - we can't safely replay. Keep the snapshot's book
      // state visible, flag for resync, and hold onto the buffer in case a
      // later snapshot can make use of it.
      this._status = 'stale';
      this._needsResync = true;
      this.buffer = remaining;
      return;
    }

    this.applyLevels(first);
    this.lastUpdateId = first.u;
    this.updatedAt = first.E;
    let prev = first;

    for (let i = 1; i < remaining.length; i++) {
      const next = remaining[i];
      if (next.U !== prev.u + 1) {
        this._status = 'stale';
        this._needsResync = true;
        this.buffer = remaining.slice(i);
        return;
      }
      this.applyLevels(next);
      this.lastUpdateId = next.u;
      this.updatedAt = next.E;
      prev = next;
    }

    this._status = 'live';
    this._needsResync = false;
  }

  /** True when the manager has detected a sequence gap and needs a fresh REST snapshot. */
  needsResync(): boolean {
    return this._needsResync;
  }

  getView(): OrderBookSnapshotView {
    const bids = this.sortedLevels(this.bids, 'desc');
    const asks = this.sortedLevels(this.asks, 'asc');
    const bestBid = bids[0] ?? null;
    const bestAsk = asks[0] ?? null;
    const spread = bestBid && bestAsk ? bestAsk.price - bestBid.price : null;
    return {
      symbol: this.symbol,
      status: this._status,
      lastUpdateId: this.lastUpdateId,
      bids,
      asks,
      bestBid,
      bestAsk,
      spread,
      updatedAt: this.updatedAt,
    };
  }

  getTopN(n: number): { bids: PriceLevel[]; asks: PriceLevel[] } {
    const view = this.getView();
    return { bids: view.bids.slice(0, n), asks: view.asks.slice(0, n) };
  }

  private applyLevels(evt: DepthDiffEvent): void {
    this.applyRawLevels(this.bids, evt.b);
    this.applyRawLevels(this.asks, evt.a);
  }

  private applyRawLevels(map: Map<number, number>, levels: RawLevel[]): void {
    for (const [priceStr, qtyStr] of levels) {
      const price = Number(priceStr);
      const qty = Number(qtyStr);
      if (qty === 0) {
        map.delete(price);
      } else {
        map.set(price, qty);
      }
    }
  }

  private sortedLevels(map: Map<number, number>, dir: 'asc' | 'desc'): PriceLevel[] {
    const entries: PriceLevel[] = Array.from(map.entries()).map(([price, qty]) => ({ price, qty }));
    entries.sort((a, b) => (dir === 'desc' ? b.price - a.price : a.price - b.price));
    return entries;
  }
}
