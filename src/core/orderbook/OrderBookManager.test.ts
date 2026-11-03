import { describe, it, expect } from 'vitest';
import { OrderBookManager } from './OrderBookManager';
import type { DepthDiffEvent, DepthSnapshot } from '../types';

function diff(U: number, u: number, b: [string, string][] = [], a: [string, string][] = [], E = u): DepthDiffEvent {
  return { e: 'depthUpdate', E, s: 'BTCUSDT', U, u, b, a };
}

function snapshot(lastUpdateId: number, bids: [string, string][], asks: [string, string][]): DepthSnapshot {
  return { lastUpdateId, bids, asks };
}

describe('OrderBookManager', () => {
  it('starts uninitialized with an empty book', () => {
    const m = new OrderBookManager('BTCUSDT');
    expect(m.status).toBe('uninitialized');
    const view = m.getView();
    expect(view.bids).toEqual([]);
    expect(view.asks).toEqual([]);
    expect(view.bestBid).toBeNull();
    expect(view.bestAsk).toBeNull();
  });

  it('buffers diffs received before any snapshot without throwing or going live', () => {
    const m = new OrderBookManager('BTCUSDT');
    expect(() => m.applyDiff(diff(100, 105))).not.toThrow();
    expect(m.status).not.toBe('live');
  });

  it('goes live from a snapshot with no prior buffered diffs', () => {
    const m = new OrderBookManager('BTCUSDT');
    m.applySnapshot(snapshot(1000, [['100.00', '1.5']], [['101.00', '2.0']]));
    expect(m.status).toBe('live');
    const view = m.getView();
    expect(view.lastUpdateId).toBe(1000);
    expect(view.bestBid).toEqual({ price: 100, qty: 1.5 });
    expect(view.bestAsk).toEqual({ price: 101, qty: 2.0 });
  });

  it('accepts a first live diff that straddles lastUpdateId + 1 when the snapshot arrived before any diff', () => {
    const m = new OrderBookManager('BTCUSDT');
    m.applySnapshot(snapshot(1000, [['100.00', '1.5']], [['101.00', '2.0']]));
    m.applyDiff(diff(995, 1005, [['100.00', '3.0']]));
    expect(m.status).toBe('live');
    expect(m.needsResync()).toBe(false);
    expect(m.getView().bestBid).toEqual({ price: 100, qty: 3.0 });
    // Only the first diff gets the straddle allowance; later ones must be contiguous.
    m.applyDiff(diff(1003, 1008));
    expect(m.status).toBe('stale');
  });

  it('still flags a gap when the first live diff after an empty-buffer snapshot starts past lastUpdateId + 1', () => {
    const m = new OrderBookManager('BTCUSDT');
    m.applySnapshot(snapshot(1000, [['100.00', '1.5']], [['101.00', '2.0']]));
    m.applyDiff(diff(1002, 1005));
    expect(m.status).toBe('stale');
    expect(m.needsResync()).toBe(true);
  });

  it('discards buffered diffs older than the snapshot and applies the straddling + contiguous ones', () => {
    const m = new OrderBookManager('BTCUSDT');
    // stale, fully before snapshot -> discarded
    m.applyDiff(diff(900, 950));
    // straddles lastUpdateId (1000): U <= 1001 <= u
    m.applyDiff(diff(990, 1005, [['100.00', '3.0']]));
    // contiguous follow-up
    m.applyDiff(diff(1006, 1010, [['100.00', '2.0']]));

    m.applySnapshot(snapshot(1000, [['100.00', '1.5']], [['101.00', '2.0']]));

    expect(m.status).toBe('live');
    expect(m.needsResync()).toBe(false);
    const view = m.getView();
    expect(view.lastUpdateId).toBe(1010);
    expect(view.bestBid).toEqual({ price: 100, qty: 2.0 });
  });

  it('flags needsResync when buffered diffs have a gap right after the snapshot, but keeps the snapshot visible', () => {
    const m = new OrderBookManager('BTCUSDT');
    // Gap: this event's U (1010) is way past lastUpdateId+1 (1001)
    m.applyDiff(diff(1010, 1020, [['100.00', '9.0']]));
    m.applySnapshot(snapshot(1000, [['100.00', '1.5']], [['101.00', '2.0']]));

    expect(m.needsResync()).toBe(true);
    expect(m.status).toBe('stale');
    // Book must not be blank/corrupted - traders should still see the last known-good state.
    const view = m.getView();
    expect(view.bestBid).toEqual({ price: 100, qty: 1.5 });
  });

  it('ignores diffs whose final update id is at or before the current lastUpdateId (duplicates/old)', () => {
    const m = new OrderBookManager('BTCUSDT');
    m.applySnapshot(snapshot(1000, [['100.00', '1.5']], [['101.00', '2.0']]));
    m.applyDiff(diff(900, 999, [['100.00', '999']])); // u <= 1000 -> ignored entirely
    const view = m.getView();
    expect(view.lastUpdateId).toBe(1000);
    expect(view.bestBid).toEqual({ price: 100, qty: 1.5 });
  });

  it('applies a contiguous live diff, updating and removing levels', () => {
    const m = new OrderBookManager('BTCUSDT');
    m.applySnapshot(snapshot(1000, [['100.00', '1.5'], ['99.50', '1.0']], [['101.00', '2.0']]));
    m.applyDiff(diff(1001, 1001, [['100.00', '0.00000000'], ['99.00', '5.0']], [['101.00', '3.0']]));

    const view = m.getView();
    expect(view.lastUpdateId).toBe(1001);
    // 100.00 removed (qty 0), 99.00 added
    expect(view.bids.map((l) => l.price)).toEqual([99.5, 99]);
    expect(view.bestAsk).toEqual({ price: 101, qty: 3.0 });
  });

  it('detects a mid-stream gap, marks stale, and does not corrupt the book with the gapped event', () => {
    const m = new OrderBookManager('BTCUSDT');
    m.applySnapshot(snapshot(1000, [['100.00', '1.5']], [['101.00', '2.0']]));
    // U should be 1001 to be contiguous; 1005 is a gap
    m.applyDiff(diff(1005, 1010, [['100.00', '999']]));

    expect(m.status).toBe('stale');
    expect(m.needsResync()).toBe(true);
    const view = m.getView();
    expect(view.lastUpdateId).toBe(1000); // not advanced
    expect(view.bestBid).toEqual({ price: 100, qty: 1.5 }); // not corrupted by the gapped event
  });

  it('recovers from stale back to live after a fresh snapshot is applied', () => {
    const m = new OrderBookManager('BTCUSDT');
    m.applySnapshot(snapshot(1000, [['100.00', '1.5']], [['101.00', '2.0']]));
    m.applyDiff(diff(1005, 1010, [['100.00', '999']])); // induces gap -> stale
    expect(m.status).toBe('stale');

    m.applySnapshot(snapshot(2000, [['105.00', '4.0']], [['106.00', '1.0']]));
    expect(m.status).toBe('live');
    expect(m.needsResync()).toBe(false);
    expect(m.getView().lastUpdateId).toBe(2000);
  });

  it('keeps bids sorted descending and asks ascending regardless of update order', () => {
    const m = new OrderBookManager('BTCUSDT');
    m.applySnapshot(
      snapshot(
        1,
        [['100.00', '1'], ['102.00', '1'], ['101.00', '1']],
        [['110.00', '1'], ['108.00', '1'], ['109.00', '1']],
      ),
    );
    const view = m.getView();
    expect(view.bids.map((l) => l.price)).toEqual([102, 101, 100]);
    expect(view.asks.map((l) => l.price)).toEqual([108, 109, 110]);
  });

  it('computes spread as bestAsk - bestBid, and null when either side is empty', () => {
    const m = new OrderBookManager('BTCUSDT');
    m.applySnapshot(snapshot(1, [['100.00', '1']], [['101.00', '1']]));
    expect(m.getView().spread).toBeCloseTo(1, 10);

    const empty = new OrderBookManager('ETHUSDT');
    empty.applySnapshot(snapshot(1, [], []));
    expect(empty.getView().spread).toBeNull();
    expect(empty.getView().bestBid).toBeNull();
  });

  it('getTopN returns at most N levels per side, preserving sort order', () => {
    const m = new OrderBookManager('BTCUSDT');
    const bids: [string, string][] = Array.from({ length: 10 }, (_, i) => [`${100 - i}.00`, '1']);
    const asks: [string, string][] = Array.from({ length: 10 }, (_, i) => [`${101 + i}.00`, '1']);
    m.applySnapshot(snapshot(1, bids, asks));
    const top = m.getTopN(3);
    expect(top.bids.map((l) => l.price)).toEqual([100, 99, 98]);
    expect(top.asks.map((l) => l.price)).toEqual([101, 102, 103]);
  });

  it('a qty of exactly "0" removes a previously-known ask level', () => {
    const m = new OrderBookManager('BTCUSDT');
    m.applySnapshot(snapshot(1, [['100.00', '1']], [['101.00', '1'], ['102.00', '1']]));
    m.applyDiff(diff(2, 2, [], [['101.00', '0']]));
    expect(m.getView().asks.map((l) => l.price)).toEqual([102]);
  });
});
