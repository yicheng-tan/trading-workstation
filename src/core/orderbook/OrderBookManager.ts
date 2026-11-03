import type {
  DepthDiffEvent,
  DepthSnapshot,
  OrderBookSnapshotView,
  OrderBookStatus,
  PriceLevel,
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
 * Implementation is intentionally framework-agnostic (no network, no DOM)
 * so it can be unit tested in isolation and reused inside the SharedWorker.
 */
export class OrderBookManager {
  constructor(public readonly symbol: string) {
    throw new Error('not implemented');
  }

  get status(): OrderBookStatus {
    throw new Error('not implemented');
  }

  /** Buffer or apply a diff event depending on current sync state. */
  applyDiff(_evt: DepthDiffEvent): void {
    throw new Error('not implemented');
  }

  /** Apply a REST snapshot and replay/validate buffered diffs against it. */
  applySnapshot(_snapshot: DepthSnapshot): void {
    throw new Error('not implemented');
  }

  /** True when the manager has detected a sequence gap and needs a fresh REST snapshot. */
  needsResync(): boolean {
    throw new Error('not implemented');
  }

  getView(): OrderBookSnapshotView {
    throw new Error('not implemented');
  }

  getTopN(_n: number): { bids: PriceLevel[]; asks: PriceLevel[] } {
    throw new Error('not implemented');
  }
}
