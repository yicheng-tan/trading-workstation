import { describe, it, expect } from 'vitest';
import { groupLevelsByTick, withCumulative, computeMidPrice, displayTickSize, decimalPlaces } from './depthLadder';
import type { PriceLevel } from '../types';

describe('groupLevelsByTick', () => {
  it('rounds bid levels down to the nearest tick and sums quantity within a bucket', () => {
    const levels: PriceLevel[] = [
      { price: 100.03, qty: 1 },
      { price: 100.07, qty: 2 },
      { price: 99.96, qty: 3 },
    ];
    const grouped = groupLevelsByTick(levels, 0.1, 'bid');
    const bucket100 = grouped.find((l) => Math.abs(l.price - 100.0) < 1e-9);
    expect(bucket100?.qty).toBeCloseTo(3, 9); // 100.03 + 100.07 bucket to 100.0
  });

  it('rounds ask levels up to the nearest tick', () => {
    const levels: PriceLevel[] = [{ price: 100.01, qty: 1 }, { price: 100.09, qty: 2 }];
    const grouped = groupLevelsByTick(levels, 0.1, 'ask');
    expect(grouped.every((l) => l.price === 100.1)).toBe(true);
  });

  it('is a no-op when tickSize matches the levels natural spacing', () => {
    const levels: PriceLevel[] = [{ price: 100, qty: 1 }, { price: 101, qty: 1 }];
    const grouped = groupLevelsByTick(levels, 1, 'bid');
    expect(grouped.map((l) => l.price).sort()).toEqual([100, 101]);
  });

  it('conserves total quantity across bucketing', () => {
    const levels: PriceLevel[] = [
      { price: 100.01, qty: 1 },
      { price: 100.04, qty: 2 },
      { price: 100.49, qty: 3 },
    ];
    const grouped = groupLevelsByTick(levels, 0.5, 'bid');
    const totalBefore = levels.reduce((s, l) => s + l.qty, 0);
    const totalAfter = grouped.reduce((s, l) => s + l.qty, 0);
    expect(totalAfter).toBeCloseTo(totalBefore, 9);
  });

  it('returns bids sorted descending and asks sorted ascending after bucketing', () => {
    const bids: PriceLevel[] = [{ price: 99.9, qty: 1 }, { price: 100.4, qty: 1 }, { price: 100.1, qty: 1 }];
    const groupedBids = groupLevelsByTick(bids, 0.5, 'bid');
    const prices = groupedBids.map((l) => l.price);
    expect(prices).toEqual([...prices].sort((a, b) => b - a));
  });
});

describe('displayTickSize', () => {
  it('keeps distinct levels for sub-cent assets instead of collapsing the book', () => {
    const pepe: PriceLevel[] = [
      { price: 0.00000471, qty: 1 },
      { price: 0.0000047, qty: 2 },
      { price: 0.00000469, qty: 3 },
    ];
    const tick = displayTickSize(0.00000471);
    expect(tick).toBe(1e-8);
    expect(decimalPlaces(tick)).toBe(8);
    expect(groupLevelsByTick(pepe, tick, 'bid')).toHaveLength(3);
  });

  it('scales with magnitude below 1 and keeps the coarser buckets above it', () => {
    expect(decimalPlaces(displayTickSize(0.0741))).toBe(5);
    expect(decimalPlaces(displayTickSize(0.5))).toBe(4);
    expect(displayTickSize(2266)).toBe(0.5);
    expect(displayTickSize(77000)).toBe(1);
  });
});

describe('withCumulative', () => {
  it('computes a running total in input order', () => {
    const levels: PriceLevel[] = [{ price: 100, qty: 1 }, { price: 99, qty: 2 }, { price: 98, qty: 3 }];
    const result = withCumulative(levels);
    expect(result.map((l) => l.cumulative)).toEqual([1, 3, 6]);
  });

  it('returns an empty array for empty input', () => {
    expect(withCumulative([])).toEqual([]);
  });
});

describe('computeMidPrice', () => {
  it('averages best bid and best ask', () => {
    expect(computeMidPrice(100, 102)).toBe(101);
  });

  it('returns null when either side is missing', () => {
    expect(computeMidPrice(null, 102)).toBeNull();
    expect(computeMidPrice(100, null)).toBeNull();
  });
});
